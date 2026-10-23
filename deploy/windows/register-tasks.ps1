<#
.SYNOPSIS
  WB 커리큘럼 플래너를 Windows 작업 스케줄러에 등록한다 (학원 PC 한 대 구성).
  - "WB Planner Server": 로그인 없이 부팅 시 시작, 종료 후 1분 간격 재실행.
                         기록은 server\data\logs\server-YYYY-MM.log
  - "WB Planner Backup": 매일 지정 시각에 운영 DB 백업 (npm run backup:prod 와 같은 동작, .env.prod 의 백업 폴더 사용)
  - 바탕화면 바로가기 "WB 커리큘럼 플래너" (브라우저로 앱 열기)

.USAGE
  관리자 PowerShell 에서 저장소 루트로 이동한 뒤:
    powershell -ExecutionPolicy Bypass -File deploy\windows\register-tasks.ps1
    powershell -ExecutionPolicy Bypass -File deploy\windows\register-tasks.ps1 -BackupTime 23:30
    powershell -ExecutionPolicy Bypass -File deploy\windows\register-tasks.ps1 -NoShortcut
    powershell -ExecutionPolicy Bypass -File deploy\windows\register-tasks.ps1 -Remove

  사전 조건: npm run setup:prod 통과 (.env.prod 작성, npm run build 완료), npm run start:prod 로 한 번 실행해 로그인 확인.
#>
param(
  [string]$BackupTime = '23:00',
  [switch]$NoShortcut,
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$serverTask = 'WB Planner Server'
$backupTask = 'WB Planner Backup'
$shortcut = Join-Path ([Environment]::GetFolderPath('Desktop')) 'WB 커리큘럼 플래너.url'

if ($Remove) {
  # 작업을 멈춰도 서버(node) 프로세스는 남으므로 서버 정리 스크립트로 먼저 끈다
  & (Join-Path $PSScriptRoot 'server-control.ps1') stop
  foreach ($t in @($serverTask, $backupTask)) {
    if (Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue) {
      Stop-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue
      Unregister-ScheduledTask -TaskName $t -Confirm:$false
      Write-Host "삭제: $t"
    }
  }
  if (Test-Path $shortcut) { Remove-Item $shortcut; Write-Host "삭제: 바탕화면 바로가기" }
  exit 0
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'node 를 찾을 수 없습니다. Node.js 22.13 이상을 설치하세요.' }
$envFile = Join-Path $root '.env.prod'
if (-not (Test-Path $envFile)) { throw '.env.prod 가 없습니다. 먼저 npm run setup:prod 를 실행하세요.' }
if (-not (Test-Path (Join-Path $root 'web\dist\index.html'))) { throw '웹앱이 빌드되지 않았습니다. 먼저 npm run build 를 실행하세요.' }

# .env.prod 의 PORT (바로가기 주소용)
$port = 3987
$m = Select-String -Path $envFile -Pattern '^\s*PORT\s*=\s*(\d+)' | Select-Object -First 1
if ($m) { $port = [int]$m.Matches[0].Groups[1].Value }

$user = "$env:USERDOMAIN\$env:USERNAME"

# 서버 작업만 따로 복구할 수 있도록 등록을 분리한다.
& (Join-Path $PSScriptRoot 'register-server.ps1')

# 백업: 매일 지정 시각 (.env.prod 를 읽는 backup-prod.mjs)
$backupAction = New-ScheduledTaskAction -Execute $node -Argument '"scripts\backup-prod.mjs"' -WorkingDirectory $root
$backupTrigger = New-ScheduledTaskTrigger -Daily -At $BackupTime
$backupSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $backupTask -Action $backupAction -Trigger $backupTrigger -Settings $backupSettings -User $user -Force | Out-Null
Write-Host "등록: $backupTask (매일 $BackupTime, 운영 DB)"

if (-not $NoShortcut) {
  Set-Content -Path $shortcut -Value "[InternetShortcut]`r`nURL=http://127.0.0.1:$port/`r`n" -Encoding ASCII
  Write-Host "바탕화면 바로가기: $shortcut"
}

Write-Host ''
Write-Host '서버 켜기·끄기·다시 시작:     powershell -ExecutionPolicy Bypass -File deploy\windows\server-control.ps1 start|stop|restart|status'
Write-Host '상태 확인:                     Get-ScheduledTask -TaskName "WB Planner*" | Get-ScheduledTaskInfo'
Write-Host '백업이 되는지 바로 확인:       Start-ScheduledTask -TaskName "WB Planner Backup"  (server\data\backups 에 파일 생성)'
