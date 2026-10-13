#!/usr/bin/env node
/**
 * 운영 모드 실행기 (Windows/macOS/Linux 공통).
 *  - .env.prod 를 읽어 환경변수로 넣고 WB_MODE=prod 로 운영 DB(server/data/wb-edu.sqlite)를 쓴다.
 *  - 운영 DB가 아직 없고 WB_ADMIN_PASSWORD 가 비어 있으면 기본 비밀번호로 관리자가 만들어지는 것을 막기 위해 중단한다.
 *  - 창 없이(작업 스케줄러 등, 또는 --log-file) 실행되면 화면 대신 server/data/logs/server-YYYY-MM.log 에 기록을 남긴다
 *    (WB_LOG_DIR 로 폴더 변경). 터미널에서 실행하면 화면에 그대로 보인다.
 */
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ROOT, TSX_CLI, loadProdEnv } from './prod-env.mjs';

const { env, file, loaded, dbPath } = loadProdEnv();

// --log-file: 창을 숨긴 채 실행할 때(작업 스케줄러) 기록을 파일로 남긴다
const interactive = process.stdout.isTTY && !process.argv.includes('--log-file');
let log = null;
if (!interactive) {
  const dir = env.WB_LOG_DIR ? resolve(env.WB_LOG_DIR) : join(ROOT, 'server', 'data', 'logs');
  mkdirSync(dir, { recursive: true });
  const month = new Date().toISOString().slice(0, 7);
  log = createWriteStream(join(dir, `server-${month}.log`), { flags: 'a' });
}
const say = (msg) => (log ? log.write(`[${new Date().toISOString()}] ${msg}\n`) : console.log(msg));
const fail = (msg) => {
  if (log) log.write(`[${new Date().toISOString()}] 오류: ${msg}\n`);
  console.error(msg);
  process.exit(1);
};

if (loaded) say(`환경 파일 적용: ${file}`);
if (!existsSync(dbPath) && !env.WB_ADMIN_PASSWORD) {
  fail('운영 DB가 아직 없습니다. 첫 실행에서는 초기 관리자 비밀번호를 WB_ADMIN_PASSWORD 로 지정해야 합니다. 먼저  npm run setup:prod  를 실행하세요.');
}
if (!existsSync(join(ROOT, 'web', 'dist', 'index.html'))) {
  fail('웹앱이 빌드되지 않았습니다. 먼저  npm run build  를 실행하세요.');
}

say(`운영 모드 시작 · DB: ${dbPath} · 주소: http://${env.HOST ?? '127.0.0.1'}:${env.PORT ?? 3987}`);
const child = spawn(process.execPath, [TSX_CLI, join(ROOT, 'server', 'src', 'index.ts')], {
  cwd: join(ROOT, 'server'),
  env,
  stdio: log ? ['ignore', 'pipe', 'pipe'] : 'inherit',
});
if (log) {
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
}
// 작업 스케줄러가 작업을 끝내면 서버도 함께 끝낸다
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, () => child.kill());
child.on('exit', (code) => {
  say(`서버 종료 (코드 ${code ?? 0})`);
  process.exit(code ?? 0);
});
