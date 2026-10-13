#!/usr/bin/env node
/**
 * 학원 PC 운영 준비 점검 (npm run setup:prod).
 *  1. Node 버전 확인 (22.13 이상, 내장 SQLite 사용)
 *  2. .env.prod 가 없으면 예시 파일로 만들고 초기 관리자 비밀번호를 무작위로 넣는다
 *     (비밀번호는 화면에 출력하지 않는다. .env.prod 파일을 열어 확인)
 *  3. 관리자 아이디 형식, 접속 주소(HOST) 확인
 *  4. 웹앱 빌드 여부, 운영 DB 상태, 데모 DB와 분리되어 있는지 확인
 * 고칠 것이 있으면 무엇을 하면 되는지 알려 주고 끝낸다. 시스템 설정은 바꾸지 않는다.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, envFilePath, loadProdEnv } from './prod-env.mjs';

const ok = (m) => console.log(`  [확인] ${m}`);
const todo = [];
const warn = (m) => {
  console.log(`  [할 일] ${m}`);
  todo.push(m);
};

console.log('WB 커리큘럼 플래너 · 학원 PC 운영 준비 점검\n');

// 1. Node
const [maj, min] = process.versions.node.split('.').map(Number);
if (maj > 22 || (maj === 22 && min >= 13)) ok(`Node ${process.versions.node}`);
else warn(`Node ${process.versions.node} → 22.13 이상으로 올리세요 (https://nodejs.org 의 LTS).`);

// 2. .env.prod
const file = envFilePath();
if (!existsSync(file)) {
  const example = readFileSync(join(ROOT, '.env.prod.example'), 'utf8');
  const password = randomBytes(15).toString('base64url'); // 20자 무작위
  const text = example
    .replace(/^WB_ADMIN_PASSWORD=.*$/m, `WB_ADMIN_PASSWORD=${password}`)
    .replace(/^HOST=.*$/m, 'HOST=127.0.0.1');
  writeFileSync(file, text, { encoding: 'utf8', flag: 'wx' });
  ok(`${file} 를 만들었습니다. 초기 관리자 비밀번호는 무작위로 넣었고 화면에는 보이지 않습니다. 파일을 열어 확인하세요.`);
} else ok(`${file} 있음`);

const { env: values, dbPath } = loadProdEnv();
const user = values.WB_ADMIN_USER || 'admin';
if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(user)) warn(`WB_ADMIN_USER '${user}' 는 로그인할 수 없는 형식입니다. 영문·숫자 3~32자로 바꾸세요.`);
else ok(`관리자 아이디: ${user}`);
const pw = values.WB_ADMIN_PASSWORD ?? '';
if (!existsSync(dbPath) && (!pw || /여기에|admin1234|password/i.test(pw) || pw.length < 10 || pw.length > 1024)) warn('WB_ADMIN_PASSWORD 가 비었거나 약합니다. 10~1024자 강한 값으로 바꾸세요.');
const host = values.HOST || '127.0.0.1';
const port = Number(values.PORT ?? 3987);
if (!Number.isInteger(port) || port < 1 || port > 65535) warn('PORT 는 1~65535 사이의 정수여야 합니다.');
if (host === '127.0.0.1' || host === 'localhost') ok(`접속 주소 http://${host}:${port} (이 PC에서만 접속)`);
else warn(`HOST=${host} 는 다른 기기에서도 접속할 수 있게 엽니다. 학원 PC 한 대 구성이면 127.0.0.1 로 두세요.`);

// 3. 빌드·DB
if (existsSync(join(values.WB_STATIC_DIR || join(ROOT, 'web', 'dist'), 'index.html'))) ok('웹앱 빌드 있음');
else warn('웹앱이 빌드되지 않았습니다.  npm run build  를 실행하세요.');
if (!existsSync(join(ROOT, 'node_modules', 'tsx'))) warn('패키지가 설치되지 않았습니다.  npm install  을 실행하세요.');

if (existsSync(dbPath)) {
  ok(`운영 DB 있음: ${dbPath} (기존 관리자 계정은 그대로 사용합니다. 앱에서 비밀번호를 바꾼 뒤 초기 비밀번호 줄을 지워도 됩니다)`);
} else ok(`운영 DB는 첫 실행 때 만들어집니다: ${dbPath} (샘플 데이터 없음, 데모 DB와 별도 파일)`);

console.log('');
if (todo.length) {
  console.log(`먼저 할 일 ${todo.length}건을 처리한 뒤 다시 실행하세요.`);
  process.exit(1);
}
console.log('준비가 끝났습니다. 다음 순서로 진행하세요.');
console.log(`  1) 처음 한 번 실행해 확인:   npm run start:prod   → 브라우저에서 http://${host}:${port} 접속, 관리자로 로그인`);
console.log('  2) 설정 → 내 계정에서 비밀번호 변경, 설정 → 사용자·권한에서 강사 계정 만들기');
console.log('  3) Ctrl+C로 서버를 끈 뒤, 관리자 PowerShell 에서 자동 시작·매일 백업 등록:');
console.log('       powershell -ExecutionPolicy Bypass -File deploy\\windows\\register-tasks.ps1');
console.log('  4) 백업 확인:   npm run backup:prod');
