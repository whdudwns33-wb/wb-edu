/**
 * SQLite 백업. WAL 모드에서도 안전한 `VACUUM INTO` 로 일관된 사본을 만든다.
 *
 *   npm run backup                 # 현재 모드(WB_MODE)의 DB → server/data/backups/wb-edu[.demo]-YYYYMMDD-HHMMSS.sqlite
 *   WB_MODE=prod npm run backup    # 운영 DB 백업
 *   npm run backup -- --keep 30    # 최근 30개만 남기고 오래된 백업 삭제 (기본 60)
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import { resolveDbPath, SERVER_ROOT } from './paths.ts';

const dbPath = resolveDbPath();
if (!existsSync(dbPath)) {
  console.error(`DB 파일이 없습니다: ${dbPath}`);
  process.exit(1);
}
const keepIdx = process.argv.indexOf('--keep');
const keep = keepIdx >= 0 ? Number(process.argv[keepIdx + 1]) : 60;
if (!Number.isSafeInteger(keep) || keep < 1) {
  console.error('--keep은 1 이상의 정수여야 합니다. 기존 백업은 변경하지 않았습니다.');
  process.exit(1);
}

const dir = process.env.WB_BACKUP_DIR ?? join(SERVER_ROOT, 'data', 'backups');
mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const base = basename(dbPath, '.sqlite');
const out = join(dir, `${base}-${stamp}.sqlite`);

const db = new DatabaseSync(dbPath, { readOnly: true });
db.exec(`VACUUM INTO '${out.replace(/'/g, "''").replace(/\\/g, '/')}'`);
db.close();
console.log(`백업 완료: ${out} (${(statSync(out).size / 1024).toFixed(0)} KB)`);

// 오래된 백업 정리
const files = readdirSync(dir)
  .filter((f) => f.startsWith(`${base}-`) && f.endsWith('.sqlite'))
  .sort();
for (const f of files.slice(0, Math.max(0, files.length - keep))) {
  unlinkSync(join(dir, f));
  console.log(`오래된 백업 삭제: ${f}`);
}
