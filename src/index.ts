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
const PLATFORM_GROUP_ID = process.env.PLATFORM_GROUP_ID?.trim();
const PORT = Number(process.env.PORT) || 4321;
const URL = process.env.URL || "";

if (!GITLAB_API || !GROUP_TOKEN || !URL) {
  console.error("❌ 缺少環境變數");
  process.exit(1);
}

type CachedTreeEntry = {
  expiresAt: number;
  items: Array<any>;
};

const projectTreeCache = new Map<string, CachedTreeEntry>();

// --- 每次連線建立一個新的 McpServer 實例，避免 "Already connected to a transport" 錯誤 ---
function createMcpServer() {
  const server = new McpServer({
    name: "GitLab-Platform-Assistant",
    version: "1.0.0",
  });

  const getProjectsEndpointConfig = () => {
    if (PLATFORM_GROUP_ID) {
      return {
        mode: "group" as const,
        url: `${GITLAB_API}/groups/${PLATFORM_GROUP_ID}/projects`,
        baseParams: {
          include_subgroups: true,
          simple: true,
          order_by: "last_activity_at",
        },
      };
    }

    return {
      mode: "membership" as const,
      url: `${GITLAB_API}/projects`,
      baseParams: {
        membership: true,
        simple: true,
        order_by: "last_activity_at",
      },
    };
  };

  const listAccessibleProjects = async (options?: { maxProjects?: number; projectId?: string }) => {
    const headers = { "PRIVATE-TOKEN": GROUP_TOKEN };

    if (options?.projectId) {
      const encodedProjectId = encodeURIComponent(options.projectId);
      const response = await axios.get(`${GITLAB_API}/projects/${encodedProjectId}`, {
        headers,
      });
      return [response.data];
    }

    const { url, baseParams } = getProjectsEndpointConfig();
    const perPage = 100;
    const allProjects: Array<any> = [];
    let page = 1;

    while (true) {
      const response = await axios.get(url, {
        headers,
        params: {
          ...baseParams,
          per_page: perPage,
          page,
        },
      });

      const data = Array.isArray(response.data) ? response.data : [];
      allProjects.push(...data);

      if (options?.maxProjects && allProjects.length >= options.maxProjects) {
        return allProjects.slice(0, options.maxProjects);
      }

      const nextPage = Number(response.headers["x-next-page"] || "0");
      if (!nextPage || data.length === 0) {
        break;
      }

      page = nextPage;
    }

    return allProjects;
  };

  const splitKeywords = (rawQuery: string) => {
    return Array.from(new Set(
      rawQuery
        .split(/[|\n,]+/)
        .map(item => item.trim())
        .filter(item => item.length > 0)
    ));
  };

  const buildPreviewSnippet = (content: string, keyword: string) => {
    const index = content.toLowerCase().indexOf(keyword.toLowerCase());
    if (index < 0) {
      return content.slice(0, 220).replace(/\n/g, " ");
    }
    const start = Math.max(0, index - 100);
    const end = Math.min(content.length, index + 120);
    return content.slice(start, end).replace(/\n/g, " ");
  };

  const uniqueResults = (results: Array<any>) => {
    const seen = new Set<string>();
    const deduped: Array<any> = [];

    for (const item of results) {
      const key = `${item?.project_id || ""}::${item?.path || item?.filename || ""}::${item?.ref || ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(item);
    }

    return deduped;
  };

  const manualScanSearchInGroup = async (
    keywords: string[],
    options?: {
      scanMode?: "fast" | "balanced" | "deep";
      projectId?: string;
      maxProjects?: number;
      maxFilesReadPerProject?: number;
      maxMatchedResults?: number;
    }
  ) => {
    const headers = { "PRIVATE-TOKEN": GROUP_TOKEN };
    const scanMode = options?.scanMode || "balanced";

    const modeDefaults = {
      fast: { maxProjects: 15, maxFilesReadPerProject: 20, maxTreeItemsPerProject: 500, maxMatchedResults: 60, readConcurrency: 4, treeCacheTtlMs: 3 * 60 * 1000 },
      balanced: { maxProjects: 35, maxFilesReadPerProject: 40, maxTreeItemsPerProject: 1200, maxMatchedResults: 120, readConcurrency: 6, treeCacheTtlMs: 8 * 60 * 1000 },
      deep: { maxProjects: 80, maxFilesReadPerProject: 80, maxTreeItemsPerProject: 3000, maxMatchedResults: 250, readConcurrency: 8, treeCacheTtlMs: 15 * 60 * 1000 },
    } as const;
    const defaults = modeDefaults[scanMode];

    const maxProjects = options?.maxProjects ?? defaults.maxProjects;
    const maxFilesReadPerProject = options?.maxFilesReadPerProject ?? defaults.maxFilesReadPerProject;
    const maxMatchedResults = options?.maxMatchedResults ?? defaults.maxMatchedResults;
    const maxTreeItemsPerProject = defaults.maxTreeItemsPerProject;
    const readConcurrency = defaults.readConcurrency;
    const treeCacheTtlMs = defaults.treeCacheTtlMs;

    const projects = await listAccessibleProjects({
      maxProjects,
      ...(options?.projectId ? { projectId: options.projectId } : {}),
    });
    const projectsToScan = projects.slice(0, maxProjects);
    const allowedExtensions = [
      ".php", ".ts", ".js", ".vue", ".json", ".yml", ".yaml", ".xml",
      ".sql", ".py", ".java", ".go", ".rb", ".ini", ".env", ".md", ".txt",
    ];
    const normalizedKeywords = keywords.map(keyword => keyword.toLowerCase());
    const filenameHints = normalizedKeywords
      .filter(keyword => /^[a-z0-9_\-\.]{2,}$/.test(keyword))
      .slice(0, 8);

    const matchedResults: Array<any> = [];

    for (const project of projectsToScan) {
      const projectId = project?.id;
      if (!projectId) continue;

      const defaultBranch = project.default_branch || "main";
      const encodedProjectId = encodeURIComponent(String(projectId));

      try {
        const treeCacheKey = `${projectId}::${defaultBranch}`;
        let treeItems: Array<any> = [];
        const now = Date.now();
        const cachedTree = projectTreeCache.get(treeCacheKey);

        if (cachedTree && cachedTree.expiresAt > now) {
          treeItems = cachedTree.items;
        } else {
          let page = 1;
          while (treeItems.length < maxTreeItemsPerProject) {
            const treeUrl = `${GITLAB_API}/projects/${encodedProjectId}/repository/tree`;
            const treeResponse = await axios.get(treeUrl, {
              headers,
              params: {
                ref: defaultBranch,
                recursive: true,
                per_page: 100,
                page,
              },
            });

            const pageData = Array.isArray(treeResponse.data) ? treeResponse.data : [];
            if (pageData.length === 0) break;
            treeItems.push(...pageData);

            const nextPage = Number(treeResponse.headers["x-next-page"] || "0");
            if (!nextPage) break;
            page = nextPage;
          }

          projectTreeCache.set(treeCacheKey, {
            expiresAt: now + treeCacheTtlMs,
            items: treeItems,
          });
        }

        const candidateFiles = treeItems
          .filter(item => item?.type === "blob")
          .filter(item => {
            const path = String(item.path || "").toLowerCase();
            return allowedExtensions.some(ext => path.endsWith(ext));
          })
          .sort((a, b) => {
            const pathA = String(a?.path || "").toLowerCase();
            const pathB = String(b?.path || "").toLowerCase();
            const scoreA = filenameHints.some(hint => pathA.includes(hint)) ? 1 : 0;
            const scoreB = filenameHints.some(hint => pathB.includes(hint)) ? 1 : 0;
            return scoreB - scoreA;
          })
          .slice(0, maxFilesReadPerProject);

        for (let index = 0; index < candidateFiles.length; index += readConcurrency) {
          if (matchedResults.length >= maxMatchedResults) break;
          const chunk = candidateFiles.slice(index, index + readConcurrency);

          const chunkResults = await Promise.all(chunk.map(async (fileItem) => {
            const filePath = String(fileItem.path || "");
            const fileUrl = `${GITLAB_API}/projects/${encodedProjectId}/repository/files/${encodeURIComponent(filePath)}/raw`;

            try {
              const fileResponse = await axios.get(fileUrl, {
                headers,
                params: { ref: defaultBranch },
              });

              const content = String(fileResponse.data || "");
              const loweredContent = content.toLowerCase();
              const hitKeyword = normalizedKeywords.find(keyword => loweredContent.includes(keyword));

              if (!hitKeyword) {
                return null;
              }

              return {
                project_id: projectId,
                path: filePath,
                filename: filePath.split("/").pop() || filePath,
                ref: defaultBranch,
                data: buildPreviewSnippet(content, hitKeyword),
              };
            } catch (fileError: any) {
              const fileStatus = fileError.response?.status;
              if (fileStatus !== 404) {
                console.warn(`[manualScanSearchInGroup] 讀檔失敗`, {
                  projectId,
                  filePath,
                  status: fileStatus,
                  message: fileError.message,
                });
              }
              return null;
            }
          }));

          for (const item of chunkResults) {
            if (!item) continue;
            matchedResults.push(item);
            if (matchedResults.length >= maxMatchedResults) break;
          }
        }
      } catch (projectError: any) {
        console.warn(`[manualScanSearchInGroup] 專案掃描失敗`, {
          projectId,
          status: projectError.response?.status,
          message: projectError.message,
        });
      }

      if (matchedResults.length >= maxMatchedResults) {
        break;
      }
    }

    return uniqueResults(matchedResults);
  };

  const searchCodeInGroup = async (
    query: string,
    scope: "blobs" | "wiki_blobs",
    perPage: number,
    options?: {
      scanMode?: "fast" | "balanced" | "deep";
      projectId?: string;
      maxProjects?: number;
      maxFilesReadPerProject?: number;
      maxMatchedResults?: number;
    }
  ) => {
    const headers = { "PRIVATE-TOKEN": GROUP_TOKEN };
    const diagnostics: string[] = [];
    const keywords = splitKeywords(query);
    const attempts: Array<{ name: string; url: string; params: Record<string, string | number> }> = [];

    if (options?.projectId) {
      attempts.push({
        name: "project-search-endpoint",
        url: `${GITLAB_API}/projects/${encodeURIComponent(options.projectId)}/search`,
        params: { scope, search: keywords[0] || query, per_page: perPage },
      });
    } else if (PLATFORM_GROUP_ID) {
      attempts.push({
        name: "group-search-endpoint",
        url: `${GITLAB_API}/groups/${PLATFORM_GROUP_ID}/search`,
        params: { scope, search: keywords[0] || query, per_page: perPage },
      });

      attempts.push({
        name: "global-search-with-group-id",
        url: `${GITLAB_API}/search`,
        params: { scope, search: keywords[0] || query, group_id: String(PLATFORM_GROUP_ID), per_page: perPage },
      });
    } else {
      attempts.push({
        name: "global-search-membership-scope",
        url: `${GITLAB_API}/search`,
        params: { scope, search: keywords[0] || query, per_page: perPage },
      });
    }

    let lastError: any = null;
    for (const attempt of attempts) {
      try {
        console.log(`[searchCodeInGroup] 嘗試策略: ${attempt.name}`, { query, keywords, scope, perPage });
        const response = await axios.get(attempt.url, { headers, params: attempt.params });
        const results = Array.isArray(response.data) ? response.data : [];
        console.log(`[searchCodeInGroup] 策略成功: ${attempt.name}, 結果 ${results.length} 筆`);
        return { results, strategy: attempt.name };
      } catch (error: any) {
        const status = error.response?.status;
        const body = error.response?.data;
        lastError = error;
        diagnostics.push(`${attempt.name}: HTTP ${status ?? "unknown"}${body ? ` => ${JSON.stringify(body)}` : ""}`);

        console.warn(`[searchCodeInGroup] ${attempt.name} 失敗`, {
          status,
          body,
          message: error.message,
        });

        if (status !== 400) {
          (error as any).diagnostics = diagnostics;
          throw error;
        }
      }
    }

    try {
      console.log(`[searchCodeInGroup] 進入 fallback：逐專案掃描內容`, { query, keywords, scope });
      const scanResults = await manualScanSearchInGroup(
        keywords.length > 0 ? keywords : [query],
        options,
      );
      console.log(`[searchCodeInGroup] fallback 完成，結果 ${scanResults.length} 筆`);
      return {
        results: scanResults,
        strategy: "manual-content-scan-fallback",
      };
    } catch (fallbackError: any) {
      const fallbackStatus = fallbackError.response?.status;
      const fallbackBody = fallbackError.response?.data;
      diagnostics.push(`project-by-project-fallback: HTTP ${fallbackStatus ?? "unknown"}${fallbackBody ? ` => ${JSON.stringify(fallbackBody)}` : ""}`);
      (fallbackError as any).diagnostics = diagnostics;
      throw fallbackError;
    }
  };

  server.tool(
    "list_platform_projects", 
    "列出可存取專案。💡 若設定 PLATFORM_GROUP_ID 則限定該群組（含子群組）；未設定則列出 token 可存取專案。", 
    {}, 
    async () => {
    try {
      const projects = await listAccessibleProjects();
      const mappedProjects = projects.map(p => ({
        id: p.id,
        name: p.name,
        description: p.description,
        path: p.path_with_namespace,
      }));

      if (mappedProjects.length === 0) {
        console.warn(`[list_platform_projects] empty result after pagination`);
      } else {
        console.log(`[list_platform_projects] fetched ${mappedProjects.length} projects across pages`);
      }

      return { content: [{ type: "text", text: JSON.stringify(mappedProjects, null, 2) }] };
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
      const allProjects = await listAccessibleProjects({ maxProjects });
      
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
    "在可存取範圍內搜尋程式碼或檔案內容。💡 有設定 PLATFORM_GROUP_ID 時限定該群組；未設定時以 token 可存取範圍搜尋。", 
    {
      query: z.string().describe("搜尋關鍵字，例如：臺銀、esunbank、PaymentService、virtual_account"),
      projectId: z.string().optional().describe("指定單一專案 ID 或路徑（如 12345 或 platform/tc-gaizan），可大幅加速搜尋"),
      scope: z.enum(["blobs", "wiki_blobs"]).optional().describe("搜尋範圍（預設 blobs = 程式碼檔案）"),
      mode: z.enum(["fast", "balanced", "deep", "hybrid"]).optional().describe("掃描模式：fast（較快）、balanced（預設）、deep（較完整）、hybrid（先快後深）"),
      maxProjects: z.number().int().min(1).max(200).optional().describe("最多掃描專案數（覆蓋模式預設值）"),
      maxFilesPerProject: z.number().int().min(1).max(200).optional().describe("每個專案最多讀取檔案數（覆蓋模式預設值）"),
      maxResults: z.number().int().min(1).max(500).optional().describe("最多回傳命中結果數（覆蓋模式預設值）"),
    }, 
    async ({ query, projectId, scope = "blobs", mode = "balanced", maxProjects, maxFilesPerProject, maxResults }) => {
    console.log(`[search_code] 搜尋關鍵字 "${query}"（範圍：${scope}, 模式：${mode}${projectId ? `, 專案：${projectId}` : ""}）`);
    
    try {
      const DEFAULT_UNSCOPED_MAX_PROJECTS = 10;
      const effectiveMaxProjects = typeof maxProjects === "number"
        ? maxProjects
        : (!projectId ? DEFAULT_UNSCOPED_MAX_PROJECTS : undefined);
      const shouldWarnUnscoped = !projectId;

      if (shouldWarnUnscoped && typeof maxProjects !== "number") {
        console.warn(`[search_code] 未指定 projectId，套用預設 maxProjects=${DEFAULT_UNSCOPED_MAX_PROJECTS} 以避免慢查詢`);
      }

      const searchOptions: {
        scanMode?: "fast" | "balanced" | "deep";
        projectId?: string;
        maxProjects?: number;
        maxFilesReadPerProject?: number;
        maxMatchedResults?: number;
      } = { scanMode: mode === "hybrid" ? "fast" : mode };

      if (projectId) {
        searchOptions.projectId = projectId;
      }

      if (typeof effectiveMaxProjects === "number") {
        searchOptions.maxProjects = effectiveMaxProjects;
      }
      if (typeof maxFilesPerProject === "number") {
        searchOptions.maxFilesReadPerProject = maxFilesPerProject;
      }
      if (typeof maxResults === "number") {
        searchOptions.maxMatchedResults = maxResults;
      }

      let { results, strategy } = await searchCodeInGroup(query, scope, 50, searchOptions);

      if (mode === "hybrid") {
        const firstPhaseCount = results.length;
        const shouldBackfill = strategy === "manual-content-scan-fallback" || firstPhaseCount < 20;

        if (shouldBackfill) {
          const deepOptions: {
            scanMode: "deep";
            projectId?: string;
            maxProjects?: number;
            maxFilesReadPerProject?: number;
            maxMatchedResults?: number;
          } = { scanMode: "deep" };

          if (projectId) {
            deepOptions.projectId = projectId;
          }

          if (typeof effectiveMaxProjects === "number") {
            deepOptions.maxProjects = effectiveMaxProjects;
          }
          if (typeof maxFilesPerProject === "number") {
            deepOptions.maxFilesReadPerProject = maxFilesPerProject;
          }
          if (typeof maxResults === "number") {
            deepOptions.maxMatchedResults = maxResults;
          }

          const { results: deepResults } = await searchCodeInGroup(query, scope, 50, deepOptions);
          const merged = uniqueResults([...results, ...deepResults]);
          const finalResults = typeof maxResults === "number" ? merged.slice(0, maxResults) : merged;
          results = finalResults;
          strategy = `two-phase-hybrid (fast:${firstPhaseCount} + deep:${deepResults.length})`;
        } else {
          strategy = `two-phase-hybrid (fast-only:${firstPhaseCount})`;
        }
      }
      
      console.log(`[search_code] 找到 ${results.length} 筆結果，策略：${strategy}`);
      
      if (results.length === 0) {
        const warningText = shouldWarnUnscoped
          ? `⚠️ 未指定 projectId，這次查詢已限制最多掃描 ${effectiveMaxProjects} 個專案以降低延遲。若要更快且更完整，建議指定 projectId。\n\n`
          : "";
        return {
          content: [{
            type: "text",
            text: `${warningText}未找到包含 "${query}" 的程式碼\n\n💡 建議下一步操作：\n1. 嘗試使用相關的英文關鍵字（如 "payment", "virtual", "bank"）\n2. 使用 search_projects_by_file 搜尋特定檔案\n3. 使用 list_platform_projects 查看所有可用專案\n4. 確認關鍵字拼寫是否正確`,
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
      
      let output = "";
      if (shouldWarnUnscoped) {
        output += `⚠️ 未指定 projectId，本次最多掃描 ${effectiveMaxProjects} 個專案（可用 maxProjects 覆蓋）。建議指定 projectId 以顯著加速。\n\n`;
      }
      output += `找到 ${results.length} 筆包含 "${query}" 的程式碼（策略：${strategy}${projectId ? `，專案：${projectId}` : ""}）：\n\n`;
      
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
      const body = error.response?.data;
      const diagnostics = (error as any).diagnostics as string[] | undefined;
      console.error(`[search_code] 失敗`, { status, body, message: error.message, diagnostics });
      return {
        content: [{
          type: "text",
          text: `搜尋失敗: ${error.message}${status ? ` (HTTP ${status})` : ""}${body ? `\n回應: ${JSON.stringify(body)}` : ""}${diagnostics && diagnostics.length > 0 ? `\n診斷:\n- ${diagnostics.join("\n- ")}` : ""}${status === 403 ? "\n\n可能是權限不足或 Token 沒有搜尋權限" : ""}`,
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
        const permissionHint = status === 401 || status === 403
          ? "\n\n⚠️ 偵測到權限錯誤，請確認 Token 具備該專案的讀取權限（至少 read_api）。"
          : "";
        return {
          content: [{
            type: "text",
            text: `讀取失敗：projectId=${projectId}, filePath=${filePath}, ref=${ref}\n${status ? `HTTP ${status}\n` : ""}${body ? `回應: ${JSON.stringify(body)}\n` : ""}錯誤: ${error.message}${permissionHint}\n\n💡 建議下一步操作：\n1. 使用 explore_project_structure 查看專案目錄結構\n2. 使用 search_code 搜尋檔案名稱找出正確路徑\n3. 確認 projectId 格式（可用專案路徑或數字 ID）\n4. 檢查是否有權限存取該專案`,
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

    const permissionErrors: Array<{ branch: string; status: number }> = [];
    const otherErrors: Array<{ branch: string; status: number | string }> = [];

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
        if (status === 401 || status === 403) {
          permissionErrors.push({ branch, status });
          console.warn(`[read_project_file] ✗ 分支 "${branch}" 權限不足 (${status})`);
          continue;
        }
        otherErrors.push({ branch, status: status || "unknown" });
        // 非 404 錯誤：記錄但繼續嘗試
        console.warn(`[read_project_file] ✗ 分支 "${branch}" 發生錯誤 (${status})，繼續嘗試下一個`);
      }
    }

    // 所有分支都找不到
    console.error(`[read_project_file] ❌ 在所有 ${sortedBranches.length} 個分支中都找不到檔案`);
    const permissionSummary = permissionErrors.length > 0
      ? `\n\n⚠️ 權限診斷：${permissionErrors.length} 個分支發生 401/403（${permissionErrors.slice(0, 8).map(item => `${item.branch}:${item.status}`).join(", ")}${permissionErrors.length > 8 ? " ..." : ""}）。\n這通常代表 Token 對該專案或部分保護分支缺少讀取權限。`
      : "";
    const otherErrorSummary = otherErrors.length > 0
      ? `\n\nℹ️ 其他錯誤：${otherErrors.length} 個分支發生非 404 錯誤（${otherErrors.slice(0, 6).map(item => `${item.branch}:${item.status}`).join(", ")}${otherErrors.length > 6 ? " ..." : ""}）。`
      : "";
    return {
      content: [{
        type: "text",
        text: `讀取失敗：projectId=${projectId}, filePath=${filePath}\n\n已嘗試 ${sortedBranches.length} 個分支，未成功讀取檔案。${permissionSummary}${otherErrorSummary}\n\n💡 建議下一步操作：\n1. 使用 explore_project_structure 查看專案實際目錄結構\n2. 使用 search_code 搜尋檔案名稱 "${filePath.split('/').pop()}"\n3. 確認檔案路徑大小寫是否正確\n4. 確認 projectId 格式（可用專案路徑或數字 ID）\n\n可能原因：\n- 檔案路徑不正確（請確認大小寫與完整路徑）\n- 檔案確實不存在於任何可存取分支\n- Token 權限不足（尤其當出現 401/403）\n\n已嘗試的分支：${sortedBranches.slice(0, 20).join(", ")}${sortedBranches.length > 20 ? ` ...等共 ${sortedBranches.length} 個` : ""}`,
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
            const { results: searchResults } = await searchCodeInGroup(keyword, "blobs", 20);

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
app.use((req, _res, next) => {
  if (req.path === "/mcp") {
    const sid = (req.headers["mcp-session-id"] as string | undefined) || "-";
    console.log(`[${new Date().toLocaleTimeString()}] [MCP] ${req.method} ${req.path} sid=${sid}`);
  }
  next();
});

// ── Streamable HTTP Transport（新版協議，供現代 MCP 客戶端使用）───────────────
const streamableTransports = new Map<string, StreamableHTTPServerTransport>();
const sessionLastActivity = new Map<string, number>();

const isBenignStreamTermination = (error: unknown) => {
  const message = String((error as any)?.message || "").toLowerCase();
  const code = String((error as any)?.code || "").toLowerCase();
  return (
    message.includes("terminated") ||
    message.includes("aborted") ||
    code === "econnreset" ||
    code === "err_stream_premature_close"
  );
};

const removeSession = (sessionId: string) => {
  streamableTransports.delete(sessionId);
  sessionLastActivity.delete(sessionId);
};

const closeSessionTransport = async (
  sessionId: string,
  reason: "timeout" | "delete" | "error" | "close-event"
) => {
  const transport = streamableTransports.get(sessionId) as any;

  if (reason !== "close-event" && transport?.close) {
    try {
      await Promise.resolve(transport.close());
    } catch (closeError: any) {
      if (!isBenignStreamTermination(closeError)) {
        console.warn(`[Streamable] 關閉 session 失敗`, {
          sessionId,
          reason,
          message: closeError?.message,
        });
      }
    }
  }

  removeSession(sessionId);
};

async function handleStatelessMcpRequest(req: express.Request, res: express.Response) {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined as unknown as () => string,
  });
  const mcpServer = createMcpServer();
  await mcpServer.connect(transport as any);
  await transport.handleRequest(req, res, req.body);
}

// 定期輸出當前活躍的 session 數量（每 30 秒）
setInterval(() => {
  console.log(`[${new Date().toLocaleTimeString()}] 📊 當前活躍 session 數量: ${streamableTransports.size}`);
  if (streamableTransports.size > 0) {
    const sessionIds = Array.from(streamableTransports.keys());
    console.log(`   Session IDs: ${sessionIds.join(', ')}`);
  }
}, 30000);

// 定期清理超過 30 分鐘未活動的 session
setInterval(() => {
  const now = Date.now();
  const timeout = 30 * 60 * 1000; // 30 分鐘
  
  for (const [sessionId, lastActivity] of sessionLastActivity.entries()) {
    if (now - lastActivity > timeout) {
      console.log(`[${new Date().toLocaleTimeString()}] ⏰ Session ${sessionId} 超時，自動清理`);
      void closeSessionTransport(sessionId, "timeout");
    }
  }
}, 5 * 60 * 1000); // 每 5 分鐘檢查一次

app.post("/mcp", async (req, res) => {
  try {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let transport = sessionId ? streamableTransports.get(sessionId) : undefined;

    if (transport) {
      // 已存在的 session：直接轉發請求
      console.log(`[${new Date().toLocaleTimeString()}] [Streamable] 既有 session: ${sessionId}`);
      if (sessionId) sessionLastActivity.set(sessionId, Date.now()); // 更新活動時間
      await transport.handleRequest(req, res, req.body);
      return;
    }

    if (!sessionId && isInitializeRequest(req.body)) {
      // 新 session：建立 Streamable HTTP Transport
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          streamableTransports.set(sid, transport!);
          sessionLastActivity.set(sid, Date.now()); // 記錄建立時間
          console.log(`[${new Date().toLocaleTimeString()}] ✅ [Streamable] session 建立: ${sid}`);
        },
      });

      transport.onclose = () => {
        if (transport!.sessionId) {
          void closeSessionTransport(transport!.sessionId, "close-event");
          console.log(`[${new Date().toLocaleTimeString()}] 🔌 [Streamable] session 關閉: ${transport!.sessionId}`);
        }
      };

      const mcpServer = createMcpServer();
      await mcpServer.connect(transport as any);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    if (sessionId && !transport) {
      res.status(404).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Session not found: 請重新 initialize" },
        id: null,
      });
      return;
    }

    if (!sessionId) {
      console.log(`[${new Date().toLocaleTimeString()}] [Stateless] 單次請求 fallback`);
      await handleStatelessMcpRequest(req, res);
      return;
    }

    if (!isInitializeRequest(req.body)) {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad Request: 非 initialize 請求且無有效 session" },
        id: null,
      });
      return;
    }
  } catch (error: any) {
    if (isBenignStreamTermination(error)) {
      console.info(`[MCP][POST] 串流連線中斷（可忽略）`, {
        message: error?.message,
      });
    } else {
      console.error(`[MCP][POST] 失敗`, {
        message: error?.message,
        stack: error?.stack,
        body: req.body,
      });
    }
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: `Internal error: ${error?.message ?? "unknown"}` },
        id: null,
      });
    }
  }
});

app.get("/mcp", async (req, res) => {
  try {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const transport = sessionId ? streamableTransports.get(sessionId) : undefined;
    if (!transport) {
      res.status(404).send("Session not found");
      return;
    }
    if (sessionId) sessionLastActivity.set(sessionId, Date.now()); // 更新活動時間
    await transport.handleRequest(req, res);
  } catch (error: any) {
    if (!isBenignStreamTermination(error)) {
      console.error(`[MCP][GET] 失敗`, {
        message: error?.message,
        stack: error?.stack,
      });
    }
    if (!res.headersSent) {
      res.status(500).send("Internal error");
    }
  }
});

app.delete("/mcp", async (req, res) => {
  try {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const transport = sessionId ? streamableTransports.get(sessionId) : undefined;
    if (!transport) {
      res.status(404).send("Session not found");
      return;
    }
    await transport.handleRequest(req, res);

    if (sessionId) {
      await closeSessionTransport(sessionId, "delete");
      if (!streamableTransports.has(sessionId)) {
        console.log(`✅ Session ${sessionId} 已成功移除`);
      } else {
        console.log(`❌ Session ${sessionId} 未成功移除`);
      }
    }
  } catch (error: any) {
    if (!isBenignStreamTermination(error)) {
      console.error(`[MCP][DELETE] 失敗`, {
        message: error?.message,
        stack: error?.stack,
      });
    }
    if (!res.headersSent) {
      res.status(500).send("Internal error");
    }
  }
});


app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 GitLab MCP Server 已啟動`);
  console.log(`   Streamable HTTP : ${URL}:${PORT}/mcp`);
});