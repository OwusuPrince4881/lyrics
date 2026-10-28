$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$backendExe = Join-Path $root 'backend\dist\lyrics-pipeline\lyrics-pipeline.exe'
$toolsDir = Join-Path $root 'resources\windows-x64\bin'
$staging = Join-Path $root 'build\staging'

if (-not (Test-Path $backendExe)) {
  throw 'Build the Python backend first with npm run build:backend.'
}
foreach ($tool in @('ffmpeg.exe', 'ffprobe.exe', 'fpcalc.exe')) {
  if (-not (Test-Path (Join-Path $toolsDir $tool))) {
    throw "Required bundled tool is missing: resources\windows-x64\bin\$tool"
  }
}
$ffmpeg = Join-Path $toolsDir 'ffmpeg.exe'
$ffprobe = Join-Path $toolsDir 'ffprobe.exe'
$ffmpegBuild = (& $ffmpeg -buildconf 2>&1 | Out-String)
if ($LASTEXITCODE -ne 0) { throw 'Could not inspect the bundled FFmpeg build configuration.' }
$ffprobeBuild = (& $ffprobe -buildconf 2>&1 | Out-String)
if ($LASTEXITCODE -ne 0) { throw 'Could not inspect the bundled ffprobe build configuration.' }
if ($ffmpegBuild -match '--enable-(gpl|nonfree)' -or
    $ffprobeBuild -match '--enable-(gpl|nonfree)') {
  throw 'The bundled FFmpeg enables GPL or nonfree components and cannot pass this release gate.'
}
$notices = Get-Content -LiteralPath (Join-Path $root 'THIRD_PARTY_LICENSES') -Raw
if ($notices -match 'No .* binary is currently included|Before release|Generate and review') {
  throw 'Complete THIRD_PARTY_LICENSES with the exact bundled versions, license texts, and source details.'
}

$aiUrl = $env:LYRICS_AI_PACK_URL
$aiSha256 = $env:LYRICS_AI_PACK_SHA256
if ([string]::IsNullOrWhiteSpace($aiUrl) -xor [string]::IsNullOrWhiteSpace($aiSha256)) {
  throw 'Set both LYRICS_AI_PACK_URL and LYRICS_AI_PACK_SHA256, or leave both unset.'
}
if ($aiSha256 -and $aiSha256 -notmatch '^[A-Fa-f0-9]{64}$') {
  throw 'LYRICS_AI_PACK_SHA256 must be a 64-character SHA-256 hex digest.'
}
if ($aiUrl -and -not $aiUrl.StartsWith('https://', [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'LYRICS_AI_PACK_URL must use HTTPS.'
}

New-Item -ItemType Directory -Force -Path $staging | Out-Null
$config = @{
  acoustidApiKey = $env:LYRICS_ACOUSTID_API_KEY
  aiPackUrl = $aiUrl
  aiPackSha256 = if ($aiSha256) { $aiSha256.ToLowerInvariant() } else { $null }
}
$configJson = $config | ConvertTo-Json
[System.IO.File]::WriteAllText(
  (Join-Path $staging 'app-config.json'),
  $configJson,
  [System.Text.UTF8Encoding]::new($false)
)

Push-Location $root
try {
  & (Join-Path $root 'node_modules\.bin\electron-builder.cmd') --win nsis
  if ($LASTEXITCODE -ne 0) { throw 'electron-builder failed to create the Windows NSIS installer.' }
} finally {
  Pop-Location
}
