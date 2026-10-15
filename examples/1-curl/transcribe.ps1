<#
.SYNOPSIS
  Transcribe one audio file with the Transcribe API.
  Windows PowerShell 5.1 + curl.exe. No other tools needed.

.DESCRIPTION
  1. Read the settings from ..\.env (real environment variables win).
  2. Upload the file with curl.exe (multipart/form-data).
  3. Ask GET /api/v1/transcriptions/{id} every few seconds until the job is done.
  4. Print the text and save <name>.txt and <name>.srt in the "output" folder.

.EXAMPLE
  .\transcribe.ps1
  .\transcribe.ps1 C:\calls\call-001.mp3
  .\transcribe.ps1 C:\calls\call-001.mp3 -Language de -Engine worker
  .\transcribe.ps1 C:\calls\call-001.mp3 -Engine cloud -Wait
#>
param(
    # Audio file to transcribe. Default: ..\sample\clip.mp3 (40 s sample call).
    [Parameter(Position = 0)] [string] $File,
    # worker = your PC worker, cloud = Groq/OpenAI. Default: TRANSCRIBE_ENGINE from .env.
    [string] $Engine,
    # ISO-639-1 code, for example en, de, ur. "auto" = detect the language.
    # Default: TRANSCRIBE_LANGUAGE from .env (empty = the project's default language).
    [string] $Language,
    # Cloud only: the server transcribes inside the upload request. No polling needed.
    [switch] $Wait,
    # Where the .txt and .srt files go. Default: the "output" folder next to this script.
    [string] $OutDir,
    [int] $PollSeconds = 5,
    [int] $TimeoutMinutes = 60
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $File) { $File = Join-Path $here '..\sample\clip.mp3' }
if (-not $OutDir) { $OutDir = Join-Path $here 'output' }

# curl.exe prints UTF-8. Tell PowerShell, so non-English text is not broken.
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

# ---------------------------------------------------------------------------
# Settings: read KEY=VALUE lines from ..\.env. Lines starting with # are comments.
# A real environment variable with the same name wins over the file.
# ---------------------------------------------------------------------------
function Read-DotEnv([string] $Path) {
    $values = @{}
    if (Test-Path -LiteralPath $Path) {
        foreach ($line in Get-Content -LiteralPath $Path -Encoding UTF8) {
            $line = $line.Trim()
            if ($line -eq '' -or $line.StartsWith('#')) { continue }
            $eq = $line.IndexOf('=')
            if ($eq -lt 1) { continue }
            $values[$line.Substring(0, $eq).Trim()] = $line.Substring($eq + 1).Trim().Trim('"').Trim("'")
        }
    }
    return $values
}

$dotEnv = Read-DotEnv (Join-Path $here '..\.env')

function Get-Setting([string] $Name, [string] $Default = '') {
    $fromEnvironment = [Environment]::GetEnvironmentVariable($Name)
    if ($fromEnvironment) { return $fromEnvironment }
    if ($dotEnv.ContainsKey($Name) -and $dotEnv[$Name] -ne '') { return $dotEnv[$Name] }
    return $Default
}

function Fail([string] $Message) {
    Write-Host ''
    Write-Host "ERROR: $Message" -ForegroundColor Red
    exit 1
}

$ApiUrl = (Get-Setting 'TRANSCRIBE_API_URL').TrimEnd('/')
$ApiKey = Get-Setting 'TRANSCRIBE_API_KEY'
if (-not $Engine) { $Engine = Get-Setting 'TRANSCRIBE_ENGINE' 'worker' }
if (-not $Language) { $Language = Get-Setting 'TRANSCRIBE_LANGUAGE' '' }
if ($Wait -and $Engine -ne 'cloud') {
    Write-Host 'Note: -Wait only works with -Engine cloud. The script polls instead.' -ForegroundColor Yellow
    $Wait = $false
}

if (-not $ApiUrl) { Fail 'TRANSCRIBE_API_URL is missing. Add it to ..\.env' }
if (-not $ApiKey) { Fail 'TRANSCRIBE_API_KEY is missing. Add it to ..\.env' }
if (-not (Test-Path -LiteralPath $File -PathType Leaf)) { Fail "File not found: $File" }

$FilePath = (Resolve-Path -LiteralPath $File).Path
$headers = @{ Authorization = "Bearer $ApiKey" }

# Never print the full key. The first 7 characters are enough to see which key it is.
$keyHint = $ApiKey.Substring(0, [Math]::Min(7, $ApiKey.Length)) + '...'
# Empty = not sent = the project default language. "auto" = Whisper detects the language.
$langText = $Language
if (-not $langText) { $langText = '(project default)' }

Write-Host 'Transcribe API - PowerShell + curl.exe demo' -ForegroundColor Cyan
Write-Host "  Server:   $ApiUrl"
Write-Host "  Key:      $keyHint"
Write-Host "  File:     $FilePath"
$waitText = ''
if ($Wait) { $waitText = '    wait: yes' }
Write-Host "  Engine:   $Engine    Language: $langText$waitText"
Write-Host ''

# ---------------------------------------------------------------------------
# Step 1: upload with curl.exe (PowerShell 5.1 has no easy multipart upload).
# -w adds the HTTP status code as the last line of the output.
# ---------------------------------------------------------------------------
if ($Wait) { Write-Host 'Uploading and transcribing (cloud, wait=true)...' } else { Write-Host 'Uploading...' }
$curlArgs = @(
    '-sS', '-X', 'POST', "$ApiUrl/api/v1/transcriptions",
    '-H', "Authorization: Bearer $ApiKey",
    '-F', "file=@$FilePath",
    '-F', "engine=$Engine",
    '-w', '\n%{http_code}'
)
if ($Language) { $curlArgs += @('-F', "language=$Language") }
if ($Wait) { $curlArgs += @('-F', 'wait=true') }

$lines = @(& curl.exe @curlArgs)
if ($LASTEXITCODE -ne 0) { Fail "curl.exe could not reach $ApiUrl (curl exit code $LASTEXITCODE)." }

$httpCode = [int]$lines[-1]
$body = ''
if ($lines.Count -gt 1) { $body = $lines[0..($lines.Count - 2)] -join "`n" }

$job = $null
try { $job = $body | ConvertFrom-Json } catch { }
if ($httpCode -ge 400 -or -not $job -or -not $job.id) {
    $message = "HTTP $httpCode $body"
    if ($job -and $job.error) { $message = "$($job.error.message) ($($job.error.code), HTTP $httpCode)" }
    Fail "Upload failed: $message"
}

$id = $job.id
Write-Host "  Created $id (status: $($job.status))" -ForegroundColor Green
Write-Host ''

# ---------------------------------------------------------------------------
# Step 2: poll until status is "completed" or "failed".
# The worker takes jobs one by one, so "queued" can last a while.
# ---------------------------------------------------------------------------
# (With -Wait on cloud the upload answer is already finished, so the loop is skipped.)
if ($job.status -ne 'completed' -and $job.status -ne 'failed') {
    Write-Host "Waiting for the result (checking every $PollSeconds s, Ctrl+C to stop)..."
}
$started = Get-Date
$lastLine = ''
$lastPrint = 0
$errorsInRow = 0

while ($job.status -ne 'completed' -and $job.status -ne 'failed') {
    Start-Sleep -Seconds $PollSeconds
    $elapsed = [int]((Get-Date) - $started).TotalSeconds
    if ($elapsed -gt $TimeoutMinutes * 60) {
        Fail "Still not done after $TimeoutMinutes minutes. The job keeps running on the server: $id"
    }

    try {
        $job = Invoke-RestMethod -Method Get -Uri "$ApiUrl/api/v1/transcriptions/$id" -Headers $headers
        $errorsInRow = 0
    } catch {
        # A short network problem should not stop the demo. Try again a few times.
        $errorsInRow++
        $detail = $_.Exception.Message
        if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $detail = $_.ErrorDetails.Message }
        if ($errorsInRow -ge 5) { Fail "Status check failed 5 times: $detail" }
        Write-Host "  (status check failed, trying again: $detail)" -ForegroundColor Yellow
        continue
    }

    $line = $job.status
    if ($null -ne $job.progress) { $line = "$($job.status) $($job.progress)%" }
    # Print when something changed, or every 30 s so you know it is still alive.
    if ($line -ne $lastLine -or ($elapsed - $lastPrint) -ge 30) {
        Write-Host ("  [{0,4} s] {1}" -f $elapsed, $line)
        $lastLine = $line
        $lastPrint = $elapsed
    }
}

if ($job.status -eq 'failed') { Fail "Transcription failed: $($job.error)" }

# ---------------------------------------------------------------------------
# Step 3: print the text and download .txt + .srt (?format=txt|srt|vtt|json).
# ---------------------------------------------------------------------------
Write-Host ''
Write-Host ("Done. Audio length: {0} s, language: {1}" -f $job.duration, $job.detected_language) -ForegroundColor Green
Write-Host ''
Write-Host '--- Transcript ---' -ForegroundColor Cyan
Write-Host $job.text
Write-Host '------------------' -ForegroundColor Cyan
Write-Host ''

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$baseName = [IO.Path]::GetFileNameWithoutExtension($FilePath)
foreach ($format in @('txt', 'srt')) {
    $target = Join-Path $OutDir "$baseName.$format"
    # -OutFile writes the raw bytes (UTF-8) exactly as the server sent them.
    Invoke-WebRequest -UseBasicParsing -Method Get -Uri "$ApiUrl/api/v1/transcriptions/$id`?format=$format" `
        -Headers $headers -OutFile $target
    Write-Host "Saved $target"
}
Write-Host ''
Write-Host "Transcription id: $id (also visible in the dashboard)"
exit 0
