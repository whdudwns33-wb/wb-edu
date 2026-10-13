/**
 * 운영 모드 공통 환경.
 *  - 저장소 루트의 .env.prod (또는 WB_ENV_FILE 로 지정한 파일)를 읽어 환경변수로 만든다.
 *  - 이미 셸에 있는 값이 우선한다.
 *  - WB_MODE=prod 로 고정해 운영 DB(server/data/wb-edu.sqlite)를 쓴다.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
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
  const env = { ...process.env };
  const file = envFilePath();
  let loaded = false;
  if (existsSync(file)) {
    for (const [k, v] of Object.entries(parseEnvFile(readFileSync(file, 'utf8')))) if (!(k in process.env)) env[k] = v;
    loaded = true;
  }
  env.WB_MODE = 'prod';
  // 실행기와 서버의 작업 폴더가 달라도 같은 파일을 사용한다.
  for (const key of ['WB_DB_PATH', 'WB_BACKUP_DIR', 'WB_LOG_DIR', 'WB_STATIC_DIR']) {
    if (env[key]) env[key] = resolve(ROOT, env[key]);
  }
  const dbPath = env.WB_DB_PATH || join(ROOT, 'server', 'data', 'wb-edu.sqlite');
  const demoPath = join(ROOT, 'server', 'data', 'wb-edu.demo.sqlite');
  const canonical = (path) => {
    const value = existsSync(path) ? realpathSync(path) : path;
    return process.platform === 'win32' ? value.toLowerCase() : value;
  };
  if (canonical(dbPath) === canonical(demoPath)) throw new Error('운영 DB 경로가 데모 DB와 같습니다. WB_DB_PATH를 별도 파일로 바꾸세요.');
  env.WB_DB_PATH = dbPath;
  return { env, file, loaded, dbPath };
}

/** tsx CLI 를 node 로 직접 실행할 때의 경로 (npm/.cmd 셸을 거치지 않음) */
export const TSX_CLI = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
