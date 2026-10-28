$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$python = Get-Command python -ErrorAction Stop
$venv = Join-Path $root '.packaging-ai-venv'
$venvPython = Join-Path $venv 'Scripts\python.exe'
$workDir = Join-Path $root '.build\ai-pack'
$distDir = Join-Path $root 'build\ai-pack'
$workerDir = Join-Path $distDir 'worker'

if (-not (Test-Path $venvPython)) {
  & $python.Source -m venv $venv
  if ($LASTEXITCODE -ne 0) { throw 'Could not create the AI-pack packaging environment.' }
}
& $venvPython -m pip install -r (Join-Path $root 'backend\requirements-ai-pack.txt')
if ($LASTEXITCODE -ne 0) { throw 'Could not install AI-pack build dependencies.' }

New-Item -ItemType Directory -Force -Path $workerDir | Out-Null
& $venvPython -m PyInstaller --noconfirm --clean --onedir `
  --name lyrics-ai-worker `
  --distpath $workerDir `
  --workpath $workDir `
  --specpath $workDir `
  --paths (Join-Path $root 'backend') `
  --hidden-import acoustid `
  --collect-all syncedlyrics `
  --collect-all faster_whisper `
  --collect-all ctranslate2 `
  --collect-all demucs `
  --collect-all torch `
  --collect-all torchaudio `
  (Join-Path $root 'backend\pipeline.py')
if ($LASTEXITCODE -ne 0) { throw 'PyInstaller failed to build the AI transcription worker.' }

$archivePath = Join-Path $distDir 'lyrics-ai-pack-win-x64.zip'
if (Test-Path $archivePath) { Remove-Item -LiteralPath $archivePath }
Compress-Archive -Path $workerDir -DestinationPath $archivePath
$hash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
Set-Content -LiteralPath "$archivePath.sha256" -Value $hash -NoNewline
Write-Output "AI pack: $archivePath"
Write-Output "SHA-256: $hash"
