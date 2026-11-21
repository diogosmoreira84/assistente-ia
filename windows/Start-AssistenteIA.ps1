# Starts Assistente IA: the PhoneBox desktop agent and the portal, then opens the portal.
# Created by Diogo Moreira, MIT License.
$ErrorActionPreference = 'Stop'
$settings = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'settings.json') | ConvertFrom-Json
$agentPort = [int]$settings.agentPort
$agentHome = Join-Path $PSScriptRoot 'agent-0.9.25'
$python = Join-Path $PSScriptRoot 'python\python.exe'
$agentUrl = "http://127.0.0.1:$agentPort"

function Test-Endpoint($url) {
    try { return (Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 1).StatusCode -eq 200 }
    catch { return $false }
}

if (-not (Test-Endpoint "$agentUrl/api/lan")) {
    Start-Process -FilePath (Join-Path $agentHome 'PhoneBoxAgent.exe') -ArgumentList @('--port', $agentPort) -WorkingDirectory $agentHome -WindowStyle Hidden
    for ($i = 0; $i -lt 20 -and -not (Test-Endpoint "$agentUrl/api/lan"); $i++) { Start-Sleep -Milliseconds 500 }
}
if (-not (Test-Endpoint "$agentUrl/api/lan")) { throw "The desktop agent did not start on port $agentPort." }

# Claude Code and Codex send permission prompts through a hook; the agent writes it into their settings once.
foreach ($tool in 'claude', 'codex') {
    try {
        $hook = Invoke-RestMethod -Uri "$agentUrl/api/$tool/hook" -TimeoutSec 2
        if (-not $hook.installed) { Invoke-RestMethod -Method Post -Uri "$agentUrl/api/$tool/hook" -TimeoutSec 5 | Out-Null }
    } catch { Write-Warning "Could not set up the $tool approval hook: $($_.Exception.Message)" }
}

& (Join-Path $PSScriptRoot 'portal\Start-Portal.ps1') -Python $python -AgentPort $agentPort -Open
