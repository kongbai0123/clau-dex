$ErrorActionPreference = "Stop"
$ProjectRoot = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$ElectronPath = Join-Path $ProjectRoot "node_modules\electron\dist\electron.exe"
if (-not (Test-Path -LiteralPath $ElectronPath -PathType Leaf)) {
    throw "Electron is missing. Run npm install and node node_modules\electron\install.js in $ProjectRoot."
}
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
Start-Process -FilePath $ElectronPath -ArgumentList ('"' + $ProjectRoot + '"') -WorkingDirectory $ProjectRoot -WindowStyle Normal
