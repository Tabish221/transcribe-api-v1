<#
.SYNOPSIS
    Builds dist\transcribe-api-server-<version>.zip (the files to upload to cPanel).

.DESCRIPTION
    The zip holds the CONTENTS of server\ with no top folder: extract it inside the folder that
    should serve the app (a subdomain's document root, or e.g. public_html/transcribe).

    Never packed: config.php (secrets), SQLite databases, uploads, logs, sessions, lock files and
    .gitignore files. The storage folders keep their .htaccess and .gitkeep placeholder files, so they
    exist after extraction. Entry names use forward slashes, as Linux hosts expect.

    With -IncludeN8n the n8n community node is also packed (npm pack) into the same folder.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File tools\package-server.ps1 -IncludeN8n
#>
[CmdletBinding()]
param(
    [string]$OutDir,
    [switch]$IncludeN8n
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$server = Join-Path $root 'server'
if (-not $OutDir) { $OutDir = Join-Path $root 'dist' }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$OutDir = (Resolve-Path $OutDir).Path

# Version from server/src/bootstrap.php: define('TAPI_VERSION', 'x.y.z');
$bootstrap = Get-Content -Raw (Join-Path $server 'src\bootstrap.php')
if ($bootstrap -notmatch "TAPI_VERSION',\s*'([^']+)'") { throw 'TAPI_VERSION not found in server/src/bootstrap.php' }
$version = $Matches[1]

# Inside storage/ only these placeholder files are packed; everything else there is runtime data.
$storageKeep = @(
    'storage/.htaccess',
    'storage/uploads/.gitkeep', 'storage/logs/.gitkeep', 'storage/sessions/.gitkeep',
    'storage/uploads/.htaccess', 'storage/logs/.htaccess', 'storage/sessions/.htaccess',
    'storage/uploads/index.html', 'storage/logs/index.html', 'storage/sessions/index.html'
)

function Test-Packed([string]$rel) {
    $name = ($rel -split '/')[-1]
    if ($rel -like 'storage/*') { return $storageKeep -contains $rel }
    if ($rel -eq 'config.php' -or $rel -like 'config.php.tmp*') { return $false } # secrets / installer temp file
    if ($rel -match '\.(sqlite3?|db)(-wal|-shm|-journal)?$') { return $false }  # databases anywhere
    if (@('.gitignore', 'installed.lock', 'cron.lock', 'Thumbs.db', 'desktop.ini', '.DS_Store') -contains $name) { return $false }
    return $true
}

# Collect files (including dotfiles such as .htaccess and .user.ini) with paths relative to server/.
$files = Get-ChildItem -LiteralPath $server -Recurse -File -Force | ForEach-Object {
    $rel = $_.FullName.Substring($server.Length + 1).Replace('\', '/')
    if (Test-Packed $rel) { [pscustomobject]@{ Path = $_.FullName; Name = $rel } }
} | Sort-Object Name

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$zipPath = Join-Path $OutDir "transcribe-api-server-$version.zip"
if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
$zip = [System.IO.Compression.ZipFile]::Open($zipPath, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($f in $files) {
        [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
            $zip, $f.Path, $f.Name, [System.IO.Compression.CompressionLevel]::Optimal)
    }
} finally {
    $zip.Dispose()
}

# Verify: read the zip back, check the must-have files and that nothing private slipped in.
$zip = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
try { $entries = @($zip.Entries | ForEach-Object { $_.FullName }) } finally { $zip.Dispose() }

$required = @('index.php', 'install.php', '.htaccess', '.user.ini', 'config.sample.php', 'cron/process.php',
    'cron/.htaccess', 'src/.htaccess', 'src/bootstrap.php', 'app/index.html', 'app/app.js', 'app/app.css',
    'storage/.htaccess', 'storage/uploads/.gitkeep', 'storage/logs/.gitkeep', 'storage/sessions/.gitkeep')
$missing = @($required | Where-Object { $entries -notcontains $_ })
$private = @($entries | Where-Object { -not (Test-Packed $_) -or $_.Contains('\') })
if ($missing.Count -gt 0) { throw "Missing from the zip: $($missing -join ', ')" }
if ($private.Count -gt 0) { throw "Must not be in the zip: $($private -join ', ')" }

$size = (Get-Item -LiteralPath $zipPath).Length
$hash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLower()
Write-Host "Server package: $zipPath"
Write-Host ("  {0} files, {1:N0} KB, SHA-256 {2}" -f $entries.Count, ($size / 1KB), $hash)
Write-Host '  Checked: required files present; no config.php, database, upload, log, session or lock file.'

if ($IncludeN8n) {
    # npm writes progress to stderr; only its exit code matters.
    $ErrorActionPreference = 'Continue'
    Push-Location (Join-Path $root 'n8n-nodes-transcribe-api')
    try {
        $tgz = & npm.cmd pack --silent --pack-destination $OutDir
        if ($LASTEXITCODE -ne 0) { throw "npm pack failed (exit code $LASTEXITCODE)" }
    } finally {
        Pop-Location
    }
    Write-Host "n8n node package: $(Join-Path $OutDir ($tgz | Select-Object -Last 1))"
}
