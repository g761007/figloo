# `map_tokens` 與 skill 的工作流程評估

狀態：完成，0.6.0
日期：2026-10-07
依據：[v0.6.0 計畫](../plans/2026-10-07-v0.6.0-design-intelligence.md)

## 內容

- `map_tokens` 讀一份快照的設計值，掃描專案目錄中有名稱的 token 定義，把每個顏色、文字樣式、間距與圓角，對到專案的 token：完全相同、相近（附差在哪裡），或沒有對到；也依 instance 名稱列出字詞相同的專案元件。
- 支援的格式：
  - Web：CSS 自訂屬性、SCSS 與 Less 變數、design token JSON（含 `$value`）、JavaScript 與 TypeScript 的主題物件（例如 Tailwind 設定）。
  - iOS：asset catalog 的 colorset、Swift 的 `Color`、`UIColor` 與 `Font`。
  - Android：`colors.xml`、`dimens.xml`，以及 Compose 的 `Color`、`dp` 與 `TextStyle`。
  - Flutter：`Color` 與 `TextStyle`。
- 比對規則：
  - 顏色：RGB 相同且透明度相同算完全相同；只差透明度，或 Lab 色差在 4 以內（約 2.3 是剛好看得出的差異），算相近。Android、Compose、Flutter 的 8 位 hex 是透明度在前。
  - 間距與圓角：數值相同算完全相同，差 1 px 以內算相近；名稱表示間距或圓角的 token 排在前面。
  - 文字樣式：比對字級與字重，不比對字型名稱。token 沒寫字重時算相近，並註明「這個 token 沒有設定字重」，以免 agent 以為字重也對上了。
- 掃描只讀專案目錄（或其中的 `path`），略過相依套件、建置輸出、隱藏資料夾、測試檔與 `.env`，最多 20,000 個檔案、15 秒。
- figloo-implement 的第 5 步改為先呼叫 `map_tokens`：完全相同的直接用，相近的與沒對到的先給使用者看再決定；回報附上對應表。

## 驗證

| 項目 | 結果 |
|---|---|
| 單元測試 | 四種平台各一個小型 fixture 專案，測試每種格式的擷取、完全相同與相近的判斷、只差透明度、字重不同、元件候選，以及略過相依套件、隱藏資料夾、測試檔與 `.env`（這些在測試中加到暫存的副本，因為 git 會忽略它們）。另以 MCP 端到端測試 `map_tokens`、`path` 與專案外的路徑被拒絕。MCP 154 項全部通過 |
| 掃描速度 | 以這個 repo 為例，127 個檔案約 0.1 秒 |
| 工作流程評估 | 見下一節 |

## 工作流程評估

- `claude plugin eval` 的假回應只能取代以設定或 `.mcp.json` 宣告的伺服器。實測的錯誤訊息說明，以 MCP bundle 宣告的伺服器無法取代，而正式的 plugin 正是用 bundle 發佈。
- 因此新增不發佈的測試外殼 `tests/skill-eval/`：同名的 plugin，以 symlink 連到同一份 skill，在 `.mcp.json` 中宣告伺服器。它的工具清單 `_tools.json` 由伺服器產生並由測試核對；第一次執行時沒有這份清單，agent 看到的是沒有說明的寬鬆 schema，呼叫 `snapshot_layer` 時少了 `contextId`，被假回應的參數檢查中止。
- 案例「實作選取的畫面」以假回應提供 `get_status`、`get_anchor`、`snapshot_layer`、`map_tokens` 等工具，檢查 skill 有觸發、`get_status` 在 `snapshot_layer` 之前、`snapshot_layer` 在 `map_tokens` 之前，並由評審模型判斷最後的回覆是否把相近與沒對到的值拿出來問使用者。新版 skill 一次執行全部通過，評審三票 PASS，約 0.11 美元。
- 換回 0.6.0 之前的 skill 也全部通過：`map_tokens` 的工具說明本身就要求先比對、並把相近的值給使用者看。所以這個評估守的是整體工作流程（跳過 `get_status`、不拍快照、悄悄採用相近的 token 都會失敗），不能證明 skill 第 5 步的改寫是必要的。

## 未驗證

- 在使用者真實的專案上執行 `map_tokens`。fixture 專案涵蓋常見寫法，真實專案的 token 寫法可能不同，例如以函式產生的主題、分成多個檔案的 Swift 擴充，或 Kotlin 的 `Color(red = …)`。
- 原有的 trigger 評估沒有重跑。skill 的 description 沒有改變，所以觸發條件應該不受影響。
- 評估只跑了一次；模型的行為有隨機性。
