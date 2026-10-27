# Builds the portable release: build\Hidden-Cube-Chaser-<version>-win-x64.zip
# Needs `npm install` (and `node node_modules\electron\install.js` if npm skipped it) first.
# Usage: powershell -ExecutionPolicy Bypass -File tools\build-portable.ps1
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$version = (Get-Content "$root\package.json" -Raw | ConvertFrom-Json).version
$electron = "$root\node_modules\electron\dist"
if (-not (Test-Path "$electron\electron.exe")) { throw "Electron is missing: run npm install, then node node_modules\electron\install.js" }

$out = "$root\build\Hidden Cube Chaser"
if (Test-Path $out) { Remove-Item $out -Recurse -Force -Confirm:$false }
New-Item -ItemType Directory -Force $out | Out-Null

Copy-Item "$electron\*" $out -Recurse
Rename-Item "$out\electron.exe" "Hidden Cube Chaser.exe"
Remove-Item "$out\resources\default_app.asar" -ErrorAction SilentlyContinue

$app = "$out\resources\app"
New-Item -ItemType Directory -Force $app | Out-Null
Copy-Item "$root\src", "$root\assets" $app -Recurse
Copy-Item "$root\package.json" $app
Copy-Item "$root\README.md" $out

$zip = "$root\build\Hidden-Cube-Chaser-$version-win-x64.zip"
if (Test-Path $zip) { Remove-Item $zip -Force -Confirm:$false }
Compress-Archive -Path $out -DestinationPath $zip -CompressionLevel Optimal
Write-Output $zip
