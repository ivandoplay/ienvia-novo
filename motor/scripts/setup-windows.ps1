# Instalador portatil para Windows (PowerShell), sem administrador.
$ErrorActionPreference = "Stop"

$RootDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $RootDir

$NodeVersion = "v24.22.3"
$RuntimeDir = Join-Path $RootDir ".runtime\node"
$LocalNode = Join-Path $RuntimeDir "node.exe"

function Get-IenviaNode {
  if (Test-Path $LocalNode) {
    $major = [int]((& $LocalNode -p "process.versions.node.split('.')[0]") 2>$null)
    if ($LASTEXITCODE -eq 0 -and $major -ge 24) { return $LocalNode }
  }
  $sys = Get-Command node -ErrorAction SilentlyContinue
  if ($sys) {
    $major = [int]((& $sys.Source -p "process.versions.node.split('.')[0]") 2>$null)
    if ($major -ge 24) { return $sys.Source }
  }
  return $null
}

$NodeBin = Get-IenviaNode
if (-not $NodeBin) {
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "win-arm64" } else { "win-x64" }
  $zipName = "node-$NodeVersion-$arch.zip"
  $baseUrl = "https://nodejs.org/dist/$NodeVersion"
  $tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ("ienvia-node-" + [guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Path $tmpDir | Out-Null

  try {
    Write-Host "[Ienvia] Baixando Node.js portatil $NodeVersion ($arch)..."
    $zipPath = Join-Path $tmpDir $zipName
    $sumsPath = Join-Path $tmpDir "SHASUMS256.txt"
    Invoke-WebRequest -Uri "$baseUrl/$zipName" -OutFile $zipPath -UseBasicParsing
    Invoke-WebRequest -Uri "$baseUrl/SHASUMS256.txt" -OutFile $sumsPath -UseBasicParsing

    $expectedLine = (Get-Content $sumsPath | Where-Object { $_ -match "\s+$zipName$" }) | Select-Object -First 1
    if (-not $expectedLine) { throw "SHA-256 de $zipName nao encontrado." }
    $expectedHash = ($expectedLine -split "\s+")[0].ToLower()
    $actualHash = (Get-FileHash -Path $zipPath -Algorithm SHA256).Hash.ToLower()
    if ($actualHash -ne $expectedHash) { throw "Falha na verificacao SHA-256 do Node.js!" }

    $extractDir = Join-Path $tmpDir "extract"
    Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force
    $inner = Get-ChildItem -Path $extractDir -Directory | Select-Object -First 1
    New-Item -ItemType Directory -Path (Split-Path $RuntimeDir -Parent) -Force | Out-Null
    if (Test-Path $RuntimeDir) { Remove-Item -Recurse -Force $RuntimeDir }
    Move-Item -Path $inner.FullName -Destination $RuntimeDir
    $NodeBin = $LocalNode
  } finally {
    Remove-Item -Recurse -Force $tmpDir -ErrorAction SilentlyContinue
  }
}

$env:PATH = "$(Split-Path $NodeBin -Parent);$env:PATH"
$NpmCmd = Join-Path (Split-Path $NodeBin -Parent) "npm.cmd"
if (-not (Test-Path $NpmCmd)) { $NpmCmd = (Get-Command npm.cmd -ErrorAction Stop).Source }
$Lock = Join-Path $RootDir "package-lock.json"
$StampInput = (Get-FileHash (Join-Path $RootDir "package.json") -Algorithm SHA256).Hash
if (Test-Path $Lock) { $StampInput += (Get-FileHash $Lock -Algorithm SHA256).Hash }
$StampPath = Join-Path $RootDir "node_modules\.ienvia-deps-windows"
$OldStamp = if (Test-Path $StampPath) { (Get-Content $StampPath -Raw).Trim() } else { "" }
if ($StampInput -ne $OldStamp) {
  Write-Host "[Ienvia] Instalando dependencias; data/ sera preservada."
  if (Test-Path $Lock) {
    & $NpmCmd ci --omit=dev --omit=optional --ignore-scripts --no-audit --no-fund
  } else {
    & $NpmCmd install --omit=dev --omit=optional --ignore-scripts --no-audit --no-fund
  }
  if ($LASTEXITCODE -ne 0) { throw "Falha na instalacao das dependencias (codigo $LASTEXITCODE)." }
  Set-Content -Path $StampPath -Value $StampInput
}
Write-Host "[Ienvia] Preparacao concluida."
