# 用途：部署完成后，把智谱 refresh_token 灌进 Worker 的 Token 池，并生成一个你自己用的 API Key
# 路径：01_PROJECTS/GML-API/scripts/setup_keys.ps1
# 运行：powershell -ExecutionPolicy Bypass -File scripts\setup_keys.ps1
# 前置：已成功部署 Worker，且 config/token.txt 里填好了 refresh_token

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

# ---------- 第 1 步：从 wrangler.toml 里自动读出 ADMIN_KEY，省得你手抄 ----------
if (-not (Test-Path "wrangler.toml")) { Write-Host "[X] 找不到 wrangler.toml，请先部署" -ForegroundColor Red; exit 1 }
$conf = Get-Content "wrangler.toml" -Raw -Encoding UTF8
if ($conf -notmatch 'ADMIN_KEY\s*=\s*"([^"]+)"') { Write-Host "[X] wrangler.toml 里读不到 ADMIN_KEY" -ForegroundColor Red; exit 1 }
$AdminKey = $Matches[1]
Write-Host "[OK] 已读取 ADMIN_KEY" -ForegroundColor Green

# ---------- 第 2 步：问你的 Worker 地址 ----------
Write-Host ""
Write-Host "请输入你的 Worker 地址（部署成功时终端最后一行打印的那个网址）" -ForegroundColor Cyan
Write-Host "例如: https://glm-2api.你的用户名.workers.dev" -ForegroundColor DarkGray
$BaseUrl = (Read-Host "Worker 地址").Trim().TrimEnd('/')
if (-not $BaseUrl.StartsWith("http")) { $BaseUrl = "https://$BaseUrl" }

# ---------- 第 3 步：读 config/token.txt 里的智谱 refresh_token ----------
$TokenFile = Join-Path $Root "config\token.txt"
if (-not (Test-Path $TokenFile)) {
    Write-Host "[X] 找不到 config\token.txt" -ForegroundColor Red
    Write-Host "    请先: Copy-Item config\token.txt.example config\token.txt 并填入真实 token" -ForegroundColor Yellow
    exit 1
}
# 过滤掉注释行(#开头)和空行
$tokens = Get-Content $TokenFile -Encoding UTF8 | Where-Object { $_.Trim() -ne "" -and -not $_.Trim().StartsWith("#") }
if ($tokens.Count -eq 0) { Write-Host "[X] token.txt 里没有有效 token" -ForegroundColor Red; exit 1 }
Write-Host "[OK] 读到 $($tokens.Count) 个 refresh_token" -ForegroundColor Green

$headers = @{ "X-Admin-Key" = $AdminKey; "Content-Type" = "application/json" }

# ---------- 第 4 步：逐个把 refresh_token 推进 Worker 的 Token 池 ----------
foreach ($t in $tokens) {
    $body = @{ refresh_token = $t.Trim() } | ConvertTo-Json -Compress
    try {
        $r = Invoke-RestMethod -Uri "$BaseUrl/admin/token" -Method Post -Headers $headers -Body $body
        Write-Host "  [OK] Token 已入池, id = $($r.id)" -ForegroundColor Green
    } catch {
        Write-Host "  [X] 入池失败: $($_.Exception.Message)" -ForegroundColor Red
    }
}

# ---------- 第 5 步：生成一个随机 API Key（这是你以后在客户端里填的那个 key） ----------
$ApiKey = "sk-glm-" + [guid]::NewGuid().ToString("N")
$body = @{ api_key = $ApiKey } | ConvertTo-Json -Compress
try {
    Invoke-RestMethod -Uri "$BaseUrl/admin/apikey" -Method Post -Headers $headers -Body $body | Out-Null
    Write-Host "[OK] API Key 已创建" -ForegroundColor Green
} catch {
    Write-Host "[X] 创建 API Key 失败: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

# ---------- 第 6 步：实测一次对话，确认整条链路真的通 ----------
Write-Host ""
Write-Host "正在实测一次对话（验证整条链路）..." -ForegroundColor Cyan
$testBody = @{
    model = "glm-4.7"
    messages = @(@{ role = "user"; content = "回复两个字：收到" })
    stream = $false
} | ConvertTo-Json -Depth 5 -Compress
try {
    $resp = Invoke-RestMethod -Uri "$BaseUrl/v1/chat/completions" -Method Post `
        -Headers @{ "Authorization" = "Bearer $ApiKey"; "Content-Type" = "application/json" } `
        -Body ([System.Text.Encoding]::UTF8.GetBytes($testBody))
    Write-Host "[OK] 模型回复: $($resp.choices[0].message.content)" -ForegroundColor Green
} catch {
    Write-Host "[!] 实测对话失败: $($_.Exception.Message)" -ForegroundColor Yellow
    Write-Host "    Token 和 Key 已配置好，但上游接口可能有问题，见 docs\部署指南.md 排错章节" -ForegroundColor Yellow
}

# ---------- 第 7 步：把结果写进 config/secrets.txt（已被 .gitignore 排除） ----------
$out = @"
# GML-API 配置结果 (自动生成于 $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
# 此文件含密钥，已被 .gitignore 排除，不要外传

接口地址 (Base URL) = $BaseUrl/v1
你的 API Key        = $ApiKey
管理密钥 ADMIN_KEY  = $AdminKey
管理面板            = $BaseUrl/admin
"@
$out | Out-File -FilePath (Join-Path $Root "config\secrets.txt") -Encoding utf8

Write-Host ""
Write-Host "==================================================" -ForegroundColor Green
Write-Host "全部完成！以下信息已保存到 config\secrets.txt" -ForegroundColor Green
Write-Host "==================================================" -ForegroundColor Green
Write-Host "接口地址: $BaseUrl/v1"
Write-Host "API Key : $ApiKey"
Write-Host "管理面板: $BaseUrl/admin"
