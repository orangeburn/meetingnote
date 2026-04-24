[CmdletBinding()]
param(
  [switch]$Clean
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $projectRoot

function Write-Step {
  param([string]$Message)
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Assert-Command {
  param(
    [string]$Name,
    [string]$InstallHint
  )

  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "未找到命令 '$Name'。$InstallHint"
  }
}

Write-Step "检查打包环境"
Assert-Command -Name "node" -InstallHint "请先安装 Node.js，并确保 node/npm 已加入 PATH。"
Assert-Command -Name "npm" -InstallHint "请先安装 Node.js，并确保 npm 已加入 PATH。"

if (-not (Test-Path ".\package.json")) {
  throw "当前目录下未找到 package.json：$projectRoot"
}

if (-not (Test-Path ".\node_modules")) {
  Write-Step "安装 Node.js 依赖"
  npm install
  if ($LASTEXITCODE -ne 0) {
    throw "npm install 执行失败。"
  }
}

if ($Clean) {
  Write-Step "清理旧的打包产物"
  if (Test-Path ".\dist") {
    Remove-Item -LiteralPath ".\dist" -Recurse -Force
  }
}

Write-Step "开始构建并打包 EXE"
npm run dist
if ($LASTEXITCODE -ne 0) {
  throw "npm run dist 执行失败。"
}

$installer = Get-ChildItem -Path ".\dist" -Filter "*Setup*.exe" -File -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1

$portableExe = Get-ChildItem -Path ".\dist\win-unpacked" -Filter "*.exe" -File -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -ne "elevate.exe" } |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1

Write-Step "打包完成"
if ($installer) {
  Write-Host ("安装包: " + $installer.FullName) -ForegroundColor Green
}
if ($portableExe) {
  Write-Host ("解压版可执行文件: " + $portableExe.FullName) -ForegroundColor Green
}
if (-not $installer -and -not $portableExe) {
  Write-Warning "未在 dist 目录下找到预期产物，请检查打包日志。"
}
