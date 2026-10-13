#!/usr/bin/env node
/**
 * 운영 DB 백업 (npm run backup:prod).
 * .env.prod 의 WB_BACKUP_DIR·WB_DB_PATH 를 그대로 따르므로, 작업 스케줄러와 사람이 실행할 때 같은 곳에 백업된다.
 *   npm run backup:prod
 *   npm run backup:prod -- --keep 30
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { ROOT, TSX_CLI, loadProdEnv } from './prod-env.mjs';

const { env } = loadProdEnv();
const r = spawnSync(process.execPath, [TSX_CLI, join(ROOT, 'server', 'src', 'backup.ts'), ...process.argv.slice(2)], { cwd: ROOT, env, stdio: 'inherit' });
process.exit(r.status ?? 1);
