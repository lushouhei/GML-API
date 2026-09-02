# 用途：一键部署 GML-API 到 Cloudflare Workers（自带前置检查，避免白跑一趟）
# 路径：01_PROJECTS/GML-API/scripts/deploy.ps1
# 运行：在项目根目录执行 -> powershell -ExecutionPolicy Bypass -File scripts\deploy.ps1

$ErrorActionPreference = "Stop"

# 切到项目根目录（脚本在 scripts/ 下，所以要往上一级）
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
Write-Host "项目目录: $Root" -ForegroundColor Cyan

# ---------- 第 1 步：检查 wrangler.toml 是否存在 ----------
if (-not (Test-Path "wrangler.toml")) {
    Write-Host "[X] 没找到 wrangler.toml" -ForegroundColor Red
    Write-Host "    请先运行: Copy-Item config\wrangler.toml.example wrangler.toml" -ForegroundColor Yellow
    Write-Host "    然后按文件里的【必填】注释填写两个值" -ForegroundColor Yellow
    exit 1
}

$conf = Get-Content "wrangler.toml" -Raw -Encoding UTF8

# ---------- 第 2 步：检查两个必填项有没有真的填 ----------
if ($conf -match 'ADMIN_KEY\s*=\s*"把这里换成') {
    Write-Host "[X] wrangler.toml 里的 ADMIN_KEY 还没改" -ForegroundColor Red
    Write-Host "    生成一个随机密钥: [guid]::NewGuid().ToString('N')" -ForegroundColor Yellow
    exit 1
}
if ($conf -match 'ADMIN_KEY\s*=\s*"(changeme)?"') {
    Write-Host "[X] ADMIN_KEY 为空或仍是默认值 changeme，管理接口会被任何人调用" -ForegroundColor Red
    exit 1
}
if ($conf -match 'id\s*=\s*""') {
    Write-Host "[X] wrangler.toml 里的 KV id 还是空的" -ForegroundColor Red
    Write-Host "    请先运行: npx wrangler kv namespace create GLM_TOKENS" -ForegroundColor Yellow
    Write-Host "    把输出里的那串 id 填进 wrangler.toml" -ForegroundColor Yellow
    exit 1
}
Write-Host "[OK] 配置检查通过" -ForegroundColor Green

# ---------- 第 3 步：安装依赖（只在缺失时装，省时间） ----------
if (-not (Test-Path "node_modules")) {
    Write-Host "正在安装依赖（首次约 1-2 分钟）..." -ForegroundColor Cyan
    npm install
    if ($LASTEXITCODE -ne 0) { Write-Host "[X] npm install 失败" -ForegroundColor Red; exit 1 }
}
Write-Host "[OK] 依赖就绪" -ForegroundColor Green

# ---------- 第 4 步：部署 ----------
Write-Host "开始部署到 Cloudflare（首次会弹浏览器让你登录授权）..." -ForegroundColor Cyan
npx wrangler deploy
if ($LASTEXITCODE -ne 0) {
    Write-Host "[X] 部署失败，请看上面的报错信息" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "==================================================" -ForegroundColor Green
Write-Host "[OK] 部署成功！" -ForegroundColor Green
Write-Host "下一步：运行 scripts\setup_keys.ps1 添加你的 token 和 API Key" -ForegroundColor Yellow
Write-Host "==================================================" -ForegroundColor Green
