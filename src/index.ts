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

  server.tool(
    "list_platform_projects", 
    "列出平台群組專案。💡 這是探索專案的第一步，取得所有專案清單後可搭配其他工具深入查詢。", 
    {}, 
    async () => {
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

  server.tool(
    "search_projects_by_file", 
    "搜尋包含特定檔案的專案。適合知道確切檔案路徑時使用。", 
    {
      filePath: z.string().describe("要搜尋的檔案路徑，例如：web/api/config/autoload/pay.local.php.dist"),
      maxProjects: z.number().optional().describe("最多檢查的專案數量（預設 50，避免超時）"),
    }, 
    async ({ filePath, maxProjects = 50 }) => {
    console.log(`[search_projects_by_file] 搜尋包含檔案 "${filePath}" 的專案（最多檢查 ${maxProjects} 個）`);
    
    try {
      // 先取得專案列表
      const projectsUrl = `${GITLAB_API}/groups/${PLATFORM_GROUP_ID}/projects?include_subgroups=true&per_page=100&order_by=last_activity_at`;
      const projectsResponse = await axios.get(projectsUrl, { headers: { "PRIVATE-TOKEN": GROUP_TOKEN } });
      const allProjects = Array.isArray(projectsResponse.data) ? projectsResponse.data : [];
      
      console.log(`[search_projects_by_file] 找到 ${allProjects.length} 個專案，將檢查前 ${Math.min(maxProjects, allProjects.length)} 個`);
      
      const matchedProjects: Array<{ id: number; name: string; path: string; branch: string }> = [];
      const projectsToCheck = allProjects.slice(0, maxProjects);
      
      // 逐一檢查專案
      for (const project of projectsToCheck) {
        const encodedProjectId = encodeURIComponent(project.id);
        const encodedFilePath = encodeURIComponent(filePath);
        
        try {
          // 先嘗試預設分支
          const defaultBranch = project.default_branch || "main";
          const fileUrl = `${GITLAB_API}/projects/${encodedProjectId}/repository/files/${encodedFilePath}?ref=${encodeURIComponent(defaultBranch)}`;
          
          await axios.head(fileUrl, { headers: { "PRIVATE-TOKEN": GROUP_TOKEN } });
          matchedProjects.push({
            id: project.id,
            name: project.name,
            path: project.path_with_namespace,
            branch: defaultBranch,
          });
          console.log(`[search_projects_by_file] ✓ 找到：${project.path_with_namespace} (${defaultBranch})`);
        } catch (error: any) {
          // 檔案不存在於預設分支，繼續下一個專案
          if (error.response?.status === 404) {
            continue;
          }
        }
      }
      
      console.log(`[search_projects_by_file] 完成！找到 ${matchedProjects.length} 個包含該檔案的專案`);
      
      if (matchedProjects.length === 0) {
        return {
          content: [{
            type: "text",
            text: `未找到包含檔案 "${filePath}" 的專案（已檢查 ${projectsToCheck.length} 個專案）\n\n💡 建議下一步操作：\n1. 使用 search_code 工具搜尋檔案名稱或關鍵字（如 "${filePath.split('/').pop()}")\n2. 使用 explore_project_structure 查看專案目錄結構\n3. 確認檔案路徑大小寫是否正確\n4. 檔案可能位於非預設分支`,
          }],
        };
      }
      
      return {
        content: [{
          type: "text",
          text: `找到 ${matchedProjects.length} 個包含檔案 "${filePath}" 的專案：\n\n${matchedProjects.map(p => `- **${p.name}** (ID: ${p.id})\n  路徑: ${p.path}\n  分支: ${p.branch}`).join("\n\n")}`,
        }],
      };
    } catch (error: any) {
      console.error(`[search_projects_by_file] 失敗`, { message: error.message });
      return {
        content: [{
          type: "text",
          text: `搜尋失敗: ${error.message}`,
        }],
        isError: true,
      };
    }
  });

  server.tool(
    "search_code", 
    "在群組內搜尋程式碼或檔案內容。💡 當不確定檔案位置或想搜尋程式碼片段時使用。找到結果後可用 read_project_file 讀取完整內容。", 
    {
      query: z.string().describe("搜尋關鍵字，例如：臺銀、esunbank、PaymentService、virtual_account"),
      scope: z.enum(["blobs", "wiki_blobs"]).optional().describe("搜尋範圍（預設 blobs = 程式碼檔案）"),
    }, 
    async ({ query, scope = "blobs" }) => {
    console.log(`[search_code] 搜尋關鍵字 "${query}"（範圍：${scope}）`);
    
    try {
      const searchUrl = `${GITLAB_API}/groups/${PLATFORM_GROUP_ID}/search?scope=${scope}&search=${encodeURIComponent(query)}&per_page=50`;
      const response = await axios.get(searchUrl, { headers: { "PRIVATE-TOKEN": GROUP_TOKEN } });
      const results = Array.isArray(response.data) ? response.data : [];
      
      console.log(`[search_code] 找到 ${results.length} 筆結果`);
      
      if (results.length === 0) {
        return {
          content: [{
            type: "text",
            text: `未找到包含 "${query}" 的程式碼\n\n💡 建議下一步操作：\n1. 嘗試使用相關的英文關鍵字（如 "payment", "virtual", "bank"）\n2. 使用 search_projects_by_file 搜尋特定檔案\n3. 使用 list_platform_projects 查看所有可用專案\n4. 確認關鍵字拼寫是否正確`,
          }],
        };
      }
      
      // 將結果依專案分組
      const groupedResults = new Map<string, Array<any>>();
      for (const result of results) {
        const projectName = result.project_id ? `Project ${result.project_id}` : "Unknown";
        if (!groupedResults.has(projectName)) {
          groupedResults.set(projectName, []);
        }
        groupedResults.get(projectName)!.push(result);
      }
      
      let output = `找到 ${results.length} 筆包含 "${query}" 的程式碼：\n\n`;
      
      for (const [projectName, items] of groupedResults.entries()) {
        output += `## ${projectName} (${items.length} 筆)\n\n`;
        for (const item of items.slice(0, 10)) { // 每個專案最多顯示 10 筆
          output += `- **${item.filename || item.path || "unknown"}**\n`;
          if (item.ref) output += `  分支: ${item.ref}\n`;
          if (item.data) {
            const preview = item.data.substring(0, 200).replace(/\n/g, " ");
            output += `  內容預覽: ${preview}${item.data.length > 200 ? "..." : ""}\n`;
          }
          output += "\n";
        }
        if (items.length > 10) {
          output += `  ... 還有 ${items.length - 10} 筆結果\n\n`;
        }
      }
      
      return {
        content: [{ type: "text", text: output }],
      };
    } catch (error: any) {
      const status = error.response?.status;
      console.error(`[search_code] 失敗`, { status, message: error.message });
      return {
        content: [{
          type: "text",
          text: `搜尋失敗: ${error.message}${status === 403 ? "\n\n可能是權限不足或 Token 沒有搜尋權限" : ""}`,
        }],
        isError: true,
      };
    }
  });

  server.tool(
    "read_project_file", 
    "讀取 GitLab 專案檔案（自動搜尋所有分支）。⚠️ 如果不確定檔案路徑，請先使用 search_code、explore_project_structure 或 analyze_feature 工具。", 
    {
      projectId: z.string().describe("GitLab Project ID 或專案路徑（如 'platform/tc-gaizan'）"),
      filePath: z.string().describe("檔案完整路徑（從專案根目錄開始）"),
      ref: z.string().optional().describe("指定分支名稱（可選，若未指定則搜尋所有分支）"),
    }, 
    async ({ projectId, filePath, ref }) => {
    // projectId 可能為 "group/project" 路徑，需整體 URL 編碼
    const encodedProjectId = encodeURIComponent(projectId);
    // filePath 只需單次編碼（GitLab API 會自動處理路徑中的斜線）
    const encodedFilePath = encodeURIComponent(filePath);

    console.log(`[read_project_file] 開始讀取`, { projectId, encodedProjectId, filePath, encodedFilePath, ref: ref || "未指定（搜尋所有分支）" });

    const tryFetch = async (branch: string) => {
      const url = `${GITLAB_API}/projects/${encodedProjectId}/repository/files/${encodedFilePath}/raw?ref=${encodeURIComponent(branch)}`;
      return axios.get(url, { headers: { "PRIVATE-TOKEN": GROUP_TOKEN } });
    };

    // 如果指定了 ref，直接嘗試該分支
    if (ref) {
      try {
        console.log(`[read_project_file] 嘗試指定分支 "${ref}"`);
        const response = await tryFetch(ref);
        console.log(`[read_project_file] ✓ 在分支 "${ref}" 找到檔案`);
        return { content: [{ type: "text", text: String(response.data) }] };
      } catch (error: any) {
        const status = error.response?.status;
        const body = error.response?.data;
        console.error(`[read_project_file] 指定分支失敗`, { status, body, ref, message: error.message });
        return {
          content: [{
            type: "text",
            text: `讀取失敗：projectId=${projectId}, filePath=${filePath}, ref=${ref}\n${status ? `HTTP ${status}\n` : ""}${body ? `回應: ${JSON.stringify(body)}\n` : ""}錯誤: ${error.message}\n\n💡 建議下一步操作：\n1. 使用 explore_project_structure 查看專案目錄結構\n2. 使用 search_code 搜尋檔案名稱找出正確路徑\n3. 確認 projectId 格式（可用專案路徑或數字 ID）\n4. 檢查是否有權限存取該專案`,
          }],
          isError: true,
        };
      }
    }

    // 未指定 ref：取得所有分支並搜尋
    let allBranches: string[] = [];
    try {
      const branchesUrl = `${GITLAB_API}/projects/${encodedProjectId}/repository/branches?per_page=100`;
      console.log(`[read_project_file] 取得所有分支: ${branchesUrl}`);
      const branchesResponse = await axios.get(branchesUrl, { headers: { "PRIVATE-TOKEN": GROUP_TOKEN } });
      allBranches = branchesResponse.data.map((b: any) => b.name);
      console.log(`[read_project_file] 找到 ${allBranches.length} 個分支: ${allBranches.slice(0, 10).join(", ")}${allBranches.length > 10 ? "..." : ""}`);
    } catch (error: any) {
      console.error(`[read_project_file] 無法取得分支列表`, { status: error.response?.status, message: error.message });
      return {
        content: [{
          type: "text",
          text: `無法取得專案分支列表：${error.message}\n\n💡 建議下一步操作：\n1. 使用 list_platform_projects 確認專案 ID 是否正確\n2. 確認 projectId 格式（可用 'platform/project-name' 或數字 ID）\n3. 檢查 Token 是否有足夠權限存取該專案`,
        }],
        isError: true,
      };
    }

    if (allBranches.length === 0) {
      return {
        content: [{ type: "text", text: `專案沒有任何分支` }],
        isError: true,
      };
    }

    // 優先嘗試常見的預設分支
    const priorityBranches = ["main", "master", "develop", "production"];
    const sortedBranches = [
      ...priorityBranches.filter(b => allBranches.includes(b)),
      ...allBranches.filter(b => !priorityBranches.includes(b))
    ];

    console.log(`[read_project_file] 搜尋順序（前 10 個）: ${sortedBranches.slice(0, 10).join(" → ")}${sortedBranches.length > 10 ? ` ...等共 ${sortedBranches.length} 個` : ""}`);

    // 逐一嘗試每個分支
    for (const branch of sortedBranches) {
      try {
        const response = await tryFetch(branch);
        console.log(`[read_project_file] ✓ 在分支 "${branch}" 找到檔案`);
        return { 
          content: [{ 
            type: "text", 
            text: `# 檔案來源：分支 "${branch}"\n\n${String(response.data)}` 
          }] 
        };
      } catch (error: any) {
        const status = error.response?.status;
        if (status === 404) {
          // 繼續下一個分支
          continue;
        }
        // 非 404 錯誤：記錄但繼續嘗試
        console.warn(`[read_project_file] ✗ 分支 "${branch}" 發生錯誤 (${status})，繼續嘗試下一個`);
      }
    }

    // 所有分支都找不到
    console.error(`[read_project_file] ❌ 在所有 ${sortedBranches.length} 個分支中都找不到檔案`);
    return {
      content: [{
        type: "text",
        text: `讀取失敗：projectId=${projectId}, filePath=${filePath}\n\n已搜尋所有 ${sortedBranches.length} 個分支，皆未找到該檔案。\n\n💡 建議下一步操作：\n1. 使用 explore_project_structure 查看專案實際目錄結構\n2. 使用 search_code 搜尋檔案名稱 "${filePath.split('/').pop()}"\n3. 確認檔案路徑大小寫是否正確\n4. 確認 projectId 格式（可用專案路徑或數字 ID）\n\n可能原因：\n- 檔案路徑不正確（請確認大小寫與完整路徑）\n- 檔案確實不存在於任何分支\n- Token 權限不足\n\n已搜尋的分支：${sortedBranches.slice(0, 20).join(", ")}${sortedBranches.length > 20 ? ` ...等共 ${sortedBranches.length} 個` : ""}`,
      }],
      isError: true,
    };
  });

  server.tool(
    "explore_project_structure",
    "探索專案的目錄結構。💡 當不確定檔案位置時使用，可遞迴查看整個專案的檔案樹。",
    {
      projectId: z.string().describe("GitLab Project ID 或專案路徑"),
      path: z.string().optional().describe("指定子目錄路徑（預設為根目錄）"),
      recursive: z.boolean().optional().describe("是否遞迴列出所有子目錄（預設 true）"),
      ref: z.string().optional().describe("指定分支名稱（預設使用主分支）"),
    },
    async ({ projectId, path = "", recursive = true, ref }) => {
      const encodedProjectId = encodeURIComponent(projectId);
      console.log(`[explore_project_structure] 探索專案結構`, { projectId, path, recursive, ref });

      try {
        // 如果沒有指定 ref，先取得預設分支
        let branch: string = ref || "";
        if (!branch) {
          const projectUrl = `${GITLAB_API}/projects/${encodedProjectId}`;
          const projectResponse = await axios.get(projectUrl, { headers: { "PRIVATE-TOKEN": GROUP_TOKEN } });
          branch = projectResponse.data.default_branch || "main";
        }

        // 取得目錄樹
        const treeUrl = `${GITLAB_API}/projects/${encodedProjectId}/repository/tree?path=${encodeURIComponent(path)}&ref=${encodeURIComponent(branch)}&recursive=${recursive}&per_page=100`;
        const response = await axios.get(treeUrl, { headers: { "PRIVATE-TOKEN": GROUP_TOKEN } });
        const tree = Array.isArray(response.data) ? response.data : [];

        console.log(`[explore_project_structure] 找到 ${tree.length} 個項目`);

        if (tree.length === 0) {
          return {
            content: [{
              type: "text",
              text: `目錄 "${path || '/'}" 是空的或不存在\n\n💡 建議：\n1. 確認路徑是否正確\n2. 嘗試不指定 path 參數以查看根目錄\n3. 使用 list_platform_projects 確認專案資訊`,
            }],
          };
        }

        // 分類檔案和目錄
        const directories = tree.filter((item: any) => item.type === "tree");
        const files = tree.filter((item: any) => item.type === "blob");

        let output = `# 專案結構：${projectId}\n`;
        output += `分支：${branch}\n`;
        output += `路徑：${path || '/'}\n`;
        output += `找到：${directories.length} 個目錄，${files.length} 個檔案\n\n`;

        // 建立樹狀結構
        if (recursive) {
          // 遞迴模式：按路徑排序並顯示完整結構
          const allItems = [...tree].sort((a: any, b: any) => a.path.localeCompare(b.path));
          output += "## 完整目錄樹\n\n";
          output += "```\n";
          for (const item of allItems) {
            const depth = item.path.split('/').length - (path ? path.split('/').length : 0);
            const indent = "  ".repeat(depth - 1);
            const icon = item.type === "tree" ? "📁" : "📄";
            const relativePath = path ? item.path.substring(path.length + 1) : item.path;
            output += `${indent}${icon} ${relativePath}\n`;
          }
          output += "```\n\n";
        } else {
          // 非遞迴模式：只顯示當前層級
          if (directories.length > 0) {
            output += "## 📁 目錄\n\n";
            for (const dir of directories.slice(0, 50)) {
              output += `- ${dir.name}/\n`;
            }
            if (directories.length > 50) {
              output += `\n... 還有 ${directories.length - 50} 個目錄\n`;
            }
            output += "\n";
          }

          if (files.length > 0) {
            output += "## 📄 檔案\n\n";
            for (const file of files.slice(0, 50)) {
              output += `- ${file.name}\n`;
            }
            if (files.length > 50) {
              output += `\n... 還有 ${files.length - 50} 個檔案\n`;
            }
          }
        }

        output += "\n💡 提示：找到目標檔案後，使用 read_project_file 讀取內容";

        return {
          content: [{ type: "text", text: output }],
        };
      } catch (error: any) {
        const status = error.response?.status;
        console.error(`[explore_project_structure] 失敗`, { status, message: error.message });
        return {
          content: [{
            type: "text",
            text: `探索專案結構失敗：${error.message}${status ? ` (HTTP ${status})` : ""}\n\n💡 建議：\n1. 使用 list_platform_projects 確認專案 ID\n2. 確認是否有權限存取該專案\n3. 檢查指定的路徑或分支是否存在`,
          }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "analyze_feature",
    "智能分析專案功能實作。💡 當詢問『某專案如何實作某功能』時使用，會自動搜尋相關程式碼並讀取關鍵檔案。",
    {
      projectId: z.string().describe("GitLab Project ID 或專案路徑"),
      featureName: z.string().describe("功能名稱或關鍵字，例如：虛擬帳號產生、臺銀串接、繳費流程"),
      keywords: z.array(z.string()).optional().describe("額外的搜尋關鍵字（選填，會自動從功能名稱推測）"),
    },
    async ({ projectId, featureName, keywords = [] }) => {
      console.log(`[analyze_feature] 分析功能實作`, { projectId, featureName, keywords });

      const encodedProjectId = encodeURIComponent(projectId);
      const results: string[] = [];

      try {
        results.push(`# 功能分析：${featureName}`);
        results.push(`專案：${projectId}\n`);

        // 步驟 1：從功能名稱推測關鍵字
        const autoKeywords = [
          ...featureName.split(/[\s、，]+/),
          ...keywords
        ].filter(k => k.length > 1);

        results.push(`## 🔍 階段 1：搜尋相關程式碼\n`);
        results.push(`搜尋關鍵字：${autoKeywords.join(', ')}\n`);

        const relevantFiles = new Set<string>();
        const codeSnippets: Array<{ file: string; content: string }> = [];

        // 對每個關鍵字進行搜尋
        for (const keyword of autoKeywords.slice(0, 5)) {
          try {
            const searchUrl = `${GITLAB_API}/groups/${PLATFORM_GROUP_ID}/search?scope=blobs&search=${encodeURIComponent(keyword)}&per_page=20`;
            const response = await axios.get(searchUrl, { headers: { "PRIVATE-TOKEN": GROUP_TOKEN } });
            const searchResults = Array.isArray(response.data) ? response.data : [];

            for (const result of searchResults) {
              if (result.project_id?.toString() === projectId || result.project_id === parseInt(projectId)) {
                relevantFiles.add(result.path || result.filename);
                if (codeSnippets.length < 10) {
                  codeSnippets.push({
                    file: result.path || result.filename,
                    content: result.data?.substring(0, 300) || ""
                  });
                }
              }
            }
          } catch (error: any) {
            console.warn(`[analyze_feature] 搜尋關鍵字 "${keyword}" 失敗:`, error.message);
          }
        }

        if (relevantFiles.size === 0) {
          results.push(`❌ 未找到包含關鍵字的程式碼\n`);
          results.push(`\n💡 建議：\n`);
          results.push(`1. 使用 search_code 工具手動搜尋更多關鍵字\n`);
          results.push(`2. 使用 explore_project_structure 查看專案結構\n`);
          results.push(`3. 檢查專案名稱或關鍵字是否正確\n`);
          
          return {
            content: [{ type: "text", text: results.join("") }],
          };
        }

        results.push(`✓ 找到 ${relevantFiles.size} 個相關檔案\n\n`);

        // 步驟 2：顯示程式碼片段
        if (codeSnippets.length > 0) {
          results.push(`## 📝 階段 2：相關程式碼片段\n\n`);
          for (const snippet of codeSnippets.slice(0, 5)) {
            results.push(`### ${snippet.file}\n`);
            results.push("```\n");
            results.push(snippet.content.replace(/\n/g, " ").substring(0, 200));
            results.push("...\n```\n\n");
          }
        }

        // 步驟 3：識別關鍵檔案並讀取
        results.push(`## 🎯 階段 3：關鍵檔案分析\n\n`);
        results.push(`識別到的重要檔案：\n`);

        const keyFiles = Array.from(relevantFiles)
          .filter(f => 
            f.includes('Service') || 
            f.includes('Controller') || 
            f.includes('Model') ||
            f.includes('Entity') ||
            f.endsWith('.php') ||
            f.endsWith('.ts') ||
            f.endsWith('.js')
          )
          .slice(0, 3);

        for (const filePath of keyFiles) {
          results.push(`\n### 📄 ${filePath}\n\n`);
          
          try {
            // 嘗試讀取檔案
            const encodedFilePath = encodeURIComponent(filePath);
            
            // 先取得專案預設分支
            const projectUrl = `${GITLAB_API}/projects/${encodedProjectId}`;
            const projectResponse = await axios.get(projectUrl, { headers: { "PRIVATE-TOKEN": GROUP_TOKEN } });
            const branch = projectResponse.data.default_branch || "main";
            
            const fileUrl = `${GITLAB_API}/projects/${encodedProjectId}/repository/files/${encodedFilePath}/raw?ref=${encodeURIComponent(branch)}`;
            const fileResponse = await axios.get(fileUrl, { headers: { "PRIVATE-TOKEN": GROUP_TOKEN } });
            
            const content = String(fileResponse.data);
            const lines = content.split('\n');
            
            // 顯示檔案摘要
            results.push(`檔案大小：${lines.length} 行\n\n`);
            
            // 找出包含關鍵字的行
            const relevantLines: Array<{ lineNum: number; content: string }> = [];
            for (let i = 0; i < lines.length; i++) {
              const line = lines[i];
              if (line && autoKeywords.some(kw => line.toLowerCase().includes(kw.toLowerCase()))) {
                relevantLines.push({ lineNum: i + 1, content: line });
              }
            }
            
            if (relevantLines.length > 0) {
              results.push(`關鍵程式碼位置（找到 ${relevantLines.length} 處）：\n\n`);
              results.push("```\n");
              for (const line of relevantLines.slice(0, 10)) {
                results.push(`[行 ${line.lineNum}] ${line.content.trim()}\n`);
              }
              if (relevantLines.length > 10) {
                results.push(`... 還有 ${relevantLines.length - 10} 處\n`);
              }
              results.push("```\n");
            }
            
            results.push(`\n💡 使用 read_project_file 可讀取完整內容\n`);
            
          } catch (error: any) {
            results.push(`⚠️  無法讀取檔案：${error.message}\n`);
          }
        }

        // 總結
        results.push(`\n## 📊 分析總結\n\n`);
        results.push(`- 找到 ${relevantFiles.size} 個相關檔案\n`);
        results.push(`- 深入分析了 ${keyFiles.length} 個關鍵檔案\n`);
        results.push(`- 搜尋關鍵字：${autoKeywords.join(', ')}\n\n`);
        results.push(`💡 下一步建議：\n`);
        results.push(`1. 使用 read_project_file 讀取完整檔案內容進行深入分析\n`);
        results.push(`2. 使用 search_code 搜尋更具體的函式名稱或類別名稱\n`);
        results.push(`3. 使用 explore_project_structure 了解專案整體架構\n`);

        return {
          content: [{ type: "text", text: results.join("") }],
        };

      } catch (error: any) {
        console.error(`[analyze_feature] 失敗`, { message: error.message });
        return {
          content: [{
            type: "text",
            text: `功能分析失敗：${error.message}\n\n💡 建議：\n1. 確認專案 ID 是否正確\n2. 手動使用 search_code 搜尋關鍵字\n3. 使用 list_platform_projects 查看所有專案`,
          }],
          isError: true,
        };
      }
    }
  );

  return server;
}

// --- Express 初始化 ---
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

  // 驗證是否成功移除
  if (sessionId) {
    if (!streamableTransports.has(sessionId)) {
      console.log(`✅ Session ${sessionId} 已成功移除`);
    } else {
      console.log(`❌ Session ${sessionId} 未成功移除`);
    }
  }
});


app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 GitLab MCP Server 已啟動`);
  console.log(`   Streamable HTTP : ${URL}:${PORT}/mcp`);
});