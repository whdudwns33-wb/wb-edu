import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { ROOT, loadProdEnv, parseEnvFile } from '../prod-env.mjs';

const keys = ['WB_ENV_FILE', 'WB_MODE', 'WB_DB_PATH', 'WB_BACKUP_DIR', 'WB_LOG_DIR', 'WB_STATIC_DIR', 'WB_ADMIN_USER', 'WB_ADMIN_PASSWORD', 'HOST', 'PORT'];
let dir;
let file;
beforeEach(() => {
  for (const key of keys) vi.stubEnv(key, undefined);
  dir = mkdtempSync(join(tmpdir(), 'wb-prod-test-'));
  file = join(dir, 'rehearsal.env');
  vi.stubEnv('WB_ENV_FILE', file);
});
afterEach(() => {
  vi.unstubAllEnvs();
  expect(dirname(dir)).toBe(resolve(tmpdir()));
  rmSync(dir, { recursive: true, force: true });
});
const run = (script, args = []) => spawnSync(process.execPath, [join(ROOT, 'scripts', script), ...args], { cwd: ROOT, env: process.env, encoding: 'utf8', timeout: 15000 });

describe('운영 환경과 준비 점검', () => {
  it('운영 모드를 고정하고 서버·백업 경로를 저장소 기준으로 맞춘다', () => {
    writeFileSync(file, 'WB_MODE=demo\nWB_DB_PATH=data/custom.sqlite\nWB_BACKUP_DIR=data/backups\nWB_STATIC_DIR=web/dist\nWB_LOG_DIR=data/logs');
    vi.stubEnv('WB_MODE', 'demo');
    const { env, dbPath } = loadProdEnv();
    expect(env.WB_MODE).toBe('prod');
    expect(env.WB_DB_PATH).toBe(dbPath);
    expect(dbPath).toBe(join(ROOT, 'data', 'custom.sqlite'));
    expect(env.WB_BACKUP_DIR).toBe(join(ROOT, 'data', 'backups'));
    expect(env.WB_STATIC_DIR).toBe(join(ROOT, 'web', 'dist'));
    expect(env.WB_LOG_DIR).toBe(join(ROOT, 'data', 'logs'));
    vi.stubEnv('WB_MODE', undefined);
    expect(loadProdEnv().env.WB_MODE).toBe('prod');
  });

  it('운영 명령에 데모 DB를 지정하면 거부한다', () => {
    writeFileSync(file, 'WB_DB_PATH=server/data/wb-edu.demo.sqlite');
    expect(() => loadProdEnv()).toThrow('운영 DB 경로가 데모 DB와 같습니다');
  });

  it('실제로 우선 적용되는 셸 접속 주소와 포트를 점검한다', () => {
    writeFileSync(file, `HOST=127.0.0.1\nWB_ADMIN_PASSWORD=\"${'A'.repeat(20)}\"\nWB_DB_PATH=${join(dir, 'prod.sqlite')}`);
    vi.stubEnv('HOST', '0.0.0.0');
    vi.stubEnv('PORT', 'invalid');
    const result = run('setup-prod.mjs');
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('HOST=0.0.0.0');
    expect(result.stdout).toContain('PORT 는 1~65535');
    expect(result.stdout).not.toContain('이 PC에서만 접속');
    expect(existsSync(join(dir, 'prod.sqlite'))).toBe(false);
  });

  it('기존 DB의 초기 비밀번호를 지워도 다시 점검할 수 있다', () => {
    const db = join(dir, 'prod.sqlite');
    writeFileSync(db, '');
    const web = join(dir, 'web');
    mkdirSync(web);
    writeFileSync(join(web, 'index.html'), '<html></html>');
    writeFileSync(file, `HOST=127.0.0.1\nPORT=4567\nWB_DB_PATH=${db}\nWB_STATIC_DIR=${web}`);
    const result = run('setup-prod.mjs');
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('WB_ADMIN_PASSWORD 가 비었거나 약합니다');
    expect(result.stdout).toContain('http://127.0.0.1:4567');
  });

  it('임시 환경 파일을 만들고 비밀번호와 DB를 화면에 만들지 않는다', () => {
    const result = run('setup-prod.mjs');
    const password = parseEnvFile(readFileSync(file, 'utf8')).WB_ADMIN_PASSWORD;
    expect(password).toHaveLength(20);
    expect(result.stdout + result.stderr).not.toContain(password);
    expect(readdirSync(dir)).toEqual(['rehearsal.env']);
  });

  it('숨김 서버의 첫 실행 실패도 로그에 남기고 DB는 만들지 않는다', () => {
    const logs = join(dir, 'logs');
    const db = join(dir, 'prod.sqlite');
    writeFileSync(file, `WB_DB_PATH=${db}\nWB_LOG_DIR=${logs}`);
    const result = run('start-prod.mjs', ['--log-file']);
    expect(result.status).toBe(1);
    const files = readdirSync(logs);
    expect(files).toHaveLength(1);
    expect(readFileSync(join(logs, files[0]), 'utf8')).toContain('초기 관리자 비밀번호');
    expect(existsSync(db)).toBe(false);
  });

  it('운영 백업은 지정 DB의 내용을 복사하고 잘못된 보관 개수로 기존 백업을 지우지 않는다', () => {
    const dbPath = join(dir, 'prod.sqlite');
    const backups = join(dir, 'backups');
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE rehearsal(value TEXT); INSERT INTO rehearsal VALUES ('가상 자료')");
    db.close();
    writeFileSync(file, `WB_DB_PATH=${dbPath}\nWB_BACKUP_DIR=${backups}`);
    expect(run('backup-prod.mjs').status).toBe(0);
    const files = readdirSync(backups);
    expect(files).toHaveLength(1);
    const backup = new DatabaseSync(join(backups, files[0]), { readOnly: true });
    try { expect(backup.prepare('SELECT value FROM rehearsal').get().value).toBe('가상 자료'); }
    finally { backup.close(); }
    for (const keep of ['-1', '0', '1.5', 'bad', undefined]) {
      const result = run('backup-prod.mjs', ['--keep', ...(keep === undefined ? [] : [keep])]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('--keep은 1 이상의 정수');
      expect(readdirSync(backups)).toEqual(files);
    }
  });
});
