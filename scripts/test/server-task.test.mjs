import { it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from '../prod-env.mjs';

it.skipIf(process.platform !== 'win32')('서버 작업은 부팅·무기한 반복·SYSTEM·중복 방지를 사용하고 다른 작업은 등록하지 않는다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-server-task-'));
  try {
    mkdirSync(join(dir, 'deploy/windows'), { recursive: true });
    mkdirSync(join(dir, 'web/dist'), { recursive: true });
    writeFileSync(join(dir, '.env.prod'), '');
    writeFileSync(join(dir, 'web/dist/index.html'), '리허설');
    copyFileSync(join(ROOT, 'deploy/windows/register-server.ps1'), join(dir, 'deploy/windows/register-server.ps1'));
    const check = `
$ErrorActionPreference = 'Stop'
function New-ScheduledTaskAction { param($Execute,$Argument,$WorkingDirectory) if ($Execute -notlike '*node.exe' -or $Argument -ne ('"' + (Join-Path $env:WB_TASK_TEST_ROOT 'scripts\\start-prod.mjs') + '" --log-file')) { throw '실행기 오류' }; return @{} }
function New-ScheduledTaskTrigger { param([switch]$AtStartup,[switch]$Once,$At,$RepetitionInterval) if ($AtStartup) { return [pscustomobject]@{Delay='';Boot=$true} }; if (-not $Once -or $RepetitionInterval.TotalSeconds -ne 60 -or $PSBoundParameters.ContainsKey('RepetitionDuration')) { throw '반복 오류' }; return [pscustomobject]@{Retry=$true} }
function New-ScheduledTaskSettingsSet { param($RestartCount,$RestartInterval,$ExecutionTimeLimit,$MultipleInstances,[switch]$StartWhenAvailable,[switch]$AllowStartIfOnBatteries,[switch]$DontStopIfGoingOnBatteries) if ($RestartCount -ne 999 -or $RestartInterval.TotalSeconds -ne 60 -or $ExecutionTimeLimit.TotalSeconds -ne 0 -or $MultipleInstances -ne 'IgnoreNew' -or -not $StartWhenAvailable -or -not $AllowStartIfOnBatteries -or -not $DontStopIfGoingOnBatteries) { throw '설정 오류' }; return @{} }
function New-ScheduledTaskPrincipal { param($UserId,$LogonType,$RunLevel) if ($UserId -ne 'SYSTEM' -or $LogonType -ne 'ServiceAccount' -or $RunLevel -ne 'Limited') { throw '계정 오류' }; return @{} }
$global:wbTaskRegistered = 0
function Register-ScheduledTask { param($TaskName,$Action,$Trigger,$Settings,$Principal,[switch]$Force) if ($TaskName -ne 'WB Planner Server' -or $Trigger.Count -ne 2 -or $Trigger[0].Delay -ne 'PT20S' -or -not $Trigger[1].Retry -or -not $Force) { throw '대상 오류' }; $global:wbTaskRegistered++ }
try { & (Join-Path $env:WB_TASK_TEST_ROOT 'deploy/windows/register-server.ps1'); if ($global:wbTaskRegistered -ne 1) { throw '등록 횟수 오류' }; exit 0 } catch { Write-Error $_; exit 1 }
`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'], { input: check, encoding: 'utf8', env: { ...process.env, WB_TASK_TEST_ROOT: dir }, timeout: 20000 });
    expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it.skipIf(process.platform !== 'win32')('정비 중에는 재시작 작업을 끄고 다시 시작할 때 켜며 다른 앱 프로세스는 종료하지 않는다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-server-control-'));
  try {
    mkdirSync(join(dir, 'deploy/windows'), { recursive: true });
    copyFileSync(join(ROOT, 'deploy/windows/server-control.ps1'), join(dir, 'deploy/windows/server-control.ps1'));
    const check = `
$ErrorActionPreference = 'Stop'
$global:wbEvents = @()
$global:wbKilled = @()
$rootPath = $env:WB_TASK_TEST_ROOT
$global:wbNodes = @([pscustomobject]@{ProcessId=101;ParentProcessId=1;CommandLine=\"node $rootPath\\scripts\\start-prod.mjs\"},[pscustomobject]@{ProcessId=102;ParentProcessId=101;CommandLine=\"node $rootPath\\server\\src\\index.ts\"},[pscustomobject]@{ProcessId=103;ParentProcessId=1;CommandLine='node C:\\other-app\\scripts\\start-prod.mjs'})
function Get-CimInstance { param($ClassName,$Filter) return @($global:wbNodes | Where-Object { $global:wbKilled -notcontains $_.ProcessId }) }
function Get-NetTCPConnection { param($LocalPort,$State,$ErrorAction) if ($global:wbKilled -notcontains 102) { return [pscustomobject]@{OwningProcess=102} } }
function Get-ScheduledTask { param($TaskName,$ErrorAction) return [pscustomobject]@{State='Running'} }
function Disable-ScheduledTask { param($TaskName) if ($TaskName -ne 'WB Planner Server') { throw '다른 작업' }; $global:wbEvents += 'disable' }
function Enable-ScheduledTask { param($TaskName) $global:wbEvents += 'enable' }
function Stop-ScheduledTask { param($TaskName,$ErrorAction) $global:wbEvents += 'stop' }
function Start-ScheduledTask { param($TaskName) $global:wbEvents += 'start' }
function Stop-Process { param($Id,[switch]$Force,$ErrorAction) if ($Id -eq 103) { throw '다른 앱 종료 시도' }; $global:wbKilled += $Id }
function Start-Sleep { param($Seconds,$Milliseconds) }
function Invoke-RestMethod { param($Uri,$TimeoutSec) return @{mode='prod'} }
try {
 & (Join-Path $rootPath 'deploy/windows/server-control.ps1') stop
 if (($global:wbKilled | Sort-Object) -join ',' -ne '101,102' -or $global:wbEvents -join ',' -ne 'disable,stop') { throw '정지 검증 실패' }
 & (Join-Path $rootPath 'deploy/windows/server-control.ps1') start
 if ($global:wbEvents -join ',' -ne 'disable,stop,enable,start') { throw '시작 검증 실패' }
 exit 0
} catch { Write-Error $_; exit 1 }
`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'], { input: check, encoding: 'utf8', env: { ...process.env, WB_TASK_TEST_ROOT: dir }, timeout: 20000 });
    expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
