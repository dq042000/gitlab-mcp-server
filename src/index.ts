import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import express from "express";
import axios from "axios";
import { z } from "zod";
import * as dotenv from "dotenv";
import { randomUUID } from "crypto";

dotenv.config();

const GITLAB_API = process.env.GITLAB_API;
const GROUP_TOKEN = process.env.GITLAB_GROUP_TOKEN;
const PLATFORM_GROUP_ID = process.env.PLATFORM_GROUP_ID;
const PORT = Number(process.env.PORT) || 4321;
const URL = process.env.URL || "";

if (!GITLAB_API || !GROUP_TOKEN || !PLATFORM_GROUP_ID || !URL) {
  console.error("❌ 缺少環境變數");
  process.exit(1);
}

// --- 每次連線建立一個新的 McpServer 實例，避免 "Already connected to a transport" 錯誤 ---
function createMcpServer() {
  const server = new McpServer({
    name: "GitLab-Platform-Assistant",
    version: "1.0.0",
  });

  server.tool("list_platform_projects", "列出平台群組專案", {}, async () => {
    try {
      const perPage = 100;
      let page = 1;
      const projects: Array<any> = [];

      while (true) {
        const url = `${GITLAB_API}/groups/${PLATFORM_GROUP_ID}/projects?include_subgroups=true&per_page=${perPage}&page=${page}&simple=true&order_by=last_activity_at`;
        const response = await axios.get(url, { headers: { "PRIVATE-TOKEN": GROUP_TOKEN } });
        const data = Array.isArray(response.data) ? response.data : [];

        for (const p of data) {
          projects.push({ id: p.id, name: p.name, description: p.description, path: p.path_with_namespace });
        }

        // 使用 x-total-pages 作為主要分頁判斷（比 x-next-page 更可靠）
        const totalPages = Number(response.headers["x-total-pages"] ?? "1");
        const total = response.headers["x-total"] ?? "?";
        console.log(`[list_platform_projects] page ${page}/${totalPages}, x-total: ${total}, this page: ${data.length}, accumulated: ${projects.length}`);

        if (page >= totalPages || data.length === 0) {
          break;
        }
        page++;
      }

      if (projects.length === 0) {
        console.warn(`[list_platform_projects] empty result after pagination`);
      } else {
        console.log(`[list_platform_projects] fetched ${projects.length} projects across pages`);
      }

      return { content: [{ type: "text", text: JSON.stringify(projects, null, 2) }] };
    } catch (error: any) {
      const status = error.response?.status;
      const body = error.response?.data;
      console.error(`[list_platform_projects] failed`, { status, body, message: error.message });
      return {
        content: [{
          type: "text",
          text: `讀取失敗: ${error.message}${status ? ` (status ${status})` : ""}${body ? ` => ${JSON.stringify(body)}` : ""}`,
        }],
        isError: true,
      };
    }
  });

  server.tool("read_project_file", "讀取 GitLab 專案檔案", {
    projectId: z.string().describe("GitLab Project ID"),
    filePath: z.string().describe("檔案完整路徑"),
    ref: z.string().default("main").describe("分支名稱"),
  }, async ({ projectId, filePath, ref }) => {
    // projectId 可能為 "group/project" 路徑，需整體 URL 編碼
    const encodedProjectId = encodeURIComponent(projectId);
    // filePath 使用雙重編碼確保 GitLab API 正確解析
    const encodedFilePath = encodeURIComponent(filePath);

    const tryFetch = async (branch: string) => {
      const url = `${GITLAB_API}/projects/${encodedProjectId}/repository/files/${encodedFilePath}/raw?ref=${encodeURIComponent(branch)}`;
      console.log(`[read_project_file] GET ${url}`);
      return axios.get(url, { headers: { "PRIVATE-TOKEN": GROUP_TOKEN } });
    };

    // 依序嘗試：指定 ref → main → master → production
    const fallbackBranches = ["main", "master", "production"];
    const tryOrder = [ref, ...fallbackBranches.filter((b) => b !== ref)];

    for (const branch of tryOrder) {
      try {
        const response = await tryFetch(branch);
        if (branch !== ref) {
          console.warn(`[read_project_file] 使用 fallback branch "${branch}" 成功`);
        }
        return { content: [{ type: "text", text: String(response.data) }] };
      } catch (error: any) {
        const status = error.response?.status;
        if (status === 404) {
          console.warn(`[read_project_file] branch "${branch}" 404，嘗試下一個`);
          continue;
        }
        // 非 404 錯誤直接回傳
        const body = error.response?.data;
        console.error(`[read_project_file] failed`, { status, body, projectId, filePath, branch });
        return {
          content: [{
            type: "text",
            text: `讀取失敗：projectId=${projectId}, filePath=${filePath}, ref=${branch}\n${status ? `status: ${status}\n` : ""}${body ? `response: ${JSON.stringify(body)}` : error.message}`,
          }],
          isError: true,
        };
      }
    }

    // 所有 branch 皆 404
    console.error(`[read_project_file] 所有 branch 皆 404`, { projectId, filePath, tryOrder });
    return {
      content: [{
        type: "text",
        text: `讀取失敗：projectId=${projectId}, filePath=${filePath}\n所有分支（${tryOrder.join(", ")}）皆回傳 404，請確認 projectId 與 filePath 是否正確。`,
      }],
      isError: true,
    };
  });

  return server;
}

// --- Express 邏輯 ---
const app = express();
app.use(express.json());

// ── Streamable HTTP Transport（新版協議，供現代 MCP 客戶端使用）───────────────
const streamableTransports = new Map<string, StreamableHTTPServerTransport>();

app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  let transport = sessionId ? streamableTransports.get(sessionId) : undefined;

  if (transport) {
    // 已存在的 session：直接轉發請求
    console.log(`[${new Date().toLocaleTimeString()}] [Streamable] 既有 session: ${sessionId}`);
    await transport.handleRequest(req, res, req.body);
    return;
  }

  if (!isInitializeRequest(req.body)) {
    res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: 非 initialize 請求且無有效 session" }, id: null });
    return;
  }

  // 新 session：建立 Streamable HTTP Transport
  transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sid) => {
      streamableTransports.set(sid, transport!);
      console.log(`[${new Date().toLocaleTimeString()}] ✅ [Streamable] session 建立: ${sid}`);
    },
  });

  transport.onclose = () => {
    if (transport!.sessionId) {
      streamableTransports.delete(transport!.sessionId);
      console.log(`[${new Date().toLocaleTimeString()}] 🔌 [Streamable] session 關閉: ${transport!.sessionId}`);
    }
  };

  const mcpServer = createMcpServer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await mcpServer.connect(transport as any);
  await transport.handleRequest(req, res, req.body);
});

app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  const transport = sessionId ? streamableTransports.get(sessionId) : undefined;
  if (!transport) {
    res.status(404).send("Session not found");
    return;
  }
  await transport.handleRequest(req, res);
});

app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  const transport = sessionId ? streamableTransports.get(sessionId) : undefined;
  if (!transport) {
    res.status(404).send("Session not found");
    return;
  }
  await transport.handleRequest(req, res);
});


app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 GitLab MCP Server 已啟動`);
  console.log(`   Streamable HTTP : ${URL}:${PORT}/mcp`);
});