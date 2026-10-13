/**
 * 운영 모드 공통 환경.
 *  - 저장소 루트의 .env.prod (또는 WB_ENV_FILE 로 지정한 파일)를 읽어 환경변수로 만든다.
 *  - 이미 셸에 있는 값이 우선한다.
 *  - WB_MODE=prod 로 고정해 운영 DB(server/data/wb-edu.sqlite)를 쓴다.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function envFilePath() {
  return process.env.WB_ENV_FILE ? resolve(process.env.WB_ENV_FILE) : join(ROOT, '.env.prod');
}

/** .env 형식(KEY=값, # 주석) 읽기 */
export function parseEnvFile(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().startsWith('#')) continue;
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

export function loadProdEnv() {
  const env = { ...process.env, WB_MODE: 'prod' };
  const file = envFilePath();
  let loaded = false;
  if (existsSync(file)) {
    for (const [k, v] of Object.entries(parseEnvFile(readFileSync(file, 'utf8')))) if (!(k in process.env)) env[k] = v;
    loaded = true;
  }
  const dbPath = env.WB_DB_PATH ? resolve(env.WB_DB_PATH) : join(ROOT, 'server', 'data', 'wb-edu.sqlite');
  return { env, file, loaded, dbPath };
}

/** tsx CLI 를 node 로 직접 실행할 때의 경로 (npm/.cmd 셸을 거치지 않음) */
export const TSX_CLI = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
