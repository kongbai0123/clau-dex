# 版本紀錄

## Unreleased

### 修正
- **Agent 管理統一框架**：三個提供者共用精簡總覽、狀態規則與情境式操作；詳細資料分為執行與登入、桌面 App、進階診斷。管理頁不再重複顯示全域觀察面板。
- **狀態與操作一致**：聊天室 gate、Agent 選項及系統摘要共用純函式；管理頁顯示檢查時間及實際執行紀錄，前往聊天室僅建立所選 Agent 的對話，不自動呼叫模型。
- **刷新與額度查詢分開**：本機狀態刷新不發出模型請求，Claude 額度更新改用明確標示用量的操作入口；保留原有啟動時快取更新行為。
- **Antigravity 可用狀態呈現**：分開顯示 CLI 能力與憑證觀測；CLI 可用時顯示綠色「CLI 可用」，不冒稱已驗證登入。App 管理補上 CLI 位置與失敗原因，並驗證缺少 CLI／恢復可用時的傳送按鈕狀態。
- **Antigravity 用量呈現**：用量面板納入工作台 Antigravity 任務實際回報的 token；方案額度明確標示「暫不支援查詢」，不以無資料推斷 Agent 無法使用。
- **畫面依勾選的 AI 呈現**：空白對話的歡迎文字（不再顯示 Agent 圖示）與輸入框提示改為依「參與的 AI」顯示。
- **接手說明與實際派工一致**：只有 Codex／Claude 會被描述為可接手統籌與複核；Antigravity 標示為只承接執行步驟，沒有其他統籌者時說明任務會暫停。
- **文字不再只寫兩方**：頁面描述、對話區無障礙標籤、歷史紀錄說明、思考強度錯誤訊息改用通用或 provider 名稱；Electron App 名稱改為 Clau-dex。
- **smoke 修正**：`app.js` 改以 module 載入後，`electron-smoke` 不再呼叫全域 `showToast`；聊天功能 smoke 新增上述畫面的回歸檢查。
- **日常環境驗證**：排查文件補上同一路徑在測試程序與日常 Bridge 中可見性不同的情況；必須在日常啟動環境確認 CLI 與執行 live smoke。

### 新增
- **畫面依 provider 註冊表產生**：思考強度滑桿、配色、圖示、額度與 Token 列、圖片限制提示都改由 `src/providers.js` 產生，新增或移除 AI 不必修改 `ui/`；新增 `test/provider-ui.test.js` 防止畫面再寫死個別 AI。說明見 [Agent 管理](docs/agent-management.md#新增或移除-ai)。
- **Antigravity 思考強度**：依官方 `agy --effort`（low／medium／high／xhigh／max）新增可調整的滑桿；「預設」不傳參數，沿用 CLI 自己的設定。設定與 Codex／Claude 一樣隨對話與上次 Agent 設定保存。
- **沿用上次 Agent 設定**：自動保存 Agent 組合、統籌與思考強度，重新啟動及新對話可沿用；啟動仍重新探測 CLI，不以桌面 App 是否開啟決定任務可用性，也不自動開啟提供者 App。
- **Antigravity 文字任務**：接入官方 `agy` headless CLI，可單獨執行或接受 Codex／Claude 協作指派；Antigravity 不擔任統籌或複核。
- **CLI 能力檢查**：支援 Windows 官方預設安裝目錄 `%LOCALAPPDATA%\agy\bin`，並檢查必要 headless 參數，避免把只能開啟 App 的啟動器當成任務 CLI。
- **結果協定與清理**：以 stream-json 傳送與解析，只有正常退出、唯一最終 `SUCCESS`、非空回覆且沒有權限拒絕才視為成功；取消、逾時及關閉會清理自有 CLI 程序樹。
- **真實 smoke**：新增 Antigravity 聊天室回覆標記、隔離 fixture 檔寫入及取消／關閉清理的手動檢查；會發出模型請求並使用真實帳號用量。

### 權限與限制
- 使用 `--mode accept-edits` 允許工作資料夾內的檔案編輯，保留 `--sandbox` 與命令工具權限，不加入 `--dangerously-skip-permissions`；最終 `denied_actions` 非空時明確失敗。實際終端沙箱隔離取決於平台支援。
- 憑證項目仍採三態、`authenticated:null`；不以本機項目取代線上任務驗證。
- 暫不支援 Antigravity 圖片或工具層受限的唯讀複核，遇到這些輸入會明確拒絕。

## 0.3.1 — 2026-10-28

### 修正
- **App 存活判斷**：盤點只把各 App 的 GUI 主程序當作根程序，排除 Chromium 子程序（`--type=`）、以 Node 模式執行的側車，以及經由其他程序重新執行同一執行檔的側車（依完整父程序鏈判斷）。
- **啟動後立即結束**：啟動後會再等待約 3 秒，核對同一根程序（PID 與建立時間）仍存在，才視為成功；否則回報「啟動後立即結束」，不再誤報成已開啟或已由本程式管理。
- **Antigravity 登入狀態**：改為三態顯示 Windows 認證管理員中的 `gemini:antigravity` 項目（已偵測／未偵測／無法確認），不論是否安裝 `agy`。項目存在只代表本機有紀錄，不代表 session 仍有效，因此狀態顯示為「有效性未驗證」。
- **`cmdkey` 解碼**：依系統 OEM code page 解碼後再精確比對 Target 欄位，避免繁體中文環境漏判。

### 變更
- **Antigravity 登入一律開啟 App**：按「開啟 Antigravity／重新登入」會開啟桌面 App，由 App 處理 Google 登入；已有憑證項目時仍保留重新登入入口。等待期間持續核對 App 根程序，App 中途結束會立即回報，不必等 5 分鐘逾時。
- 新增 [Antigravity 啟動與登入排查](docs/antigravity-startup.md)。

### 已知限制
- Antigravity 仍不能接聊天室任務；`agy` 的 headless 執行整合尚未驗證。
- Bridge 不會修改 ACL、安全軟體或沙箱設定，也不會在啟動失敗時自動加入停用沙箱的參數。

### 排查紀錄
- 某台 Windows 主機上，Antigravity 2.27.0 啟動不到 1 秒即退出，GPU 子程序連續崩潰。對照後確認，原因是安裝目錄缺少 `S-1-15-2-2`（ALL RESTRICTED APPLICATION PACKAGES）的讀取／執行權限。只補上這項權限即恢復正常，ESET 與 GPU／renderer 沙箱都維持啟用。
- 先前「可能是 ESET 或顯示卡驅動」的推測未經對照驗證，已更正。

## 0.3.0 — 2026-10-28

- 引導式登入：Codex／Claude 未登入時可直接開啟 CLI 官方登入流程，完成後自動更新狀態。
- 「參與的 AI」改為多選；規劃、指派與額度接手只在已勾選的 AI 之間進行。
- 新增 provider 註冊表（`src/providers.js`）；App 管理加入 Antigravity，並改為單欄排列。
- 略過指向已不存在執行檔的開始功能表捷徑。
- 啟動器不再留下命令列視窗；`launch.ps1` 會建立直接啟動 Electron 的 `Clau-dex.lnk`。

## 0.2.0

- 初版 Clau-dex 桌面協作管理器。
