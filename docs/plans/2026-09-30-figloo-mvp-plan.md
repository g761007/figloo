# Figloo MVP 實作計畫

專案名稱：Figloo  
Repo：`figloo`  
狀態：規劃草案  
日期：2026-09-30

## 1. 目標與範圍

建立 Chrome extension 與本機 MCP，讓 coding agent 能偵測 Figma 設計稿分頁，以使用者選取元件為定位錨點，透過網頁 UI 探索附近元件並取得必要參數。

核心驗收情境：

> 使用者選取卡片內的按鈕，向 agent 說「實作這張卡片」。Agent 找到其所屬卡片，再取得標題、圖片與其他操作元件的資訊，全程不掃描整份文件。

已確定的限制：

- 僅透過 DOM 與網頁 UI 操作取得資訊。
- 不使用 Figma REST API、官方 MCP 或 Figma plugin。
- 不讀取內部 JavaScript store、WASM 記憶體或攔截私有資料協定。
- 安裝 extension、設定本機 MCP 並完成一次配對後，開啟設計稿即可自動連線。
- 任務描述留在 coding agent 對話中。
- 可以變更檢視與選取，不能修改設計內容。

MVP 暫以單一 Chrome profile、單一 agent 連線為範圍；支援多個 Figma 分頁，但每次操作必須指定分頁。

## 2. 使用流程

1. 本機 MCP 啟動，extension 自動連線。
2. Extension 識別已開啟的設計稿與讀取能力。
3. 使用者在 Figma 選取元件，extension 更新使用者錨點。
4. 使用者向 agent 描述任務。
5. Agent 取得錨點，建立本次探索 context。
6. 先查父層、同層或子層摘要，決定任務範圍。
7. 對必要元件取得詳細參數。
8. 任務需要更大範圍時，明確向外擴張。

不要求使用者每次點「傳送給 agent」。MCP 由 agent 主動呼叫，不假設客戶端能收到通知後自動執行任務。

## 3. 附近元件的定義

| 範圍 | 用途 | 優先序 |
|---|---|---|
| 父層與祖先 | 找到卡片、區塊或 frame | MVP 必要 |
| 同層 | 找到同容器內的其他元件 | MVP 必要 |
| 子層 | 展開已確定的任務範圍 | MVP 必要 |
| 視覺相鄰 | 找右側、下方或接近的元件 | 可行性驗證後加入 |

以結構關係為主要導航方式。視覺距離需要可信的畫布座標，不能拿圖層清單中 DOM 元素的位置代替。

「附近的所有元件」表示指定局部範圍內可分批完整列舉的元件，不代表一次傳送所有詳細屬性。

如果 UI 無法可靠列舉某個範圍，必須回報部分覆蓋，不能宣稱已找到全部。

## 4. 架構與技術選擇

```text
Coding agent
    ↕ MCP over stdio
本機 MCP 程序
    ├─ 分頁與 context 管理
    ├─ 查詢預算與結果整理
    └─ 本機 WebSocket bridge
             ↕
Chrome extension service worker
    ├─ 配對、心跳、重連
    ├─ 分頁路由
    └─ 操作排程
             ↕
Content script
    └─ Figma DOM adapter
         ├─ 使用者選取追蹤
         ├─ 圖層結構探索
         └─ 屬性面板讀取
```

建議使用 TypeScript、Chrome Manifest V3、Node.js 與官方 MCP TypeScript SDK。Node.js 與 SDK 版本在實作開始時選擇仍受支援版本並鎖定。

第一版將 MCP 與 WebSocket bridge 放在同一程序，減少安裝與維護成本。第二個程序若占用相同端點，回報明確錯誤；多 agent 共用 daemon 留待後續。

Repo 結構：

```text
apps/
  extension/
  mcp/
packages/
  protocol/
docs/
  plans/
  compatibility/
tests/
  fixtures/
  integration/
```

`protocol` 只共享通訊 schema、錯誤碼與資料型別，不提前建立通用瀏覽器自動化框架。

## 5. DOM 操作策略

先實測目前 Figma UI，再決定 selector 與支援範圍，不預先假設 DOM 具有完整節點樹。

定位優先使用語意標籤、role 與經驗證的屬性；必要的結構 selector 集中在 adapter 中。

允許的操作：

- 展開或收合圖層。
- 捲動局部圖層清單與屬性面板。
- 選取待讀取的圖層。
- 切換不修改內容的檢視區塊。

讀取時注意：

- 畫布由非傳統 DOM 方式渲染，設計值主要來自圖層與屬性 UI。
- 虛擬化清單只代表目前已載入部分，不代表完整子樹。
- 混合文字樣式、多選值與折疊屬性必須保留其狀態。
- DOM 能取得的 accessible name 可協助定位，但不能假設 content script 能直接取得完整瀏覽器 accessibility tree。
- 若必要操作依賴無法以一般 extension 完成的 trusted input，先記錄為阻塞點，不默默加入 debugger 權限或其他架構。

不得將 Figma 編輯器的 CSS 當作設計元件的 CSS，也不得將截圖推測值標示為精確參數。

## 6. 錨點與操作一致性

必須區分：

- **使用者錨點**：使用者主動選取的元件。
- **讀取游標**：extension 為取得參數而暫時選取的元件。

Extension 的自動選取不得覆寫使用者錨點。

Agent 建立探索 context 時，固定分頁、文件世代與錨點版本。這只固定定位依據，不宣稱整份設計資料已形成原子快照。

每個分頁一次執行一個 UI 操作序列。操作前後確認選取與面板結果一致；無法確認就回報歧義，不混合兩個元件的資訊。

使用者主動介入時：

1. 停止新的自動操作。
2. 中止目前探索並回報 `USER_INTERRUPTED`。
3. 更新使用者錨點。
4. 不強制切回舊選取。

正常結束時可嘗試恢復原選取與檢視；若使用者已介入，不再恢復。

重新整理、文件切換或無法驗證的結構變更，應使相關 context 與 reference 失效。

## 7. MCP 工具

| 工具 | 責任 |
|---|---|
| `get_status()` | Extension 連線、設計稿分頁、讀取能力與最近錯誤 |
| `get_anchor(sessionId)` | 取得使用者錨點並建立探索 context |
| `get_neighbors(contextId, ref, relation, cursor, limit)` | 列出父層、祖先、同層或直接子層摘要 |
| `inspect_nodes(contextId, refs, fields)` | 讀取指定元件的指定欄位群組 |
| `release_context(contextId)` | 釋放本次探索資料 |

`relation` 第一版支援 `parent`、`ancestors`、`siblings`、`children`。向外擴張就是對新取得的 reference 再查詢，不另設重複工具。

第一版不提供全文件搜尋、完整 HTML dump 或任意 JavaScript 執行工具。

元件摘要只包含：

- Reference、名稱與可確認的類型。
- 已確認的父子關係。
- 已知的子節點存在狀態。
- 已驗證可用的來源連結或節點識別。

Reference 優先使用 UI 可取得的穩定識別；否則採 context 內有效的 opaque reference。不能只靠名稱辨識同名圖層，也不能長期保存 DOM element handle。

## 8. 回傳資料與預算

詳細讀取依群組選擇，例如：

- `layout`：尺寸、Auto Layout、padding、gap、對齊。
- `typography`：文字內容及 UI 提供的字型資訊。
- `appearance`：填色、邊框、圓角、效果。
- `component`：UI 可見的 instance 與 variant 資訊。

每個欄位保留來源、觀測時間及狀態。狀態至少區分 `observed`、`mixed`、`not_exposed`、`unsupported`、`read_failed`。

建議初始預算，待實測調整：

| 項目 | 預設 |
|---|---|
| 周邊列舉 | 每批 20 個摘要，單次上限 50 |
| 詳細讀取 | 每次最多 5 個元件 |
| 自動遞迴 | 關閉 |
| 工具結果 | JSON payload 上限 32 KiB |
| UI 操作時間 | 每次最多 15 秒，可取消 |

預算必須同時限制 UI 探索與輸出，不能先遍歷全部再截斷。

結果附帶 `coverage`、`hasMore`、`nextCursor` 與 `stopReason`。未知是否還有資料時，不能回報 `hasMore: false`。

局部索引只保存已探索區域；遇到過期資訊需重新驗證。不得在背景預先掃描整份文件。

## 9. 連線與診斷

本機服務只監聽 loopback。Extension 主動連線，使用配對 token、來源檢查、協定版本與訊息 schema 驗證。

Token 保存在 extension 背景端，不交給 Figma 頁面。網頁內容只能作為資料，不能產生任意本機指令。

至少區分：

- `DISCONNECTED`：未收到 extension 握手，不直接判定為未安裝。
- `NO_DESIGN_TAB`：已連線但未找到設計稿。
- `LOADING`：分頁存在，UI 尚未就緒。
- `READY`：已完成實際小型讀取探測。
- `DEGRADED`：部分欄位或操作不可用。
- `INCOMPATIBLE`：目前 DOM 無法可靠辨識。

必須處理瀏覽器休眠、service worker 重啟、MCP 重啟、分頁關閉及訊息逾時。舊 request 的晚到結果不得寫入新 context。

## 10. 實作里程碑

| 階段 | 工作 | 通過條件 |
|---|---|---|
| M0 可行性 | 在真實 Figma 頁面驗證選取、局部圖層導航與屬性讀取 | 從按鈕找到父容器與同層元件；能讀基本屬性；不使用禁止的資料來源 |
| M1 連線閉環 | Extension、配對、WebSocket、MCP、分頁狀態 | 安裝與設定後可自動連線，重啟可恢復，正確回報各分頁能力 |
| M2 局部探索 | 錨點、context、reference、周邊列舉與分頁 | 核心卡片情境成功；同名元件不誤配；不進行全文件掃描 |
| M3 精準讀取 | 欄位群組、來源狀態、預算、取消與過期處理 | 結果與 UI 一致，資料不混用，缺失不偽造 |
| M4 交付 | 真實整合驗收、安裝文件與可安裝產物 | 新環境依文件完成安裝，至少一種 MCP client 跑通完整流程 |

M0 是必要關卡。若 DOM 無法滿足核心情境，交付可重現證據與能力缺口，再討論範圍；不得自行改走 REST API、plugin 或私有內部物件。

M0 同時確認並記錄支援的 Chrome 版本、Figma UI 語言、編輯／唯讀模式。未測試組合標示為未驗證。

## 11. 驗收與測試

以真實 Figma 操作驗證核心能力，再使用去識別化 DOM fixture 測試解析與回歸。Mock 測試通過不能取代真實頁面驗證。

必要案例：

1. 選取卡片內按鈕，找到正確父卡片與相關元件。
2. 多個同名按鈕不會交叉定位。
3. 折疊與虛擬化清單可續查；未完整讀取時正確標示。
4. 多個 Figma 分頁並存，操作不跨分頁。
5. 自動讀取切換選取，不污染使用者錨點。
6. 使用者中途點選、切檔或關閉分頁，操作立即失效或中止。
7. 混合文字樣式、無法取得的欄位與唯讀限制不產生假值。
8. 超過節點、時間或輸出預算時停止，提供續查資訊。
9. Extension／MCP 重啟與瀏覽器恢復後，不沿用失效 reference。
10. 未配對來源、錯誤 schema 與重複 request 不造成未授權操作。

核心情境在已宣告支援的環境重複執行 10 次，均不得定位錯誤或混用元件資料。

記錄查詢過的局部範圍、UI 操作數、耗時及輸出 bytes，用以證明沒有全文件遍歷，並調整預算。預設記錄不包含完整設計內容。

## 12. 交付項目

- Chrome extension 可載入產物。
- 本機 MCP 可執行套件。
- 安裝、配對、agent 設定與診斷文件。
- MCP 工具契約與錯誤碼。
- 相容性矩陣及已知限制。
- 真實 Figma 驗收紀錄與回歸 fixtures。

後續再評估視覺相鄰搜尋、預覽截圖、多選錨點、多 agent 共用服務，以及 Chrome Web Store 發布。

## 技術依據

Figma 說明其畫布並非以傳統 HTML／DOM 渲染，因此本案將圖層與屬性 UI 作為資料來源；是否足以支援局部完整探索仍須實測。[Figma 畫布與可及性](https://www.figma.com/blog/building-accessibility-into-a-canvas-based-product/)

Extension 使用 content script 與 service worker 分工；WebSocket 的生命週期與恢復策略依 Chrome 官方機制實作。[Content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)、[WebSocket 支援](https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets)

Agent 與本機程序採標準 MCP stdio transport；extension bridge 是獨立的內部通訊協定。[MCP transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
