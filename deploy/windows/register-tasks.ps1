<#
.SYNOPSIS
  WB 커리큘럼 플래너를 Windows 작업 스케줄러에 등록한다.
  - "WB Planner Server": 로그온 시 자동 시작 (npm run start:prod), 실패하면 1분 뒤 재시작(최대 3회)
  - "WB Planner Backup": 매일 지정 시각에 운영 DB 백업 (npm run backup)

.USAGE
  관리자 PowerShell 에서 저장소 루트로 이동한 뒤:
    powershell -ExecutionPolicy Bypass -File deploy\windows\register-tasks.ps1
    powershell -ExecutionPolicy Bypass -File deploy\windows\register-tasks.ps1 -BackupTime 23:30
    powershell -ExecutionPolicy Bypass -File deploy\windows\register-tasks.ps1 -Remove

  사전 조건: .env.prod 작성, npm run build 완료.
#>
param(
  [string]$BackupTime = '23:00',
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$node = (Get-Command node).Source
$serverTask = 'WB Planner Server'
$backupTask = 'WB Planner Backup'

if ($Remove) {
  foreach ($t in @($serverTask, $backupTask)) {
    if (Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue) {
      Unregister-ScheduledTask -TaskName $t -Confirm:$false
      Write-Host "삭제: $t"
    }
  }
  exit 0
}

if (-not (Test-Path (Join-Path $root '.env.prod'))) { throw '.env.prod 가 없습니다. .env.prod.example 을 복사해 관리자 비밀번호를 적으세요.' }
if (-not (Test-Path (Join-Path $root 'web\dist\index.html'))) { throw '웹앱이 빌드되지 않았습니다. 먼저 npm run build 를 실행하세요.' }

$user = "$env:USERDOMAIN\$env:USERNAME"

# 서버: 로그온 시 시작, 실패 시 재시작
$serverAction = New-ScheduledTaskAction -Execute $node -Argument '"scripts\start-prod.mjs"' -WorkingDirectory $root
$serverTrigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$serverSettings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Days 3650) -StartWhenAvailable
Register-ScheduledTask -TaskName $serverTask -Action $serverAction -Trigger $serverTrigger -Settings $serverSettings -User $user -Force | Out-Null
Write-Host "등록: $serverTask (로그온 시 자동 시작)"

# 백업: 매일 지정 시각
$backupScript = Join-Path $root 'node_modules\tsx\dist\cli.mjs'
$backupAction = New-ScheduledTaskAction -Execute $node -Argument "`"$backupScript`" `"server\src\backup.ts`"" -WorkingDirectory $root
$backupTrigger = New-ScheduledTaskTrigger -Daily -At $BackupTime
$backupSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
# 운영 DB 를 백업하도록 WB_MODE=prod 환경을 작업에 심는다 (작업 스케줄러는 환경변수를 직접 받지 않으므로 cmd 래퍼 사용)
$backupAction = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c set WB_MODE=prod&& `"$node`" `"$backupScript`" `"server\src\backup.ts`"" -WorkingDirectory $root
Register-ScheduledTask -TaskName $backupTask -Action $backupAction -Trigger $backupTrigger -Settings $backupSettings -User $user -Force | Out-Null
Write-Host "등록: $backupTask (매일 $BackupTime, 운영 DB)"

Write-Host ''
Write-Host '지금 바로 서버를 시작하려면:  Start-ScheduledTask -TaskName "WB Planner Server"'
Write-Host '상태 확인:                     Get-ScheduledTask -TaskName "WB Planner*" | Get-ScheduledTaskInfo'
