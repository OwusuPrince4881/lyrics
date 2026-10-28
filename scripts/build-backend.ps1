$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$python = Get-Command python -ErrorAction Stop
$venv = Join-Path $root '.packaging-venv'
$venvPython = Join-Path $venv 'Scripts\python.exe'
$workDir = Join-Path $root '.build\backend'
$distDir = Join-Path $root 'backend\dist'

if (-not (Test-Path $venvPython)) {
  & $python.Source -m venv $venv
  if ($LASTEXITCODE -ne 0) { throw 'Could not create the backend packaging environment.' }
}

& $venvPython -m pip install -r (Join-Path $root 'backend\requirements-default.txt')
if ($LASTEXITCODE -ne 0) { throw 'Could not install default backend build dependencies.' }
& $venvPython -m PyInstaller `
  --noconfirm `
  --clean `
  --onedir `
  --name lyrics-pipeline `
  --distpath $distDir `
  --workpath $workDir `
  --specpath $workDir `
  --paths (Join-Path $root 'backend') `
  --hidden-import acoustid `
  --collect-all syncedlyrics `
  (Join-Path $root 'backend\pipeline.py')
if ($LASTEXITCODE -ne 0) { throw 'PyInstaller failed to build the default backend.' }

Write-Output "Backend ready at $(Join-Path $distDir 'lyrics-pipeline')"
