<#
.SYNOPSIS
  운영 서버 멈추기·다시 시작하기·상태 보기 (학원 PC 한 대 구성).
  작업 스케줄러의 '작업 끝내기'(Stop-ScheduledTask)는 숨긴 PowerShell 창만 닫고 그 아래 서버(node) 프로세스는 남긴다.
  남은 서버가 포트를 계속 쥐고 있으면 새 서버가 뜨지 못하므로, 이 스크립트로 서버 프로세스까지 정리한다.

.USAGE
  저장소 루트에서 (SYSTEM 작업이면 관리자 PowerShell 사용):
    powershell -ExecutionPolicy Bypass -File deploy\windows\server-control.ps1 restart
    powershell -ExecutionPolicy Bypass -File deploy\windows\server-control.ps1 stop
    powershell -ExecutionPolicy Bypass -File deploy\windows\server-control.ps1 start
    powershell -ExecutionPolicy Bypass -File deploy\windows\server-control.ps1 status
#>
param(
  [ValidateSet('restart', 'stop', 'start', 'status')]
  [string]$Action = 'status'
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$task = 'WB Planner Server'

function Get-ServerProcesses {
  # 운영 서버만 고른다: 운영 실행기(start-prod.mjs)와 그 하위 프로세스, 그리고 운영 포트를 쥔 프로세스와 그 node 상위 프로세스.
  # 같은 서버 파일을 쓰는 개발용 데모 서버(3988)는 건드리지 않는다.
  $all = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'")
  $pick = @{}
  foreach ($p in $all) { if ($p.CommandLine -like '*scripts\start-prod.mjs*' -and $p.CommandLine.IndexOf($root.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -ge 0) { $pick[$p.ProcessId] = $p } }
  $port = Get-Port
  $listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($listener) {
    $cur = $all | Where-Object { $_.ProcessId -eq $listener.OwningProcess }
    if (-not $cur -or (-not $cur.CommandLine -or $cur.CommandLine.IndexOf($root.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -lt 0)) { throw '운영 포트를 쓰는 프로세스의 소속을 확인할 수 없습니다. 관리자 권한과 다른 앱의 포트 사용을 확인하세요. 다른 앱은 종료하지 않았습니다.' }
    while ($cur -and $cur.CommandLine -and ($cur.CommandLine.IndexOf($root.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -ge 0 -or $cur.CommandLine -match '[" ]scripts\\start-prod\.mjs')) {
      $pick[$cur.ProcessId] = $cur
      $parentId = $cur.ParentProcessId
      $cur = $all | Where-Object { $_.ProcessId -eq $parentId }
    }
  }
  $changed = $true
  while ($changed) {
    $changed = $false
    foreach ($p in $all) {
      if (-not $pick.ContainsKey($p.ProcessId) -and $pick.ContainsKey($p.ParentProcessId)) { $pick[$p.ProcessId] = $p; $changed = $true }
    }
  }
  return $pick.Values
}

function Get-Port {
  $port = 3987
  $envFile = Join-Path $root '.env.prod'
  if (Test-Path $envFile) {
    $m = Select-String -Path $envFile -Pattern '^\s*PORT\s*=\s*(\d+)' | Select-Object -First 1
    if ($m) { $port = [int]$m.Matches[0].Groups[1].Value }
  }
  return $port
}

function Stop-Server {
  if (Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue) {
    Disable-ScheduledTask -TaskName $task | Out-Null
    Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
  }
  $procs = @(Get-ServerProcesses)
  foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 1
  $left = @(Get-ServerProcesses)
  if ($left.Count) { throw "서버 프로세스 $($left.Count)개를 끝내지 못했습니다: $($left.ProcessId -join ', ')" }
  Write-Host "서버를 멈췄습니다 (정리한 프로세스 $($procs.Count)개)."
}

function Start-Server {
  Enable-ScheduledTask -TaskName $task | Out-Null
  if (@(Get-ServerProcesses).Count) { Write-Host '이미 서버가 실행 중입니다. 다시 시작하려면 restart 를 쓰세요.'; return }
  Start-ScheduledTask -TaskName $task
  $port = Get-Port
  for ($i = 0; $i -lt 40; $i++) {
    try {
      $h = Invoke-RestMethod "http://127.0.0.1:$port/api/health" -TimeoutSec 2
      Write-Host "서버가 켜졌습니다: http://127.0.0.1:$port (모드: $($h.mode))"
      return
    } catch { Start-Sleep -Milliseconds 750 }
  }
  throw "서버가 30초 안에 응답하지 않습니다. server\data\logs 의 기록을 확인하세요."
}

switch ($Action) {
  'stop' { Stop-Server }
  'start' { Start-Server }
  'restart' { Stop-Server; Start-Server }
  'status' {
    $port = Get-Port
    $procs = @(Get-ServerProcesses)
    $state = (Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue).State
    try { $h = Invoke-RestMethod "http://127.0.0.1:$port/api/health" -TimeoutSec 2; $health = "응답함 (모드: $($h.mode))" } catch { $health = '응답 없음' }
    Write-Host "작업 상태: $state · 서버 프로세스: $($procs.Count)개 · http://127.0.0.1:${port}: $health"
  }
}
