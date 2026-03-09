# MCP 運作流程說明（VS Code `mcp.json` → `src/index.ts`）

本文整理你目前設定（`type: "http"`）下，VS Code 按下「開始」後，伺服器端實際會走到 `src/index.ts` 的哪段程式碼，以及後續 MCP 呼叫如何分流。

---

## 1) 先釐清：按下「開始」時會不會直接執行 `src/index.ts`？

你的設定是：

```json
"stern": {
  "type": "http",
  "url": "https://mcp.sfs.tw/stern-mcp/mcp"
}
```

這代表 VS Code 會連到遠端 MCP URL，不會在 VS Code 本機直接 `node src/index.ts`。  
`src/index.ts` 是在「遠端伺服器進程已啟動」的前提下，由 Node.js 載入並執行（通常是 `node dist/index.js`）。

---

## 2) 伺服器啟動流程（進程啟動時）

當伺服器進程啟動，`src/index.ts` 主要執行順序如下：

1. **讀取環境變數**
   - `dotenv.config()`（`src/index.ts:10`）
   - 讀取 `GITLAB_API`、`GITLAB_GROUP_TOKEN`、`PLATFORM_GROUP_ID`、`PORT`、`URL`（`12-16`）
2. **必要參數檢查**
   - 缺少 `GITLAB_API` / `GITLAB_GROUP_TOKEN` / `URL` 會 `process.exit(1)`（`18-21`）
3. **建立 Express 與中介層**
   - `const app = express()`（`1145`）
   - `app.use(express.json())`（`1146`）
   - `/mcp` 請求 log 中介層（`1147-1153`）
4. **建立 session 容器與工具方法**
   - `streamableTransports` / `sessionLastActivity`（`1156-1157`）
   - `closeSessionTransport`、`handleStatelessMcpRequest` 等（`1175-1205`）
5. **排程工作**
   - 每 30 秒印活躍 session（`1207-1215`）
   - 每 5 分鐘清理逾時 session（`1216-1227`）
6. **註冊 MCP 路由**
   - `POST /mcp`（`1229-1309`）
   - `GET /mcp`（`1311-1332`）
   - `DELETE /mcp`（`1334-1363`）
7. **啟動 HTTP Server**
   - `app.listen(PORT, "0.0.0.0", ...)`（`1366-1369`）

---

## 3) VS Code 按「開始」時（初始化連線）走哪段？

按下「開始」後，客戶端會發第一個 MCP 請求（通常是 `initialize`）到 `POST /mcp`，流程在 `1229-1263`：

1. 進入 `app.post("/mcp", ...)`（`1229`）
2. 讀取 `mcp-session-id`（`1231`）
3. 若是「**沒有 sessionId** 且是 initialize」：
   - `if (!sessionId && isInitializeRequest(req.body))`（`1242`）
   - 建立 `StreamableHTTPServerTransport`（`1244-1251`）
   - 在 `onsessioninitialized` 記錄 session（`1246-1250`）
   - `createMcpServer()` 建立 MCP server 並註冊工具（`1260`，定義在 `37-1142`）
   - `await mcpServer.connect(transport)`（`1261`）
   - `await transport.handleRequest(req, res, req.body)`（`1262`）

> 結論：你要找的「按下開始會跑哪段」核心就是 `POST /mcp` 的 `1242-1263` 分支。

---

## 4) `createMcpServer()` 在什麼時候跑？裡面跑什麼？

`createMcpServer()` 會在兩種情況被呼叫：

1. **新 session initialize**：`1260`
2. **stateless fallback**：`handleStatelessMcpRequest()` 內的 `1202`

函式本體在 `37-1142`，主要內容：

- 建立 `new McpServer({ name, version })`（`38-41`）
- 宣告 GitLab 操作 helper（如 `listAccessibleProjects`、`searchCodeInGroup`）
- 註冊所有 MCP tools（`server.tool(...)`）：
  - `list_platform_projects`（`478-511`）
  - `search_projects_by_file`（`513-585`）
  - `search_code`（`587-736`）
  - `read_project_file`（`738-864`）
  - `explore_project_structure`（`866-968`）
  - `analyze_feature`（`970-1139`）

---

## 5) 開始呼叫 MCP 工具時（list tools / call tool）走哪段？

初始化成功後，客戶端會拿到 `mcp-session-id`，後續請求通常流程：

1. 再次 `POST /mcp`，帶 `mcp-session-id`
2. 命中既有 session 分支（`1234-1239`）
   - 更新 `sessionLastActivity`（`1237`）
   - `await transport.handleRequest(...)`（`1238`）
3. SDK 將請求分派到對應的 `server.tool(...)` handler（見上節各工具區段）

也就是說，真正執行工具業務邏輯的是 `createMcpServer()` 裡註冊的各 tool callback。

---

## 6) 其他 HTTP 方法與 session 生命週期

### `GET /mcp`（`1311-1332`）
- 用於既有 session 的 stream/輪詢處理（取決於客戶端與協議細節）
- 找不到 session 回 `404`（`1315-1317`）

### `DELETE /mcp`（`1334-1363`）
- 先 `transport.handleRequest`（`1342`）
- 再 `closeSessionTransport(sessionId, "delete")`（`1345`）
- 期望將 session 自 map 移除（`1346-1349`）

### 自動清理
- 30 分鐘無活動會被 timeout 清理（`1216-1227`）

---

## 7) 例外與錯誤分支（`POST /mcp`）

在 `1229-1309` 主要有幾個分支：

1. **有 sessionId 且 transport 存在** → 正常轉發（`1234-1239`）
2. **無 sessionId + initialize** → 建立新 session（`1242-1263`）
3. **有 sessionId 但找不到 transport** → `404 Session not found`（`1266-1273`）
4. **無 sessionId 但非 initialize**：
   - 先嘗試 stateless fallback（`1275-1278`）
   - 若條件不符則回 `400`（`1281-1287`）
5. 其他未預期錯誤回 `500`（`1289-1307`）

---

## 8) 一句話版流程總結

1. 伺服器啟動時先跑 `src/index.ts`，掛好 `/mcp` 路由並 listen。  
2. VS Code 按「開始」→ 送 `initialize` 到 `POST /mcp` → 走 `1242-1263` 建 session、connect MCP server。  
3. 後續工具呼叫都帶 `mcp-session-id` 走 `1234-1239`，再由 SDK 分派到 `server.tool(...)` 的實作。  

