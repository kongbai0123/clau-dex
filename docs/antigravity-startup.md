# Antigravity 啟動、登入與任務排查

[返回 README](../README.md)

Bridge 的 CLI 能力、憑證標記、桌面 App 程序與任務結果是不同訊號。本文件說明目前的官方 `agy` 文字任務整合，以及 2026-10-28 在一台 Windows 主機上完成的 Antigravity 2.27.0 啟動修復。

## 狀態代表什麼

| 訊號 | 實際意義 |
| --- | --- |
| Codex／Claude CLI 登入狀態 | 由各 CLI 的 status 指令回報；不等於已成功執行模型請求 |
| Antigravity `credentialPresent: true` | 偵測到名稱完全相符的 `gemini:antigravity` 憑證項目；不代表 token／session 仍有效 |
| Antigravity `credentialPresent: false` | 沒有偵測到該項目；不應據此推斷 App 的所有登入資料都不存在 |
| Antigravity `credentialPresent: null` | 無法完成檢查，應顯示無法確認，而不是判為未登入 |
| Antigravity `authenticated: null`、`authSource: "credential-entry"` | Bridge 沒有驗證線上帳號有效性，只有本機項目觀測結果 |
| Antigravity CLI 可用 | 版本查詢成功，且 `--help` 包含 Bridge 必要的 headless 參數；不代表模型請求一定成功 |
| App 程序存活 | 已觀察到 App 根程序；仍需確認視窗與操作是否正常 |
| 當次任務成功 | CLI 正常退出，stream-json 結果符合協定，唯一最終結果為 `SUCCESS`、回覆非空且沒有 `denied_actions`；檔案與命令仍需另行驗收 |

憑證檢查只列出項目名稱，不讀取或保存秘密值。Antigravity 的登入流程不依賴 `agy` 是否安裝：一律開啟 App，讓使用者自行確認 Google 帳號或重新登入。已有憑證項目也保留重新登入入口，不會把舊項目當成新的授權完成證據。

等待新憑證時，Bridge 持續盤點 App 根程序，核對 PID 與建立時間；即使子程序還在、原根程序已消失，也會辨識晚退出。App 中途結束時，完成最後一次憑證檢查後回報原因，不會一直等到 5 分鐘登入逾時。無法持續確認程序時則回報狀態未知，供使用者重新整理或重試。

## 官方 CLI 與聊天室任務

### 畫面顯示 CLI 不可用，但另一個終端機測試成功

2026-10-29 的實機排查確認：測試工具能讀取 `%LOCALAPPDATA%\agy\bin\agy.exe`，但日常 Bridge 啟動的程序在同一文字路徑回報檔案不存在；其環境變數沒有指向其他使用者，也沒有設定 CLI 命令覆寫。不能僅憑測試工具的成功結果，推斷日常桌面程序也能使用該安裝。此次未進一步確診造成不同檔案視圖的作業系統機制。

遇到此情況，在日常開啟 Clau-dex 的使用者環境確認：

```powershell
$agyPath = Join-Path $env:LOCALAPPDATA 'agy\bin\agy.exe'
Test-Path -LiteralPath $agyPath -PathType Leaf
if (Test-Path -LiteralPath $agyPath -PathType Leaf) {
    Get-AuthenticodeSignature -LiteralPath $agyPath
    & $agyPath --version
}
```

若檔案不存在，依官方安裝說明在該使用者環境安裝。不要重設整個 AppData 權限，也不要停用 ESET 或沙箱。回到 Clau-dex 按「重新檢查 App 與 CLI 狀態」；程式會重新搜尋已知目錄，不需為 PATH 更新重新啟動 Windows。

Agent 管理與系統面板會分開顯示「CLI 可用」、CLI 路徑與憑證觀測結果。綠色表示本機 CLI 通過能力檢查；憑證有效性仍需由實際任務確認。用量面板只統計工作台任務回報的 Antigravity token，不含桌面 App 外部使用；方案額度尚未提供查詢，會明確標示，並不影響任務執行。

修復後應在同一日常執行環境跑 `test/electron-antigravity-live-smoke.mjs`，核對當次報告的時間、`agent.commandPath`、`passed`、`fileVerified`、`usageVisible` 與清理結果，避免誤讀先前留下的成功報告。

Antigravity 現在可單獨執行文字任務，也可接受 Codex／Claude 協作指派；provider 設定為 `tasks:true`、`coordinate:false`，規劃與複核由 Codex／Claude 負責。Bridge 使用明確的 Antigravity runner，不會把第三個 Agent 當作 Codex 執行。

本次安裝的是 Google 簽章的官方 `agy 1.4.9`，Windows 位置為 `%LOCALAPPDATA%\agy\bin`，已用真實 headless 請求取得 `SUCCESS` 與指定回覆標記。新環境請依 [官方安裝說明](https://antigravity.google/docs/getting-started?tab=cli) 安裝；[Windows 官方安裝腳本](https://antigravity.google/cli/install.ps1) 是安裝來源，Bridge 不會自動下載來路不明的同名工具。

Bridge 先搜尋 PATH，再檢查官方預設安裝位置；若明確設定 `AGENT_HUB_ANTIGRAVITY_COMMAND`，不會在該指令失效時偷偷換用另一份安裝。可用性檢查除 `--version` 外，也要求 `--help` 列出 `--input-format`、`--output-format`、`--print-timeout`、`--mode`、`--sandbox` 與 `--disable-slash-commands`，採完整旗標比對，避免把 `--model` 當成 `--mode`。

文字任務的執行參數如下；`--print-timeout` 由管理器逾時換算，並以標準輸入傳送請求，不把提示詞插入 shell 指令：

```text
agy --input-format stream-json --output-format stream-json --print-timeout <manager timeout> --mode accept-edits --sandbox --disable-slash-commands
```

輸出依 [官方 headless 協定](https://antigravity.google/docs/cli/headless/) 解析。Bridge 要求正常退出且恰有一個位於末尾的 `result`，狀態必須是 `SUCCESS`、`response` 必須是非空文字；最終 `denied_actions` 非空時明確失敗並列出被拒絕的工具。`WAITING`、`ERROR`、重複結果、只有部分步驟、格式錯誤或沒有最終結果均不能視為成功。CLI 提供的 token 數據才會計入用量，缺少的資料保留未知。對話續問由 Bridge 提供最近的歸屬明確前文，不會假定沿用某個未驗證的 CLI session。

取消、管理器逾時與關閉會停止並清理由 Bridge 啟動的 CLI 程序樹，不會因此關閉在外部開啟的桌面 App。參數的意義見 [官方 CLI reference](https://antigravity.google/docs/cli/reference/)。

### 權限與目前限制

Bridge 對修改任務傳入官方 `--mode accept-edits`，允許工作資料夾內的檔案建立與編輯，並保留 `--sandbox`。這是每次執行的模式設定，不會改寫全域 CLI 權限規則，也沒有使用 `--dangerously-skip-permissions`；shell 命令仍需符合 CLI 工具權限。[官方執行模式](https://antigravity.google/docs/cli/modes/)

實機 smoke 曾在預設模式遇到 `write_file` 自動被拒絕，CLI 卻回傳 `SUCCESS` 與空回覆。切換到 `accept-edits` 後，才實際建立檔案並讀回通過。Bridge 因此同時檢查最終權限拒絕與非空回覆；需要核准卻無法取得核准的命令仍可能被 soft-deny，不能以模型自述代替實際驗收。[官方 headless 權限說明](https://antigravity.google/docs/cli/headless/)

CLI 終端沙箱與桌面 App 的 GPU 沙箱是兩層不同機制。官方文件指出，Windows 終端沙箱需 Windows 11 24H2 與 2026 年 8 月更新或更新版本；在不支援的平台上，`agy 1.4.4+` 的 `--sandbox` 可能無效，工具核准規則仍會生效。因此，僅傳入旗標不能當作已驗證 OS 隔離的證據；本文件後段的受限權限修復則是桌面 App 啟動對照。[官方終端沙箱說明](https://antigravity.google/docs/sandbox?tab=cli)

目前不支援 Antigravity 圖片輸入或工具層受限的唯讀 `review`。包含 Antigravity 的任務若帶有本次／前文圖片或要求該模式，會明確拒絕；不會丟掉圖片後繼續，也不會以提示詞代替真正的工具權限限制。需要圖片或唯讀複核時請改選 Codex／Claude。

## 先判斷是哪一類故障

1. 保存實際 App 版本、啟動參數、當次 stderr、App 日誌與時間。舊版本 dump 不能直接用來確診新版本。
2. App 能開啟但未登入時，在 App 內完成授權；Bridge 的憑證標記只能提供輔助觀測。
3. App 一啟動就退出時，先針對相同版本、相同參數收集基準結果，再檢查安裝目錄權限。錯誤提及 GPU，不表示已證實顯示卡、驅動或安全軟體是根因。
4. 檢查不明 SID 時，先核對 AppContainer 映射與權限用途，不要直接刪除不認得的 SID，也不要對整個使用者資料目錄重設權限。

Electron 官方追蹤記載了 AppContainer／受限套件 ACL 與 GPU 子程序啟動失敗的相近案例；GitHub Desktop 維護者也在追查相關現象。[Electron 問題紀錄](https://github.com/electron/electron/issues/51761)、[GitHub Desktop 維護者說明](https://github.com/desktop/desktop/issues/22237)。這些回報提供可驗證的方向，不能代替本機對照。

## 本機已完成的權限對照

本次修復先保存 Antigravity 安裝目錄及子項目的 ACL，再使用相同 2.27.0 版本與相同日誌參數比較。沒有刪除原設定、憑證或未知 SID。

兩次啟動僅帶入 `--enable-logging=stderr --v=0` 日誌參數，沒有加入改變 GPU 後端或停用隔離的參數。

| 階段 | 結果 |
| --- | --- |
| ACL 備份 | `icacls /save /T /C` 成功處理 461 個項目，0 失敗 |
| 修復前 | 正常啟動不到 1 秒即退出；GPU 子程序連續崩潰 9 次，`exit_code=-2147483645`，最後回報 GPU 程序不可用 |
| 唯一權限修正 | 只在 Antigravity 安裝根目錄加入 `S-1-15-2-2` 的可繼承讀取／執行權限 |
| 修復後 | 同版本、同參數啟動持續超過 30 秒；根程序存活、GUI 顯示，沒有再次出現上述 GPU 崩潰記錄 |
| 一般冷啟動複驗 | 不帶任何參數重新開啟，主畫面可載入，側欄開合有回應；未送出模型請求 |
| 保護狀態 | ESET 保持 `Running`；沒有停用沙箱，也沒有新增掃描排除 |

這次對照確認：補齊安裝目錄的受限套件讀取／執行 ACL，是這台主機上的有效修復。它不等於確診 ESET 是根因，也不代表所有具有相似 GPU 錯誤的電腦都適用。這個 App 啟動對照階段沒有驗收 Google 線上 session 或模型請求；CLI 請求另依前述任務協定驗證。

## 限定範圍的 ACL 備份與修復

以下為人工排查指令；Bridge 不會自動修改這些權限。先關閉 Antigravity，確認實際安裝路徑，並在專案根目錄的 PowerShell 執行。若電腦由組織管理，先確認此變更符合管理政策。

```powershell
$appRoot = Join-Path $env:LOCALAPPDATA 'Programs\antigravity'
$appParent = Split-Path -Parent $appRoot
$backupDirectory = Join-Path (Get-Location) '.bridge\acl-backups'
New-Item -ItemType Directory -Path $backupDirectory -Force | Out-Null
$backup = Join-Path $backupDirectory ('antigravity-before-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '.txt')

icacls.exe $appRoot /save $backup /T /C
if ($LASTEXITCODE -ne 0) { throw 'ACL 備份未完整成功，請先處理備份錯誤，不要繼續修改。' }

icacls.exe $appRoot /grant '*S-1-15-2-2:(OI)(CI)(RX)'
if ($LASTEXITCODE -ne 0) { throw 'ACL 修正未成功，請保留錯誤輸出並重新檢查。' }
```

`S-1-15-2-2` 是 **ALL RESTRICTED APPLICATION PACKAGES**；`RX` 是讀取與執行，`OI`／`CI` 讓權限由檔案與子目錄繼承。這項修正只對應指定 App 安裝目錄，不應擴大套用到整個 `%LOCALAPPDATA%`，也不會移除其他既有 ACL。

修正後以原本的正常啟動方式重新開啟 App，保留原沙箱設定，檢查根程序、GPU 程序及實際視窗至少 30 秒；確認沒有相同崩潰後，再檢查 App 內的登入畫面。若仍失敗，保存當次新記錄，依實際退出碼與失敗模組繼續排查。

## 需要時復原 ACL

復原會回到備份時的 ACL，因此也可能恢復原本的啟動故障。只在需要撤回這次變更時執行，先保存修復後的 ACL，並確認 `$backup` 指向修復前那份備份。

```powershell
$afterBackup = Join-Path $backupDirectory ('antigravity-after-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '.txt')
icacls.exe $appRoot /save $afterBackup /T /C
if ($LASTEXITCODE -ne 0) { throw '修復後 ACL 尚未完整備份，請不要復原。' }

# /save 中記錄的是相對項目；此安裝目錄備份以 Programs 作為復原根目錄。
icacls.exe $appParent /restore $backup /C
if ($LASTEXITCODE -ne 0) { throw 'ACL 復原未完整成功，請保留輸出並檢查失敗項目。' }
```

備份與日誌可能包含本機帳號路徑，請留在已忽略的 `.bridge/` 目錄，分享前去識別化。

## Bridge 回歸驗證

```powershell
npm test
npm run check
npx electron test/electron-auth-state-smoke.mjs
```

單元測試涵蓋憑證名稱精確比對、存在／不存在／未知三態、CLI 不可用與檢查取消，以及 App 根程序身分、晚退出與登入等待清理。桌面 smoke 使用可控的登入及程序狀態，驗證重新登入入口、三態文案與中途退出，不發出模型請求，也不需要讀取真實憑證。

另可手動執行以下 live smoke；它會使用真實帳號、發出模型請求並消耗用量，不包含於 `npm test`：

```powershell
npx electron test/electron-antigravity-live-smoke.mjs
```

此檢查從聊天室傳送唯一回覆標記，再要求於隔離測試資料夾寫入 fixture 檔並由測試程式讀回比對，另外檢查取消與關閉後的清理。報告與截圖寫在 `.bridge/`；請以當次報告判斷是否通過。工具被拒絕、檔案沒有實際建立或程序沒有清理，都不能只憑模型自述當作驗收成功。

原生 `cmdkey` 輸出必須依 Windows OEM code page 解碼後再比對欄位；直接以 UTF-8 讀取繁體中文輸出，可能漏掉實際存在的項目。不支援的語言或無法解碼時應保留未知狀態。App 存活盤點也需排除明確以 Node 模式運作的側車程序；共用 `Antigravity.exe` 的背景工具不代表主視窗仍在。

部分側車不會在命令列留下 Node 模式旗標，例如 App 經由 `language_server.exe` 與 `cmd.exe` 重新執行 `Antigravity.exe`。因此盤點會沿著完整的父程序鏈判斷：只要上層任一程序是同一 App 的 GUI 程序，就不算根程序。父程序建立時間晚於子程序時視為 PID 重複使用並停止追溯。登入等待另以 PID 與建立時間核對原根程序，主視窗結束後即使側車仍在，也不會被誤判為 App 仍在執行。
