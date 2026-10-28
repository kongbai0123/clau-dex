# 版本紀錄

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
