<#
.SYNOPSIS
  Builds AssistenteIA-Windows-x64.zip. Assistente IA by Diogo Moreira, MIT License.
.DESCRIPTION
  Inputs that are not stored in the repository:
    -AgentZip   PhoneBox agent for Windows x64 (PhoneBoxAgent-<version>-win-x64.zip from github.com/ersinkoc/phonebox releases)
    -PythonZip  Python embeddable package for Windows x64 (python.org, 3.12 or newer)
    -Apk        the signed Android app (see ../android/README.md), optional
  The installer checks both archives against the SHA-256 values written into it at build time.
#>
param(
    [Parameter(Mandatory)][string]$AgentZip,
    [Parameter(Mandatory)][string]$PythonZip,
    [string]$Apk,
    [string]$Output = (Join-Path $PSScriptRoot 'AssistenteIA-Windows-x64.zip')
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot
$stage = Join-Path ([IO.Path]::GetTempPath()) ('assistente-package-' + [guid]::NewGuid())
$payload = Join-Path $stage 'payload'
$portal = Join-Path $payload 'portal'
New-Item -ItemType Directory -Force -Path $portal | Out-Null

$agentName = 'PhoneBoxAgent-0.9.25-win-x64.zip'
Copy-Item -LiteralPath $AgentZip -Destination (Join-Path $payload $agentName)
Copy-Item -LiteralPath $PythonZip -Destination (Join-Path $payload 'python-win-x64.zip')

foreach ($item in 'server.py', 'connector.py', 'webpush.py', 'certgen.py', 'lan_download.py', 'Start-Portal.ps1',
                  'requirements.txt', 'README.md', 'public') {
    Copy-Item -LiteralPath (Join-Path $repo "portal\$item") -Destination $portal -Recurse
}
Copy-Item -LiteralPath (Join-Path $repo 'LICENSE') -Destination $portal
# The embeddable Python has no pip, so the portal's only dependency travels in .deps.
& python -m pip install --quiet --target (Join-Path $portal '.deps') -r (Join-Path $repo 'portal\requirements.txt')
if ($Apk) {
    New-Item -ItemType Directory -Force -Path (Join-Path $portal 'downloads') | Out-Null
    Copy-Item -LiteralPath $Apk -Destination (Join-Path $portal 'downloads\AssistenteIA-Android.apk')
}

foreach ($file in 'Install-AssistenteIA.cmd', 'Start-AssistenteIA.ps1', 'Connect-Portal.cmd', 'Connect-Portal.ps1',
                  'README.txt', 'PhoneBox-LICENSE.txt', 'Lobe-Icons-LICENSE.txt') {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file) -Destination $stage
}
Copy-Item -LiteralPath (Join-Path $repo 'LICENSE') -Destination (Join-Path $stage 'LICENSE.txt')
$installer = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'Install-AssistenteIA.ps1')
$hashes = [ordered]@{
    'c20b196c7e7944a0499edfafa871e771e031044077b02e1598d0e73f56ba7784' = (Get-FileHash -LiteralPath $AgentZip -Algorithm SHA256).Hash.ToLower()
    '90905e64a840557d8c1bc4f5b74db3d7ee85e3ffb217611cac1c7813acea4159' = (Get-FileHash -LiteralPath $PythonZip -Algorithm SHA256).Hash.ToLower()
}
foreach ($old in $hashes.Keys) { $installer = $installer.Replace($old, $hashes[$old]) }
Set-Content -LiteralPath (Join-Path $stage 'Install-AssistenteIA.ps1') -Value $installer -Encoding UTF8

if (Test-Path $Output) { Remove-Item -LiteralPath $Output -Force }
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $Output
Remove-Item -LiteralPath $stage -Recurse -Force
Write-Output "Built $Output"
