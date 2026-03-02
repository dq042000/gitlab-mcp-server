<!--
自動產生的 README，若需調整請編輯此檔。
-->
# gitlab-mcp-server

簡短說明

- **用途**：此專案是一個以 TypeScript 撰寫的 Node.js 伺服器範例，主要入口為 [src/index.ts](src/index.ts)。
- **專案類型**：TypeScript + Node.js

**專案結構**

- [package.json](package.json) - 專案相依與 scripts 定義
- [tsconfig.json](tsconfig.json) - TypeScript 設定
- [src/index.ts](src/index.ts) - 應用程式進入點

開始（本地開發）

建議步驟（以常見設定為例，實際以 [package.json](package.json) 為準）：

1. 安裝相依套件

```bash
npm install
```

2. 本地建置（TypeScript → JavaScript）

```bash
npm run build
# 或: npx tsc -p tsconfig.json
```

3. 啟動伺服器

```bash
npm start
# 或直接執行編譯後的檔案，例如: node dist/index.js
```

開發流程（開發時可用）

- 使用 `ts-node` 或 `nodemon` + `ts-node` 來熱重載：

```bash
npm run dev
```

MCP 連線模式與常見錯誤

- 伺服器同時支援兩種模式：
	- Stateful：客戶端帶 `mcp-session-id`，伺服器維護 session。
	- Stateless：客戶端未帶 `mcp-session-id`，伺服器會以無 session 模式處理請求。
- 若遇到 `Request failed with status code 400`，通常代表請求不是 `initialize` 且 session 無效。
- 若遇到 `Session not found`，請讓客戶端重新 initialize（重新連線）。

`search_code`（無 Elasticsearch）調校建議

- 可用 `mode` 控制掃描策略：
	- `fast`：較快（掃描範圍較小）
	- `balanced`：預設（速度與完整度平衡）
	- `deep`：較完整（掃描範圍較大）
	- `hybrid`：先 `fast` 再 `deep` 補抓（建議查漏時使用）
- 可選參數：
	- `maxProjects`：最多掃描專案數
	- `maxFilesPerProject`：每個專案最多讀取檔案數
	- `maxResults`：最多回傳結果數
- 多關鍵字請用 `|` 分隔，例如：`臺銀|台銀|繳費|virtual_account|bank_code`

GitLab Token 權限建議（`GITLAB_GROUP_TOKEN`）

- **建議類型**：`Group Access Token`
- **最小 Scope**：`read_api`
- **建議角色**：至少 `Reporter`（可讀取群組內專案與 repository 內容）
- **不需要開啟**：`write_repository`、`read_registry`、`write_registry`

說明：本專案目前僅使用 GitLab 讀取型 API（`GET/HEAD`），包含：

- 列出群組專案
- 搜尋程式碼
- 讀取檔案內容
- 讀取分支與目錄樹

因此以 `read_api` 為最小且安全的預設即可；若你的 GitLab 環境策略較嚴格導致 `403`，再視需要升級為 `api`。

Token 安全檢查清單

- 不要把 token 寫進版本控制（避免提交 `.env`）
- 使用部署環境變數或 Secret 管理服務保存 token
- 以最小權限原則設定 scope（優先 `read_api`）
- 設定到期日並定期輪替 token
- 若懷疑外洩，立即 `revoke` 與重發 token

相依與建議工具

- Node.js (v16+ 建議)
- TypeScript
- 建議安裝 VS Code 的 TypeScript/Node 開發相關外掛

貢獻指南

1. Fork 專案並建立 branch
2. 撰寫或修改 `src/` 下的程式
3. 送出 PR 並描述變更重點

授權

此專案未指定授權（請視需求加入 LICENSE 檔）。

聯絡

若有問題或需求，請在 repository 中開 issue。
