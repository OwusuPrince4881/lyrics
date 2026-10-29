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
$ffmpegVersion = (& $ffmpeg -version 2>&1 | Out-String)
if ($LASTEXITCODE -ne 0) { throw 'Could not inspect the bundled FFmpeg version.' }
$ffprobeVersion = (& $ffprobe -version 2>&1 | Out-String)
if ($LASTEXITCODE -ne 0) { throw 'Could not inspect the bundled ffprobe version.' }
$ffmpegBuild = (& $ffmpeg -buildconf 2>&1 | Out-String)
if ($LASTEXITCODE -ne 0) { throw 'Could not inspect the bundled FFmpeg build configuration.' }
$ffprobeBuild = (& $ffprobe -buildconf 2>&1 | Out-String)
if ($LASTEXITCODE -ne 0) { throw 'Could not inspect the bundled ffprobe build configuration.' }
$ffmpegConfiguration = ($ffmpegVersion -split '\r?\n' |
  Where-Object { $_ -match '^\s*configuration:' } |
  Select-Object -First 1)
$ffprobeConfiguration = ($ffprobeVersion -split '\r?\n' |
  Where-Object { $_ -match '^\s*configuration:' } |
  Select-Object -First 1)
if (-not $ffmpegConfiguration -or -not $ffprobeConfiguration) {
  throw 'FFmpeg or ffprobe did not report a configuration line from -version.'
}
Write-Output ($ffmpegVersion -split '\r?\n' | Select-Object -First 1)
Write-Output $ffmpegConfiguration
if ("$ffmpegVersion`n$ffprobeVersion`n$ffmpegBuild`n$ffprobeBuild" -match '--enable-(gpl|nonfree)') {
  throw 'The bundled FFmpeg enables GPL or nonfree components and cannot pass this release gate.'
}
if ("$ffmpegVersion`n$ffprobeVersion" -match '--enable-version3') {
  Write-Warning 'The bundled FFmpeg enables LGPL version 3 components; include the LGPL v3 notices.'
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
$manifestAiUrl = if ($aiUrl) {
  $aiUrl
} else {
  'https://TODO-REPLACE-WITH-AI-PACK-GITHUB-RELEASE-ASSET.invalid/lyrics-ai-pack-win-x64.zip'
}

New-Item -ItemType Directory -Force -Path $staging | Out-Null
$config = @{
  acoustidApiKey = $env:LYRICS_ACOUSTID_API_KEY
  aiPackUrl = $manifestAiUrl
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
