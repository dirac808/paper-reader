$ErrorActionPreference = 'Stop'

$listenAddress = '100.109.100.82'
$apiPort = 18180
$minerUApi = 'D:\anaconda\envs\paperreader\Scripts\mineru-api.exe'
$stateRoot = Join-Path $env:LOCALAPPDATA 'PaperReader\MinerUApi'
$taskRoot = Join-Path $stateRoot 'tasks'
$logRoot = Join-Path $stateRoot 'logs'

New-Item -ItemType Directory -Force -Path $taskRoot, $logRoot | Out-Null

for ($attempt = 0; $attempt -lt 120; $attempt += 1) {
    $tailnetAddress = Get-NetIPAddress -IPAddress $listenAddress -ErrorAction SilentlyContinue
    if ($tailnetAddress) {
        break
    }
    Start-Sleep -Seconds 1
}
if (-not $tailnetAddress) {
    throw "Tailscale address $listenAddress was not available after 120 seconds."
}

$existingListener = Get-NetTCPConnection -LocalAddress $listenAddress -LocalPort $apiPort -State Listen -ErrorAction SilentlyContinue
if ($existingListener) {
    exit 0
}

$env:CUDA_VISIBLE_DEVICES = '0'
$env:MINERU_MODEL_SOURCE = 'local'
$env:MINERU_API_MAX_CONCURRENT_REQUESTS = '1'
$env:MINERU_PROCESSING_WINDOW_SIZE = '2'
$env:MINERU_PDF_RENDER_THREADS = '1'
$env:MINERU_API_ENABLE_FASTAPI_DOCS = '0'
$env:MINERU_API_TASK_RETENTION_SECONDS = '3600'
$env:MINERU_API_TASK_CLEANUP_INTERVAL_SECONDS = '300'
$env:MINERU_API_OUTPUT_ROOT = $taskRoot

$logFile = Join-Path $logRoot 'mineru-api.log'
Set-Location $stateRoot
$ErrorActionPreference = 'Continue'
& $minerUApi --host $listenAddress --port $apiPort --enable-vlm-preload false *>> $logFile
