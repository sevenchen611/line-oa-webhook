# SevenAM 本機 worker 啟動器：崩潰自動重啟（快速失敗時退避 5 分鐘）。
# 用法：pwsh -File scripts/start-local-worker.ps1
$ErrorActionPreference = 'Continue'
Set-Location (Split-Path $PSScriptRoot -Parent)
$logDir = Join-Path (Get-Location) 'logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory $logDir | Out-Null }

while ($true) {
  $started = Get-Date
  $logFile = Join-Path $logDir ("worker-{0}.log" -f (Get-Date -Format 'yyyyMMdd'))
  "[$(Get-Date -Format o)] worker starting" | Add-Content $logFile
  & node scripts/local-worker.js 2>&1 | Tee-Object -FilePath $logFile -Append
  $exitCode = $LASTEXITCODE
  $ranSeconds = ((Get-Date) - $started).TotalSeconds
  "[$(Get-Date -Format o)] worker exited code=$exitCode after ${ranSeconds}s" | Add-Content $logFile

  if ($exitCode -eq 2) {
    # 認證失敗：等 10 分鐘再試（等使用者完成 claude /login）
    Start-Sleep -Seconds 600
  } elseif ($ranSeconds -lt 60) {
    # 快速崩潰：退避 5 分鐘避免無限快速重啟
    Start-Sleep -Seconds 300
  } else {
    Start-Sleep -Seconds 10
  }
}
