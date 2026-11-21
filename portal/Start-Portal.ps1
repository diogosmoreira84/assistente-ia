<#
.SYNOPSIS
  Starts every Assistente IA listener. Assistente IA by Diogo Moreira, MIT License.
.DESCRIPTION
  - 127.0.0.1:8780   portal on this PC, relays the local PhoneBox agent
  - <LAN IP>:8781    HTTPS portal for phones and tablets on your Wi-Fi (needs data\portal-cert.pem and key)
  - <LAN IP>:8782    Android app download page (opened by the QR code in Downloads)
  - Tailscale        when Tailscale runs with HTTPS certificates enabled, the portal is published on
                     https://<this-pc>.<tailnet>.ts.net for your own devices only (tailscale serve, never funnel)
#>
param(
    [string]$LanIp,
    [ValidateRange(1, 65535)][int]$AgentPort = 8765,
    [string]$Python,
    [switch]$NoTailscale,
    [switch]$Open
)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$data = Join-Path $root 'data'
$python = if ($Python) { $Python } else { Join-Path $data 'runtime\python.exe' }
if (-not (Test-Path $python)) { $python = (Get-Command python -ErrorAction Stop).Source }
$server = Join-Path $root 'server.py'
$cert = Join-Path $data 'portal-cert.pem'
$key = Join-Path $data 'portal-key.pem'

if (-not $LanIp) {
    $LanIp = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object {
        $_.IPAddress -notmatch '^(127|169\.254|100\.)' -and $_.InterfaceAlias -notmatch 'Tailscale|vEthernet|Loopback|WSL'
    } | Sort-Object InterfaceMetric | Select-Object -First 1).IPAddress
}

# The Wi-Fi listener needs a certificate; phones trust it through the fingerprint in the pairing code.
if ($LanIp -and -not ((Test-Path $cert) -and (Test-Path $key))) {
    & $python (Join-Path $root 'certgen.py') --ip $LanIp --cert $cert --key $key | Out-Null
}

# Stop earlier copies of this portal only.
Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Where-Object {
    $_.CommandLine -and $_.CommandLine.Contains($root) -and $_.CommandLine -match 'server\.py|lan_download\.py'
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Sleep -Milliseconds 600

$public = ''
$tailscale = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
if (-not $NoTailscale -and (Test-Path $tailscale)) {
    try {
        $status = & $tailscale status --json | ConvertFrom-Json
        if ($status.BackendState -eq 'Running' -and $status.CertDomains) { $public = 'https://' + $status.Self.DNSName.TrimEnd('.') }
        elseif ($status.BackendState -eq 'Running') { Write-Warning 'Tailscale runs, but HTTPS certificates are off. Enable them under DNS in the Tailscale admin console, then run this again.' }
    } catch { Write-Warning 'Could not read Tailscale status.' }
}

function Start-Listener([string[]]$Arguments) {
    Start-Process -FilePath $python -ArgumentList $Arguments -WorkingDirectory $root -WindowStyle Hidden
}

$local = @($server, '--port', '8780', '--local-agent-port', $AgentPort)
$lanReady = $LanIp -and (Test-Path $cert) -and (Test-Path $key)
if ($lanReady) { $local += @('--pair-origin', "https://${LanIp}:8781", '--pair-cert', $cert) }
if ($public) { $local += @('--public-origin', $public) }
Start-Listener $local

if ($lanReady) {
    $lan = @($server, '--host', $LanIp, '--port', '8781', '--cert', $cert, '--key', $key)
    if ($public) { $lan += @('--public-origin', $public) }
    Start-Listener $lan
    Start-Listener @((Join-Path $root 'lan_download.py'), $LanIp)
}

if ($public) {
    Start-Listener @($server, '--port', '8783', '--origin', $public, '--behind-proxy')
    & $tailscale serve --bg http://127.0.0.1:8783 | Out-Null
}

Start-Sleep -Seconds 2
Write-Output 'Assistente IA is running:'
Write-Output '  This PC      http://127.0.0.1:8780'
if ($lanReady) { Write-Output "  Wi-Fi        https://${LanIp}:8781   (app download: http://${LanIp}:8782)" }
if ($public) { Write-Output "  Anywhere     $public   (your Tailscale devices only)" }
if ($Open) { Start-Process 'http://127.0.0.1:8780/' }
