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
