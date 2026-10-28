# Antigravity 啟動與登入排查

[返回 README](../README.md)

Bridge 的 CLI 狀態、憑證標記與桌面 App 程序是不同訊號。本文件說明狀態的限制，以及 2026-10-28 在一台 Windows 主機上完成的 Antigravity 2.27.0 啟動修復。

## 狀態代表什麼

| 訊號 | 實際意義 |
| --- | --- |
| Codex／Claude CLI 登入狀態 | 由各 CLI 的 status 指令回報；不等於已成功執行模型請求 |
| Antigravity `credentialPresent: true` | 偵測到名稱完全相符的 `gemini:antigravity` 憑證項目；不代表 token／session 仍有效 |
| Antigravity `credentialPresent: false` | 沒有偵測到該項目；不應據此推斷 App 的所有登入資料都不存在 |
| Antigravity `credentialPresent: null` | 無法完成檢查，應顯示無法確認，而不是判為未登入 |
| Antigravity `authenticated: null`、`authSource: "credential-entry"` | Bridge 沒有驗證線上帳號有效性，只有本機項目觀測結果 |
| App 程序存活 | 已觀察到 App 根程序；仍需確認視窗與操作是否正常 |

憑證檢查只列出項目名稱，不讀取或保存秘密值。Antigravity 的登入流程不依賴 `agy` 是否安裝：一律開啟 App，讓使用者自行確認 Google 帳號或重新登入。已有憑證項目也保留重新登入入口，不會把舊項目當成新的授權完成證據。

等待新憑證時，Bridge 持續盤點 App 根程序，核對 PID 與建立時間；即使子程序還在、原根程序已消失，也會辨識晚退出。App 中途結束時，完成最後一次憑證檢查後回報原因，不會一直等到 5 分鐘登入逾時。無法持續確認程序時則回報狀態未知，供使用者重新整理或重試。

Antigravity 的聊天室任務整合仍未啟用；憑證存在、App 存活或安裝 `agy` 都不會自動讓它成為任務執行者。

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

這次對照確認：補齊安裝目錄的受限套件讀取／執行 ACL，是這台主機上的有效修復。它不等於確診 ESET 是根因，也不代表所有具有相似 GPU 錯誤的電腦都適用。測試沒有驗收 Google 線上 session 或模型請求。

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

原生 `cmdkey` 輸出必須依 Windows OEM code page 解碼後再比對欄位；直接以 UTF-8 讀取繁體中文輸出，可能漏掉實際存在的項目。不支援的語言或無法解碼時應保留未知狀態。App 存活盤點也需排除明確以 Node 模式運作的側車程序；共用 `Antigravity.exe` 的背景工具不代表主視窗仍在。

部分側車不會在命令列留下 Node 模式旗標，例如 App 經由 `language_server.exe` 與 `cmd.exe` 重新執行 `Antigravity.exe`。因此盤點會沿著完整的父程序鏈判斷：只要上層任一程序是同一 App 的 GUI 程序，就不算根程序。父程序建立時間晚於子程序時視為 PID 重複使用並停止追溯。登入等待另以 PID 與建立時間核對原根程序，主視窗結束後即使側車仍在，也不會被誤判為 App 仍在執行。
