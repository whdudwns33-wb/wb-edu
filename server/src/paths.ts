import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
export const SERVER_ROOT = resolve(here, '..');
export const REPO_ROOT = resolve(SERVER_ROOT, '..');

/**
 * DB 경로.
 *  - WB_DB_PATH 환경변수가 있으면 그대로 사용
 *  - WB_MODE=prod 이면 server/data/wb-edu.sqlite (실제 운영)
 *  - 그 외(기본)는 server/data/wb-edu.demo.sqlite (데모·개발)
 * 데모와 운영 DB 파일을 분리해 샘플 데이터가 운영 데이터와 섞이지 않게 한다.
 */
export function resolveDbPath(): string {
  if (process.env.WB_DB_PATH) return resolve(process.env.WB_DB_PATH);
  const prod = process.env.WB_MODE === 'prod';
  return join(SERVER_ROOT, 'data', prod ? 'wb-edu.sqlite' : 'wb-edu.demo.sqlite');
}

export function resolveStaticDir(): string {
  return process.env.WB_STATIC_DIR ? resolve(process.env.WB_STATIC_DIR) : join(REPO_ROOT, 'web', 'dist');
}
