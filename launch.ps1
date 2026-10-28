$ErrorActionPreference = "Stop"
$ProjectRoot = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$ElectronPath = Join-Path $ProjectRoot "node_modules\electron\dist\electron.exe"
if (-not (Test-Path -LiteralPath $ElectronPath -PathType Leaf)) {
    throw "Electron is missing. Run npm install and node node_modules\electron\install.js in $ProjectRoot."
}
# A shortcut straight to Electron starts the manager without any console window.
$ShortcutPath = Join-Path $ProjectRoot "Clau-dex.lnk"
try {
    $Shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($ShortcutPath)
    $Shortcut.TargetPath = $ElectronPath
    $Shortcut.Arguments = '"' + $ProjectRoot + '"'
    $Shortcut.WorkingDirectory = $ProjectRoot
    $Shortcut.IconLocation = $ElectronPath + ",0"
    $Shortcut.Description = "Clau-dex desktop manager"
    $Shortcut.Save()
}
catch {
    Write-Warning "Could not create $ShortcutPath : $($_.Exception.Message)"
}
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
Start-Process -FilePath $ElectronPath -ArgumentList ('"' + $ProjectRoot + '"') -WorkingDirectory $ProjectRoot -WindowStyle Normal
