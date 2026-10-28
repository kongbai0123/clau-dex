$ErrorActionPreference = "Stop"

$ProjectRoot = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$ServerPath = (Resolve-Path -LiteralPath (Join-Path $ProjectRoot "src\server.js")).Path
$SkillSource = (Resolve-Path -LiteralPath (Join-Path $ProjectRoot "skills\codex-claude-bridge")).Path
$WorkspaceRoot = $ProjectRoot
while (-not (Test-Path -LiteralPath (Join-Path $WorkspaceRoot ".git"))) {
    $Parent = Split-Path -Parent $WorkspaceRoot
    if ([string]::IsNullOrWhiteSpace($Parent) -or $Parent -eq $WorkspaceRoot) {
        $WorkspaceRoot = $null
        break
    }
    $WorkspaceRoot = $Parent
}
$ServerName = "codex-claude-bridge"
$BridgeUrl = "http://127.0.0.1:47931/mcp"

$NodeCommand = Get-Command node -ErrorAction Stop
$NpmCommand = Get-Command npm -ErrorAction Stop
$CodexCommand = Get-Command codex -ErrorAction Stop

$CodexHome = $env:CODEX_HOME
if ([string]::IsNullOrWhiteSpace($CodexHome)) {
    $CodexHome = Join-Path $env:USERPROFILE ".codex"
}
$SkillTarget = Join-Path $CodexHome "skills\codex-claude-bridge"

if (Test-Path -LiteralPath $SkillTarget) {
    $SourceSkill = Get-Content -LiteralPath (Join-Path $SkillSource "SKILL.md") -Raw
    $InstalledSkillPath = Join-Path $SkillTarget "SKILL.md"
    if (-not (Test-Path -LiteralPath $InstalledSkillPath)) {
        throw "A different skill already uses '$SkillTarget'. Inspect it before replacing it."
    }
    $InstalledSkill = Get-Content -LiteralPath $InstalledSkillPath -Raw
    $NormalizedSource = $SourceSkill.Replace("`r`n", "`n").Trim()
    $NormalizedInstalled = $InstalledSkill.Replace("`r`n", "`n").Trim()
    $LegacySkill = [regex]::Replace($NormalizedSource, '(?m)^1\. Call `check_bridge`.*$', '1. Call `check_bridge` before the first delegation in the conversation. If Claude Code is unavailable, continue in Codex and explain the prerequisite.')
    $LegacySkillWithDefault = $LegacySkill.Replace('3. Pass the current repository path in `workspace`.', '3. Pass the current repository path in `workspace` when it differs from the configured default.')
    if ($NormalizedInstalled -ceq $LegacySkill -or $NormalizedInstalled -ceq $LegacySkillWithDefault) {
        Copy-Item -LiteralPath (Join-Path $SkillSource "SKILL.md") -Destination $InstalledSkillPath -Force
        Write-Host "Updated this project's previously installed coordination skill."
    }
    elseif ($NormalizedInstalled -cne $NormalizedSource) {
        throw "The installed skill has custom changes. Review it before replacing it."
    }
    Write-Host "Codex skill 'codex-claude-bridge' is already installed."
}
else {
    New-Item -ItemType Directory -Path (Split-Path -Parent $SkillTarget) -Force | Out-Null
    Copy-Item -LiteralPath $SkillSource -Destination (Split-Path -Parent $SkillTarget) -Recurse
    Write-Host "Installed Codex skill at $SkillTarget."
}

if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot "node_modules\@modelcontextprotocol\sdk")) -or -not (Test-Path -LiteralPath (Join-Path $ProjectRoot "node_modules\electron"))) {
    Push-Location $ProjectRoot
    try {
        & $NpmCommand.Source install
        if ($LASTEXITCODE -ne 0) {
            throw "npm install failed with exit code $LASTEXITCODE."
        }
    }
    finally {
        Pop-Location
    }
}

if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot "node_modules\electron\dist\electron.exe"))) {
    & $NodeCommand.Source (Join-Path $ProjectRoot "node_modules\electron\install.js")
    if ($LASTEXITCODE -ne 0) { throw "Could not install the desktop runtime." }
}

$PreviousErrorActionPreference = $ErrorActionPreference
$ErrorActionPreference = "Continue"
$ExistingConfig = & $CodexCommand.Source mcp get $ServerName 2>$null
$ExistingExitCode = $LASTEXITCODE
$ErrorActionPreference = $PreviousErrorActionPreference

$NeedsRegistration = $true
if ($ExistingExitCode -eq 0) {
    $ExistingText = ($ExistingConfig | Out-String)
    if ($ExistingText -match [regex]::Escape($BridgeUrl)) {
        Write-Host "Codex MCP server '$ServerName' is already connected to the desktop manager."
        $NeedsRegistration = $false
    }
    elseif ($ExistingText -match [regex]::Escape($ServerPath)) {
        & $CodexCommand.Source mcp remove $ServerName
        if ($LASTEXITCODE -ne 0) { throw "Could not migrate the previous bridge registration." }
    }
    else {
        throw "Codex already has an MCP server named '$ServerName' with a different command. Inspect it with 'codex mcp get $ServerName' before changing it."
    }
}
if ($NeedsRegistration) {
    & $CodexCommand.Source mcp add $ServerName --url $BridgeUrl
    if ($LASTEXITCODE -ne 0) {
        throw "Could not register the bridge with Codex (exit code $LASTEXITCODE)."
    }
    Write-Host "Registered '$ServerName' with Codex. Restart the Codex app to load the MCP tool."
}

$ConfigPath = Join-Path $CodexHome "config.toml"
if (Test-Path -LiteralPath $ConfigPath -PathType Leaf) {
    $ConfigText = [System.IO.File]::ReadAllText($ConfigPath)
    $SectionPattern = '(?ms)^\[mcp_servers\.codex-claude-bridge\]\r?\n(?<body>.*?)(?=^\[|\z)'
    $UpdatedConfig = [regex]::Replace($ConfigText, $SectionPattern, {
        param($Match)
        $Section = $Match.Value
        if ($Section -match '(?m)^tool_timeout_sec\s*=') {
            return [regex]::Replace($Section, '(?m)^tool_timeout_sec\s*=.*$', 'tool_timeout_sec = 660')
        }
        return $Section.TrimEnd() + "`n" + 'tool_timeout_sec = 660' + "`n`n"
    })
    if ($UpdatedConfig -cne $ConfigText) { [System.IO.File]::WriteAllText($ConfigPath, $UpdatedConfig) }
}

$ClaudeCommand = Get-Command claude -ErrorAction SilentlyContinue
if ($null -eq $ClaudeCommand) {
    Write-Warning "Claude Code CLI is not on PATH. The MCP server is registered, but delegation will remain unavailable until Claude Code is installed and authenticated."
}
else {
    Write-Host "Claude Code CLI found at $($ClaudeCommand.Source)."
}

Write-Host "Desktop bridge: $BridgeUrl"
Write-Host "Run launch.ps1 to open the manager. Closing its window stops the bridge and agent processes."
