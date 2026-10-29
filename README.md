# Clau-dex：Codex × Claude Code 本機協作管理器

Clau-dex 是一款 Windows 桌面應用，讓 Codex CLI、Claude Code CLI 與 Antigravity CLI 共用聊天室、協作執行任務，並透過本機 MCP 服務連接 Codex。它沿用你已登入的 CLI 帳號，對話紀錄保存在本機。

## 安全須知

請在信任的電腦和工作資料夾中使用，並在執行前備份重要資料或使用 Git 管理變更。

- Codex 一般任務使用 `--sandbox danger-full-access` 與 `--ask-for-approval never`；Claude Code 使用 `--permission-mode bypassPermissions`。這兩個 Agent 可依目前 Windows 帳號的權限讀寫檔案及執行指令，也可能觸及選定工作資料夾以外的路徑。
- Antigravity 文字任務使用官方 `agy` headless 介面與 `--mode accept-edits`，允許工作資料夾內的檔案建立／編輯；傳入 `--sandbox`，命令執行仍遵循 CLI 工具權限，沒有使用 `--dangerously-skip-permissions`。需要互動核准的工具可能被 soft-deny；Bridge 會把最終結果列出的權限拒絕判為失敗。`--sandbox` 的實際隔離能力取決於平台支援，詳見 [Antigravity 排查文件](docs/antigravity-startup.md)。
- Codex／Claude 唯讀複核模式會使用受限工具與唯讀沙箱。Antigravity 暫不支援工具層受限的唯讀複核，會明確拒絕該模式。
- MCP 服務只監聽 `127.0.0.1`，但**沒有驗證 token 或使用者身分**。Host／Origin 檢查不等於驗證；同一台電腦上的其他程式仍可呼叫服務。管理器開啟期間，請勿執行不受信任的本機程式。
- 送出的訊息、工作資料與圖片會交由已登入的 CLI 傳送至相應服務。Bridge 不會自行保存 Codex 或 Claude 的登入憑證。

## 主要功能

- **共用聊天室**：依工作資料夾分開保存對話，支援續問、取消執行與歷史對話。
- **多 Agent 協作**：在對話選項的「參與的 AI」中，可以複選要納入的 AI。只選一個時，由它直接回覆；選兩個以上時，由 Codex 或 Claude 統籌、指派與複核，Antigravity 可承接文字任務。若某方額度用盡，會由其他已勾選且能擔任該角色的 AI 接手。
- **圖片輸入**：Codex／Claude 支援貼上、選檔、拖放與圖片續問；包含 Antigravity 的任務目前會明確拒絕圖片輸入。
- **觀察面板**：查看 CLI 狀態、用量、對話進度、Token 統計與程序資訊。
- **Agent 管理**：同屏比較三個 Agent 的 CLI、登入觀測與最近執行結果；詳細資料統一分為執行與登入、桌面 App、進階診斷。
- **沿用上次 Agent 選擇**：Agent 組合、統籌方與思考強度會自動儲存，下次開啟預填；舊對話保留各自設定。啟動時重新檢查 CLI，沿用 CLI 保存的有效登入，不會自動開啟三個 AI 桌面 App。
- **引導式登入**：Codex／Claude 由 CLI 開啟官方登入流程，完成授權後更新狀態。Antigravity 一律開啟 App 登入，並保留重新登入入口；Bridge 只觀察本機憑證項目是否存在，不讀取其內容，也不把項目存在當作有效帳號驗證。
- **Codex MCP 整合**：提供 `check_bridge` 與 `delegate_to_claude` 工具。

## 系統需求

執行任務時只需開啟 Clau-dex，各 AI 桌面 App 可以保持關閉。Clau-dex 會按需啟動已安裝的 CLI 去呼叫雲端服務；重新登入時才進入各提供者的官方授權流程。Clau-dex 關閉時，管理服務與受管任務會依原有行為停止。

Antigravity 的「CLI 可用」表示本機能力檢查通過；登入憑證另列，不會將舊憑證視為已驗證登入。Agent 管理會顯示 CLI 路徑與錯誤原因。用量面板包含工作台任務回報的 Antigravity token；方案額度暫不支援查詢。若另一個終端機可用、畫面卻仍顯示不可用，請依[日常環境排查](docs/antigravity-startup.md)確認安裝確實可供日常 Bridge 程序讀取。

- Windows
- Node.js 22.12.0 以上與 npm
- 依選用的 Agent 安裝並登入 Codex CLI、Claude Code CLI 或官方 Antigravity CLI（`agy`）

可以在 Agent 管理按「登入」，也可以自行執行登入指令：

```powershell
codex login
claude auth login
```

Antigravity（Google）可透過官方 `agy` CLI 單獨執行文字任務，也可接受 Codex／Claude 協作指派；它不擔任統籌或複核。本次使用 Google 簽章的 `agy 1.4.9`，已收到真實 headless `SUCCESS` 結果與指定回覆標記。請依 [官方安裝說明](https://antigravity.google/docs/getting-started?tab=cli) 安裝；Windows 預設位置為 `%LOCALAPPDATA%\agy\bin`。Bridge 會檢查 `--help` 是否具有必要的 headless 參數，只有能執行版本查詢的 App 啟動器不足以通過檢查。

Bridge 仍以三態顯示 Windows 認證管理員的 `gemini:antigravity` 項目：已偵測、未偵測或無法確認，`authenticated` 保持 `null`。項目存在不代表 session 仍有效；當次模型請求成功才是當次可用的證據。不論是否安裝 `agy`，登入入口都會開啟 Antigravity App，已有項目時也能重新登入。任務協定、權限限制與驗證方式見 [Antigravity 啟動、登入與任務排查](docs/antigravity-startup.md)。

## 安裝與啟動

先複製專案：

```powershell
git clone https://github.com/kongbai0123/clau-dex.git
cd clau-dex
```

### 使用 Codex MCP 整合

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\setup.ps1
.\launch.ps1
```

`setup.ps1` 會在缺少套件時安裝 npm 依賴與 Electron，將協作技能複製到 `%CODEX_HOME%\skills\codex-claude-bridge`，並在 Codex 註冊 `http://127.0.0.1:47931/mcp`。它也會在 Codex 使用者設定中將此 MCP 工具逾時設為 660 秒（11 分鐘）。執行前須先安裝 Codex CLI；此腳本會修改目前使用者的 Codex 設定。

管理器啟動後，重新啟動 Codex，讓它載入新註冊的 MCP 工具。需要 Claude 委派功能時，Claude Code CLI 也須已安裝並登入。

### 只啟動桌面管理器

若不需要 Codex MCP 整合，可自行安裝依賴並啟動，不會執行 `setup.ps1` 的 Codex 設定步驟：

```powershell
npm install
node node_modules\electron\install.js
.\launch.ps1
```

也可執行 `npm run desktop`，或雙擊 `啟動管理器.cmd`。再次啟動會切換至既有管理視窗。

執行過一次 `launch.ps1` 後，專案資料夾中會出現 `Clau-dex.lnk` 捷徑。它直接啟動 Electron，完全不會出現命令列視窗，可以把它釘選到開始功能表或工作列。`啟動管理器.cmd` 則會在交給 Electron 後立即關閉命令列視窗。

## 使用方式

### 對話與協作

- 可選擇工作資料夾，普通資料夾即可，不需要建立 Git repository。也能在訊息中指定其他工作路徑。
- 每個工作資料夾有自己的聊天室；對話與任務紀錄保存在本機。續問會帶入最近的對話內容，上限為 16,000 字元。
- 協作流程包括規劃、執行、複核與修正。每項需求會拆成 1 至 4 個執行步驟，未達標時最多退回修正 2 輪。
- 一方回報額度用盡時，可由另一方接手目前階段；短暫網路錯誤或登入問題不會視為額度用盡。兩邊都無法繼續時，可保留進度並在額度恢復後接續。
- 一般任務預設逾時為 60 分鐘，可用 `AGENT_HUB_TIMEOUT_MS` 調整，最高為 24 小時；可隨時停止，取消後已完成的檔案修改會保留。畫面顯示 CLI 已回覆，不代表任務內容已正確，請依實際檔案確認結果。

### 圖片

| 項目 | 限制 |
| --- | --- |
| 格式 | PNG、JPEG、WebP |
| 每則訊息 | 最多 8 張 |
| 單張大小 | 最多 7 MiB |
| 總大小 | 最多 20 MiB |

續問時會優先保留目前訊息的圖片，再加入前文圖片；超出限制的舊圖片不會傳入，並會告知 Agent。

Antigravity 目前只支援文字任務。包含 Antigravity 的任務若帶有本次或前文圖片，會明確拒絕，不會靜默移除圖片後假裝已處理。

### 觀察面板與用量

面板可查看 Codex／Claude 的方案額度、今日 Token、任務進度與耗時、程序 PID、CLI 登入狀態及橋接服務狀態。面板與對話統計分開顯示。

用量資料來自本機 CLI 紀錄，包括 `~/.codex/sessions`、`~/.claude/projects`，或環境變數 `CODEX_HOME`、`CLAUDE_CONFIG_DIR` 指定的位置。Bridge 不讀取或保存提供者憑證。為更新 Claude 額度，管理器在快取超過 5 分鐘時會發出一次短查詢；用量面板的「更新 Claude 額度（使用少量用量）」也會使用少量模型用量；Agent 管理的「重新檢查」及頂部狀態刷新只檢查本機狀態，不發出模型請求。每 20 秒的背景狀態更新只讀取本機紀錄與快取，不會發出模型查詢。

### 本機資料

對話、圖片附件、任務紀錄、設定與執行資料保存在專案的 `.bridge/` 目錄。此目錄已加入 `.gitignore`，不會由一般 Git 加入操作提交。分享或提交專案前，仍應檢查暫存清單，確認沒有加入使用者資料。

## Codex MCP 整合

`setup.ps1` 註冊的工具為：

- `check_bridge`：檢查 Claude Code CLI 的安裝與登入狀態。
- `delegate_to_claude`：把工作交給 Claude Code；`workspace` 接受工作資料夾的絕對路徑，`mode` 可設為 `implement` 或唯讀的 `review`，預設為 `implement`。

Codex MCP 的工具逾時為 660 秒。桌面聊天室中的一般任務最長可執行 60 分鐘，但 MCP 呼叫可能在 11 分鐘後先逾時；較長任務請直接在桌面聊天室執行。

桌面管理器使用 HTTP MCP 以便管理服務生命週期。`npm start` 保留 stdio MCP 相容入口。管理器關閉時，本機 MCP 服務也會停止；重新開啟管理器即可恢復。

## 疑難排解

- **CLI 顯示尚不可用**：觀察面板的「系統」頁會顯示實際 CLI 路徑與錯誤。程式會先檢查啟動環境的 PATH，再搜尋 Windows 常見安裝位置。若設定 `AGENT_HUB_CODEX_COMMAND`、`AGENT_HUB_CLAUDE_COMMAND` 或 `AGENT_HUB_ANTIGRAVITY_COMMAND`，指定指令會優先使用；若找不到，不會改用其他安裝。
- **按「登入」後畫面沒有更新**：Codex／Claude 完成瀏覽器授權後，若登入視窗沒有自動關閉，請手動關閉。Antigravity 請在 App 內確認帳號；Bridge 只能偵測憑證項目，不驗證其有效性。等待期間會監看 App 根程序身分，若 App 中途結束會回報原因，不必等到 5 分鐘逾時。完整操作見 [Antigravity 啟動與登入排查](docs/antigravity-startup.md)。
- **Antigravity CLI 不具備必要介面**：依官方說明安裝或更新 `agy`，再重新整理；Bridge 需要 stream-json 輸入／輸出、逾時與沙箱等參數。Windows 會搜尋 PATH 與官方預設安裝位置，明確指定的 `AGENT_HUB_ANTIGRAVITY_COMMAND` 不會自動改用其他安裝。
- **Antigravity 工具權限被拒絕**：Bridge 會將最終 `denied_actions` 判為失敗，即使 CLI 宣告 `SUCCESS`。檔案建立／編輯使用 `accept-edits` 模式；shell 命令仍可能需要 CLI 權限規則，請依官方權限說明設定授權範圍，並確認實際執行結果。
- **Antigravity 啟動後立即結束或出現 GPU 錯誤**：先備份 ACL，依同版本、同參數進行權限對照；不要僅憑舊 dump 或錯誤文字就認定是 ESET／驅動。已驗證的限定範圍修復與復原方式見 [排查文件](docs/antigravity-startup.md)。
- **連接埠 47931 已被占用**：先關閉另一個管理器，再重新啟動。
- **MCP 工具沒有出現在 Codex**：確認管理器正在執行，並在 `setup.ps1` 完成後重新啟動 Codex。

## 開發與檢查

```powershell
npm test
npm run check
```

`npm test` 執行 Node.js 自動化測試；`npm run check` 檢查應用程式 JavaScript 語法。桌面 smoke 檢查需以 Electron 執行，報告與截圖會寫入 `.bridge/`：

| 指令 | 驗證內容 |
| --- | --- |
| `npx electron test/electron-smoke.mjs` | 傳送流程、IPC、取消任務與關閉清理 |
| `npx electron test/electron-chat-features-smoke.mjs` | 剪貼簿貼圖、選檔、拖放、圖片續問與對話刪除 |
| `npx electron test/electron-usage-smoke.mjs` | 用量面板在正常、零值、不完整及缺少資料時的顯示 |
| `npx electron test/electron-cli-smoke.mjs` | CLI 可用狀態與畫面；不會發出模型請求 |
| `npx electron test/electron-agent-management-smoke.mjs` | 三 Agent 同屏、詳細資料、狀態與傳送 gate、焦點保存及選定 Agent 開新對話；不發出模型請求 |
| `npx electron test/electron-auth-state-smoke.mjs` | 憑證三態、重新登入入口、App 晚退出與登入等待結束；使用可控狀態，不會發出模型請求 |
| `npx electron test/electron-cli-live-smoke.mjs` | 使用真實 Codex／Claude CLI 各發出一則模型請求 |
| `npx electron test/electron-antigravity-live-smoke.mjs` | 使用真實 Antigravity CLI 驗證聊天室回覆標記、隔離 fixture 檔寫入與取消／關閉清理 |

兩項 live smoke 會使用真實帳號、發出模型請求並消耗用量；Antigravity live smoke 另會在隔離測試資料夾建立 fixture 檔。它們僅在需要時手動執行，不包含於 `npm test`。請以當次 `.bridge/` 報告判斷結果，不能只看到測試指令便認定已通過。

## 參考資料

- [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
- [Codex 非互動執行](https://learn.chatgpt.com/docs/non-interactive-mode)
- [Claude Code CLI](https://code.claude.com/docs/en/cli-reference)
- [Antigravity headless 模式](https://antigravity.google/docs/cli/headless/)
- [Antigravity CLI 參數](https://antigravity.google/docs/cli/reference/)
- [Antigravity 終端沙箱](https://antigravity.google/docs/sandbox?tab=cli)

## 版本紀錄

各版本的變更與已知限制見 [CHANGELOG.md](CHANGELOG.md)。

## 授權

目前尚未提供 LICENSE 檔。專案公開可檢視不代表已授予再使用、修改或散布權利；在選定並加入授權前，請勿假設可任意複用本專案。

Agent 管理的頁面結構與狀態規則見[操作說明](docs/agent-management.md)。
