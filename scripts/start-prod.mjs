#!/usr/bin/env node
/**
 * 운영 모드 실행기 (Windows/macOS/Linux 공통).
 *  - 저장소 루트의 .env.prod 를 읽어 환경변수로 넣는다 (있으면).
 *  - WB_MODE=prod 로 고정해 운영 DB(server/data/wb-edu.sqlite)를 쓴다.
 *  - 운영 DB가 아직 없고 WB_ADMIN_PASSWORD 가 비어 있으면 기본 비밀번호로 관리자가 만들어지는 것을 막기 위해 중단한다.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envFile = join(root, '.env.prod');
const env = { ...process.env, WB_MODE: 'prod' };

if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    if (!(m[1] in process.env)) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  console.log(`.env.prod 적용`);
}

const dbPath = env.WB_DB_PATH ? resolve(env.WB_DB_PATH) : join(root, 'server', 'data', 'wb-edu.sqlite');
if (!existsSync(dbPath) && !env.WB_ADMIN_PASSWORD) {
  console.error('운영 DB가 아직 없습니다. 첫 실행에서는 초기 관리자 비밀번호를 WB_ADMIN_PASSWORD 로 지정해야 합니다.');
  console.error('예) .env.prod 파일에  WB_ADMIN_USER=admin  과  WB_ADMIN_PASSWORD=강한비밀번호  를 적고 다시 실행하세요. (.env.prod.example 참고)');
  process.exit(1);
}
if (!existsSync(join(root, 'web', 'dist', 'index.html'))) {
  console.error('웹앱이 빌드되지 않았습니다. 먼저  npm run build  를 실행하세요.');
  process.exit(1);
}

console.log(`운영 모드 시작 · DB: ${dbPath} · 포트: ${env.PORT ?? 3987} · 호스트: ${env.HOST ?? '127.0.0.1'}`);
// npm/.cmd 셸 우회 없이 tsx CLI 를 node 로 직접 실행한다 (Windows 에서도 동일하게 동작)
const tsxCli = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const child = spawn(process.execPath, [tsxCli, join(root, 'server', 'src', 'index.ts')], { cwd: join(root, 'server'), env, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
