# figloo-implement skill 與 Claude Code plugin

狀態：已實作；skill、plugin 的載入與 marketplace 安裝、觸發評估都已驗證；GitHub release 的 bundle 網址與 Codex 尚未實測  
日期：2026-10-02  
規劃：[Figloo 的 skill 與 plugin](../plans/2026-10-02-figloo-skill.md)

## 內容

| 項目 | 位置 |
|---|---|
| Skill | `plugins/figloo/skills/figloo-implement/`：`SKILL.md` 與兩個參考檔，說明快照大綱的格式，以及屬性欄位在 CSS、SwiftUI、Jetpack Compose 中的對應 |
| Plugin | `plugins/figloo/.claude-plugin/plugin.json`：`mcpServers` 指向對應版本 GitHub release 的 `.mcpb` |
| Marketplace | `.claude-plugin/marketplace.json`，名稱 `figloo` |
| MCP bundle | `pnpm package` 產生 `release/figloo-mcp-<version>.mcpb`，內含 `manifest.json`、單一檔案的伺服器與圖示 |
| 觸發評估 | `plugins/figloo/evals/`：四個該觸發、三個不該觸發的案例 |

## 驗證

| 項目 | 環境 | 結果 |
|---|---|---|
| 有無 skill 的實作比較 | 只有 token、元件與範例頁面的 HTML 範例專案，Opus，以 headless 的 `claude -p` 各實作同一個真實頁面一次 | 有 skill 時會自動選用、依區塊用 `query_snapshot` 取細節、用 Playwright 與截圖比對，並依 skill 的格式回報。第一版的 skill 反而沿用較少 token；把「對應到專案」一步改寫成每個顏色、文字樣式、間距與圓角都要經過 token，依專案慣例新增後，`var(--…)` 的使用由 66 次（無 skill）增為 100 次，頁面中的色碼由 29 個減為 12 個。兩邊的版面相近。Figma 分頁在背景，所以兩邊的匯出都失敗；之後在 skill 中補上「無法匯出的圖檔先放同尺寸的佔位並列入回報」 |
| `claude plugin validate --strict` | Claude Code 2.1.287 | plugin 與 marketplace 都通過 |
| 以本機 bundle 載入 plugin | `--plugin-dir`，`mcpServers` 指向 `pnpm package` 的 `.mcpb` | 伺服器 `plugin:figloo:figloo` 連上，12 個工具；skill 以 `figloo:figloo-implement` 出現。伺服器的工作目錄是使用者的專案，環境變數有 `CLAUDE_PROJECT_DIR` |
| 從 marketplace 安裝 | 暫時的本機 marketplace，local scope | 新的工作階段載入 plugin、MCP 伺服器與 skill；之後已移除 |
| 觸發評估 | `claude plugin eval --mocks off --ablation none`，Sonnet | 7 個案例各 3 次，21 次全部通過，約 0.85 美元。抽查的 trace 呼叫的是 plugin 的 `figloo:figloo-implement` |

## 已知限制

1. GitHub release 的 bundle 網址還沒有實測：repo 目前是 private，也還沒有附上 `.mcpb` 的 release。網址無法下載時，plugin 的 MCP 伺服器不會載入，只有 skill 可用，headless 模式不會顯示錯誤。
2. `claude plugin eval` 無法替以 bundle 宣告的伺服器提供替身，評估要加 `--mocks off`。
3. 手動註冊的 Figloo 伺服器與 plugin 的伺服器會同時執行，agent 會看到兩組工具；兩者會互相交接，不會衝突。
4. Codex 尚未實測：本機的 Codex CLI 0.149.1 不支援帳號預設的模型。
5. 實作比較每種設定只跑一次，樣本小，只作為方向。
