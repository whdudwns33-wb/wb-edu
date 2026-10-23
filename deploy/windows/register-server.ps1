<# 플래너 서버 작업만 등록한다. 백업·다른 앱 작업은 변경하지 않는다. #>
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$node = (Get-Command node -ErrorAction Stop).Source
if (-not (Test-Path (Join-Path $root '.env.prod'))) { throw '.env.prod가 없습니다. 운영 설정을 먼저 확인하세요.' }
if (-not (Test-Path (Join-Path $root 'web\dist\index.html'))) { throw '웹앱 빌드가 없습니다.' }

# PowerShell 중간 창 없이 실행해 서버 종료 코드를 작업 스케줄러가 직접 받는다.
$action = New-ScheduledTaskAction -Execute $node -Argument ('"' + (Join-Path $root 'scripts\start-prod.mjs') + '" --log-file') -WorkingDirectory $root
$boot = New-ScheduledTaskTrigger -AtStartup
$boot.Delay = 'PT20S'
# 정상 종료·재시도 소진·작업 종료 뒤에도 다시 실행한다. 실행 중이면 IgnoreNew로 중복을 막는다.
$retry = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Limited
Register-ScheduledTask -TaskName 'WB Planner Server' -Action $action -Trigger @($boot, $retry) -Settings $settings -Principal $principal -Force | Out-Null
Write-Host '플래너 서버 등록: 로그인 없이 부팅 시 시작, 종료 후 1분 간격 재시도, 중복 실행 방지.'
