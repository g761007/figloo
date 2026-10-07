# 安裝與設定 Figloo

[English](installation.md) | 繁體中文

> 本文件譯自英文版 [installation.md](installation.md)，兩者不一致時以英文版為準。

README 的[快速開始](../README.zh-TW.md#快速開始)會請 coding agent 代你完成這些步驟；這一頁是手動的版本。開始之前，請先確認[需求](../README.zh-TW.md#需求)。

## 安裝

### 使用 release 檔案

`pnpm package` 會在 `release/` 產生三個可以交給其他人的檔案：

| 檔案 | 用法 |
|---|---|
| `figloo-extension-<version>.zip` | 解壓縮到一個會保留的資料夾，瀏覽器會從那裡載入擴充功能。 |
| `figloo-mcp-<version>.mjs` | 放在任何位置都可以。它就是完整的 MCP 伺服器，只需要 Node.js 24。 |
| `figloo-mcp-<version>.mcpb` | 同一個伺服器的 MCP bundle。Claude Code plugin 會從對應版本的 GitHub release 下載它，所以要附在那個 release 上。 |

接著依照[設定](#設定)的步驟進行，把原始碼中的路徑換成解壓縮後的資料夾與 `.mjs` 檔案。

### 從原始碼

```sh
pnpm install
pnpm build
```

`pnpm build` 會依相依順序建置 workspace 中的套件。請在 `typecheck` 與 `test` 之前執行，因為另外兩個套件會使用 `@figloo/protocol` 的建置結果。pnpm 可能會提示略過了 esbuild 的建置腳本，建置並不需要它。

## 設定

### 1. 載入擴充功能

1. 開啟 `chrome://extensions`（或 `arc://extensions`），打開「開發人員模式」，再按「載入未封裝項目」（Load unpacked）。
2. 選擇 `apps/extension/dist`，或 release 檔案解壓縮後的資料夾。

擴充功能的 ID 由 `apps/extension/static/manifest.json` 的 `key` 欄位固定，所以在每台電腦上都相同（`offikfnknfkgijgianpfcghbccmkcjnb`）。本機伺服器只接受這個 ID 的連線。

擴充功能會要求存取所有網站（`<all_urls>`），因為 Chrome 只允許具備這項權限的擴充功能，在使用者沒有點擊圖示的情況下截取分頁畫面。它的 content script 仍然只在 Figma 設計稿中執行。

`export_asset` 會在頁面內接收 Figma 匯出的檔案：每次匯出期間，擴充功能會包住 Figma 用來開始下載的函式，取得檔案後再放回原本的函式，所以瀏覽器不會存下任何檔案。`downloads` 權限只用於備援：無法在頁面內取得檔案時，擴充功能會等候瀏覽器自己下載這次的匯出，並回報存檔位置。

更新 Figloo 後，請執行 `pnpm build`，再按擴充功能卡片上的重新載入按鈕，讓瀏覽器載入新檔案與新的權限。

### 2. 在 agent 中註冊 MCP 伺服器

使用 Claude Code 時，Figloo plugin 會一併安裝 MCP 伺服器與 [figloo-implement skill](../README.zh-TW.md#figloo-implement-skill)：

```text
/plugin marketplace add g761007/figloo
/plugin install figloo@figloo
```

Plugin 會從對應版本的 GitHub release 下載伺服器的 bundle，所以你的電腦要能存取那個 release。如果之前手動註冊過 Figloo，每個工作階段都會同時執行兩個 Figloo 伺服器，請用 `claude mcp remove figloo -s user` 移除手動的註冊。

不使用 plugin 時，註冊一次就能用在所有專案，之後請開一個新的工作階段：

```sh
claude mcp add -s user figloo -- node /absolute/path/to/figloo/apps/mcp/dist/index.js
```

使用 release 檔案時，改用它的路徑，例如 `node /absolute/path/to/figloo-mcp-0.5.0.mjs`。在工作階段中，`/mcp` 會顯示伺服器是否已連線。

其他 MCP client 可以用類似下面的設定啟動伺服器（請替換路徑）：

```json
{
  "mcpServers": {
    "figloo": {
      "command": "node",
      "args": ["/absolute/path/to/figloo/apps/mcp/dist/index.js"]
    }
  }
}
```

`snapshot_layer` 最多可能需要三分鐘。Claude Code 的預設值等得夠久；如果你設定了 `MCP_TOOL_TIMEOUT` 或 `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`，請設在 200000 毫秒以上。Codex 預設在 60 秒後停止工具呼叫，所以請在 `~/.codex/config.toml` 中為 Figloo 調高 `tool_timeout_sec`：

```toml
[mcp_servers.figloo]
command = "node"
args = ["/absolute/path/to/figloo/apps/mcp/dist/index.js"]
tool_timeout_sec = 300
```

伺服器透過 stdio 使用 MCP，並在同一個程序中監聽 `ws://127.0.0.1:47129`，等候擴充功能連線。要改用其他連接埠，請設定 `FIGLOO_PORT`，或修改設定檔中的 `port`。連接埠被其他程式占用時，`get_status` 會回報，伺服器不會因此當掉。

多個 agent 工作階段可以輪流使用 Figloo。每個工作階段各自啟動一個伺服器，同一時間由其中一個，也就是持有者，監聽連接埠並服務擴充功能，其他的則待命。待命的工作階段呼叫需要 Figma 的工具時，會在持有者閒置 10 秒後接手。持有者正在工作時，工具會回報 `BUSY`，並寫出 Figloo 正在服務的工作階段。持有者結束後，待命的工作階段會在幾秒內自動接手。工作階段以 agent、專案資料夾與啟動時間命名，例如 `Claude Code · shop (started 09:15)`；`get_status`、工具列圖示、popup 視窗與選項頁面都會顯示 Figloo 正在服務哪一個。Figloo 0.1.0 的伺服器無法交接，仍在執行它的工作階段需要重新啟動。

### 3. 配對一次

```sh
node apps/mcp/dist/index.js pair
```

使用 release 檔案時，執行 `node figloo-mcp-<version>.mjs pair`。

這會印出存在 `~/.figloo/config.json` 中的配對 token 與連接埠。這個檔案在第一次執行時建立，權限為 0600，也可以用 `FIGLOO_CONFIG_DIR` 指定其他目錄。開啟擴充功能的選項頁面，貼上這兩個值，再按「Save and connect」。之後只要 MCP 伺服器在執行，擴充功能就會自動連線，任一方重新啟動後也會重新連線。

`node apps/mcp/dist/index.js doctor`（或 `node figloo-mcp-<version>.mjs doctor`）隨時可以檢查 Node.js、設定檔，以及連接埠由誰持有，不會啟動伺服器。

### 4. 準備 Figma

- 在裝了擴充功能的瀏覽器中登入 Figma。對檔案有檢視權限就夠了。
- 使用 Figma 的英文介面，並保持介面展開：Cmd+\ 可以切換，縮到最小的介面會隱藏圖層面板。
- 在 Main menu、Preferences、Accessibility settings 中打開「Adapt content for screen readers」。這樣截圖就能依圖層在畫面上的位置裁切，`get_visual_neighbors` 能得知圖層的位置，截圖後 Figloo 也能還原你的縮放比例與畫面位置。
- Agent 工作期間，請讓 Figma 分頁留在畫面上，放在 agent 視窗旁邊就可以。Figma 在背景分頁中會忽略選取與展開，所以 Figloo 會回報 `TAB_IN_BACKGROUND`，不會自行猜測。頁面快照則會等待：分頁在背景時暫停，回到畫面後繼續。
