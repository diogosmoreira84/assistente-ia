# Connects this PC's desktop agent to an Assistente IA portal running on another computer.
# Created by Diogo Moreira, MIT License.
$ErrorActionPreference = 'Stop'
$settings = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'settings.json') -Raw | ConvertFrom-Json
$portal = Read-Host 'Portal address (shown in Devices on the portal)'
if (-not $portal) { throw 'Enter the portal address shown in Devices on the other computer.' }
$fingerprint = Read-Host 'Certificate fingerprint (leave empty for a Tailscale address)'
$arguments = @((Join-Path $PSScriptRoot 'portal\connector.py'), '--portal', $portal, '--agent-port', $settings.agentPort)
if ($fingerprint) { $arguments += @('--fingerprint', $fingerprint) }
& (Join-Path $PSScriptRoot 'python\python.exe') @arguments
exit $LASTEXITCODE
