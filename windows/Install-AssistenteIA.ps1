# Assistente IA installer for Windows x64. Created by Diogo Moreira, MIT License.
# Installs for the current user: the PhoneBox desktop agent, a private Python runtime and the Assistente IA portal.
param(
    [string]$InstallDirectory = (Join-Path $env:LOCALAPPDATA 'AssistenteIA'),
    [ValidateRange(1024, 65535)][int]$AgentPort = 8765,
    [switch]$NoLaunch
)

$ErrorActionPreference = 'Stop'
if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or
    $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') {
    throw 'This package contains the Windows x64 agent.'
}

$bundle = Join-Path $PSScriptRoot 'payload'
$agentZip = Join-Path $bundle 'PhoneBoxAgent-0.9.25-win-x64.zip'
$pythonZip = Join-Path $bundle 'python-win-x64.zip'
if ((Get-FileHash -LiteralPath $agentZip -Algorithm SHA256).Hash -ne
    'c20b196c7e7944a0499edfafa871e771e031044077b02e1598d0e73f56ba7784') {
    throw 'The bundled PhoneBox agent did not pass verification.'
}
if ((Get-FileHash -LiteralPath $pythonZip -Algorithm SHA256).Hash -ne
    '90905e64a840557d8c1bc4f5b74db3d7ee85e3ffb217611cac1c7813acea4159') {
    throw 'The bundled Python runtime did not pass verification.'
}

$directory = [IO.Path]::GetFullPath($InstallDirectory)
$agent = Join-Path $directory 'agent-0.9.25'
$portal = Join-Path $directory 'portal'
New-Item -ItemType Directory -Force -Path $directory, $portal | Out-Null

# Stop a running portal from an earlier install before replacing its files.
Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Where-Object {
    $_.CommandLine -and $_.CommandLine.Contains($portal)
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

if (-not (Test-Path -LiteralPath (Join-Path $agent 'PhoneBoxAgent.exe'))) {
    Expand-Archive -LiteralPath $agentZip -DestinationPath $agent -Force
}
Expand-Archive -LiteralPath $pythonZip -DestinationPath (Join-Path $directory 'python') -Force

# Replace the portal code but keep portal\data (accounts, history, certificates) across updates.
Get-ChildItem -LiteralPath $portal -Force | Where-Object { $_.Name -ne 'data' } | Remove-Item -Recurse -Force
Copy-Item -Path (Join-Path $bundle 'portal\*') -Destination $portal -Recurse -Force

foreach ($file in 'Start-AssistenteIA.ps1', 'Connect-Portal.cmd', 'Connect-Portal.ps1', 'README.txt', 'LICENSE.txt',
                  'PhoneBox-LICENSE.txt', 'Lobe-Icons-LICENSE.txt') {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file) -Destination $directory -Force
}
@{ agentPort = $AgentPort } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $directory 'settings.json') -Encoding UTF8

$programs = [Environment]::GetFolderPath('Programs')
$shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $programs 'Assistente IA.lnk'))
$shortcut.TargetPath = Join-Path $PSHOME 'powershell.exe'
$shortcut.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $directory 'Start-AssistenteIA.ps1') + '"'
$shortcut.WorkingDirectory = $directory
$shortcut.IconLocation = (Join-Path $portal 'public\assets\icon.ico')
$shortcut.Description = 'Assistente IA by Diogo Moreira'
$shortcut.Save()

if (-not $NoLaunch) { & (Join-Path $directory 'Start-AssistenteIA.ps1') }
Write-Output "Installed at $directory"
