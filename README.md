# Clau-dex：Codex × Claude Code 本機協作管理器

Clau-dex 是一款 Windows 桌面應用，讓 Codex CLI 與 Claude Code CLI 共用聊天室、協作執行任務，並透過本機 MCP 服務連接 Codex。它沿用你已登入的 CLI 帳號，對話紀錄保存在本機。

## 安全須知

請在信任的電腦和工作資料夾中使用，並在執行前備份重要資料或使用 Git 管理變更。

- 一般執行任務會以無互動核准方式啟動 CLI。Codex 使用 `--sandbox danger-full-access` 與 `--ask-for-approval never`；Claude Code 使用 `--permission-mode bypassPermissions`。Agent 可依目前 Windows 帳號的權限讀寫檔案及執行指令，也可能觸及選定工作資料夾以外的路徑。
- 唯讀複核模式會使用受限工具與唯讀沙箱；一般執行模式不會逐項詢問是否允許檔案或指令操作。
- MCP 服務只監聽 `127.0.0.1`，但**沒有驗證 token 或使用者身分**。Host／Origin 檢查不等於驗證；同一台電腦上的其他程式仍可呼叫服務。管理器開啟期間，請勿執行不受信任的本機程式。
- 送出的訊息、工作資料與圖片會交由已登入的 CLI 傳送至相應服務。Bridge 不會自行保存 Codex 或 Claude 的登入憑證。

## 主要功能

- **共用聊天室**：依工作資料夾分開保存對話，支援續問、取消執行與歷史對話。
- **Codex／Claude 協作**：在對話選項的「參與的 AI」中，可以複選要納入的 AI。只選一個時，由它直接回覆；選兩個以上時，由統籌方拆解任務、指派執行者並複核結果。若某方額度用盡，會由其他已勾選的 AI 接手同一階段。
- **圖片輸入**：支援貼上、選檔、拖放與圖片續問。
- **觀察面板**：查看 CLI 狀態、用量、對話進度、Token 統計與程序資訊。
- **桌面 App 管理**：查看 Codex、Claude 與 Antigravity App 的狀態，並管理由本程式啟動的 App。
- **引導式登入**：CLI 未登入時，可以在 App 管理或聊天室按「登入」。程式會開啟該 CLI 官方的登入視窗，你在瀏覽器完成授權後，畫面會自動更新。憑證由 CLI 自行保存，Bridge 不會讀取。
- **Codex MCP 整合**：提供 `check_bridge` 與 `delegate_to_claude` 工具。

## 系統需求

- Windows
- Node.js 22.12.0 以上與 npm
- 若要執行 Agent 任務，需安裝並登入 Codex CLI 與 Claude Code CLI

可以在 App 管理按「登入」，也可以自行執行登入指令：

```powershell
codex login
claude auth login
```

Antigravity（Google）目前只在 App 管理中顯示桌面 App 狀態與登入狀態，還不能接聊天室任務。登入狀態的判斷方式是檢查 Windows 認證管理員中有沒有名為 `gemini:antigravity` 的項目，只看名稱，不讀取內容。接任務需要 `agy` CLI，目前尚未完成驗證。

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

### 觀察面板與用量

面板可查看 Codex／Claude 的方案額度、今日 Token、任務進度與耗時、程序 PID、CLI 登入狀態及橋接服務狀態。面板與對話統計分開顯示。

用量資料來自本機 CLI 紀錄，包括 `~/.codex/sessions`、`~/.claude/projects`，或環境變數 `CODEX_HOME`、`CLAUDE_CONFIG_DIR` 指定的位置。Bridge 不讀取或保存提供者憑證。為更新 Claude 額度，管理器在快取超過 5 分鐘時會發出一次短查詢；手動刷新也會使用少量模型用量。每 20 秒的背景狀態更新只讀取本機紀錄與快取，不會發出模型查詢。

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
- **按「登入」後畫面沒有更新**：完成瀏覽器授權後，若登入視窗沒有自動關閉，請手動關閉。程式最多等待 5 分鐘；逾時後可以按重新整理，或再登入一次。
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
| `npx electron test/electron-cli-live-smoke.mjs` | 使用真實 Codex／Claude CLI 各發出一則模型請求 |

最後一項 smoke 檢查會使用真實帳號並消耗用量，僅在需要時手動執行，不包含於 `npm test`。

## 參考資料

- [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
- [Codex 非互動執行](https://learn.chatgpt.com/docs/non-interactive-mode)
- [Claude Code CLI](https://code.claude.com/docs/en/cli-reference)

## 授權

目前尚未提供 LICENSE 檔。專案公開可檢視不代表已授予再使用、修改或散布權利；在選定並加入授權前，請勿假設可任意複用本專案。
