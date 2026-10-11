/**
 * 저장소: Node 내장 node:sqlite 사용 (외부 네이티브 모듈 없음).
 *
 * 설계
 *  - 집합(aggregate) 단위 문서 저장: docs(kind, id, data JSON, version, ...)
 *    교재·과정·계획처럼 하위 구조가 깊은 데이터를 한 번에 읽고 쓰며,
 *    version 컬럼으로 낙관적 동시성 제어(409)를 한다.
 *  - users / sessions / audit 는 관계형 테이블.
 *  - 삭제 대신 archived 플래그로 보관 처리.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AuditMeta, User, UserRole } from '@wb/shared';

export type DocKind = 'textbook' | 'curriculum' | 'plan' | 'objective' | 'holidaySet' | 'template' | 'settings';

export class ConflictError extends Error {
  status = 409;
  constructor(msg = '다른 사용자가 먼저 수정했습니다. 새로 고친 뒤 다시 시도하세요.') {
    super(msg);
  }
}

export class NotFoundError extends Error {
  status = 404;
  constructor(msg = '찾을 수 없습니다.') {
    super(msg);
  }
}

export interface UserRow extends User {
  passwordHash: string;
}

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS docs (
        kind TEXT NOT NULL,
        id TEXT NOT NULL,
        data TEXT NOT NULL,
        version INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0,
        is_sample INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (kind, id)
      );
      CREATE INDEX IF NOT EXISTS docs_kind ON docs(kind, archived);
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        user_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        doc_id TEXT NOT NULL,
        action TEXT NOT NULL,
        detail TEXT NOT NULL
      );
    `);
  }

  close() {
    this.db.close();
  }

  // ── 문서 ──

  list<T extends AuditMeta>(kind: DocKind, opts: { includeArchived?: boolean } = {}): T[] {
    const rows = opts.includeArchived
      ? this.db.prepare('SELECT data FROM docs WHERE kind = ? ORDER BY updated_at DESC').all(kind)
      : this.db.prepare('SELECT data FROM docs WHERE kind = ? AND archived = 0 ORDER BY updated_at DESC').all(kind);
    return rows.map((r) => JSON.parse(String((r as { data: string }).data)) as T);
  }

  /**
   * 본문(JSON)에 needle 문자열이 들어 있는 보관되지 않은 문서만 읽는다.
   * 캘린더 구독처럼 로그인 없이 오는 요청이 계획 전체를 해석하지 않도록, SQLite 안에서 먼저 거른다.
   * 결과는 후보일 뿐이므로 호출하는 쪽에서 정확히 다시 확인한다.
   */
  listContaining<T extends AuditMeta>(kind: DocKind, needle: string): T[] {
    const rows = this.db.prepare('SELECT data FROM docs WHERE kind = ? AND archived = 0 AND instr(data, ?) > 0').all(kind, needle);
    return rows.map((r) => JSON.parse(String((r as { data: string }).data)) as T);
  }

  get<T extends AuditMeta>(kind: DocKind, id: string): T | null {
    const row = this.db.prepare('SELECT data FROM docs WHERE kind = ? AND id = ?').get(kind, id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as T) : null;
  }

  mustGet<T extends AuditMeta>(kind: DocKind, id: string): T {
    const d = this.get<T>(kind, id);
    if (!d) throw new NotFoundError();
    return d;
  }

  /** 새 문서 삽입 (version 1) */
  insert<T extends AuditMeta & { id: string }>(kind: DocKind, doc: T): T {
    const d = { ...doc, version: 1 };
    this.db
      .prepare('INSERT INTO docs (kind, id, data, version, updated_at, archived, is_sample) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(kind, d.id, JSON.stringify(d), 1, d.updatedAt, d.archived ? 1 : 0, d.isSample ? 1 : 0);
    return d;
  }

  /**
   * 갱신. expectedVersion 이 현재 저장된 version 과 다르면 ConflictError.
   * 저장 시 version 을 +1 한다.
   */
  update<T extends AuditMeta & { id: string }>(kind: DocKind, doc: T, expectedVersion: number): T {
    const row = this.db.prepare('SELECT version FROM docs WHERE kind = ? AND id = ?').get(kind, doc.id) as { version: number } | undefined;
    if (!row) throw new NotFoundError();
    if (row.version !== expectedVersion) throw new ConflictError();
    const d = { ...doc, version: expectedVersion + 1 };
    const res = this.db
      .prepare('UPDATE docs SET data = ?, version = ?, updated_at = ?, archived = ?, is_sample = ? WHERE kind = ? AND id = ? AND version = ?')
      .run(JSON.stringify(d), d.version, d.updatedAt, d.archived ? 1 : 0, d.isSample ? 1 : 0, kind, doc.id, expectedVersion);
    if (Number(res.changes) !== 1) throw new ConflictError();
    return d;
  }

  deleteDoc(kind: DocKind, id: string) {
    this.db.prepare('DELETE FROM docs WHERE kind = ? AND id = ?').run(kind, id);
  }

  deleteSamples(): number {
    const res = this.db.prepare('DELETE FROM docs WHERE is_sample = 1').run();
    return Number(res.changes);
  }

  countSamples(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM docs WHERE is_sample = 1').get() as { n: number };
    return Number(row.n);
  }

  // ── 사용자 ──

  listUsers(): User[] {
    return (this.db.prepare('SELECT id, username, display_name, role, active, created_at FROM users ORDER BY created_at').all() as Array<Record<string, unknown>>).map(rowToUser);
  }

  getUserByUsername(username: string): UserRow | null {
    const r = this.db.prepare('SELECT * FROM users WHERE username = ?').get(username) as Record<string, unknown> | undefined;
    return r ? { ...rowToUser(r), passwordHash: String(r.password_hash) } : null;
  }

  getUser(id: string): UserRow | null {
    const r = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? { ...rowToUser(r), passwordHash: String(r.password_hash) } : null;
  }

  insertUser(u: { id: string; username: string; displayName: string; role: UserRole; passwordHash: string; createdAt: string }) {
    this.db
      .prepare('INSERT INTO users (id, username, display_name, role, password_hash, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)')
      .run(u.id, u.username, u.displayName, u.role, u.passwordHash, u.createdAt);
  }

  updateUser(id: string, patch: { displayName?: string; role?: UserRole; active?: boolean; passwordHash?: string }) {
    const cur = this.getUser(id);
    if (!cur) throw new NotFoundError();
    this.db
      .prepare('UPDATE users SET display_name = ?, role = ?, active = ?, password_hash = ? WHERE id = ?')
      .run(patch.displayName ?? cur.displayName, patch.role ?? cur.role, (patch.active ?? cur.active) ? 1 : 0, patch.passwordHash ?? cur.passwordHash, id);
  }

  // ── 세션 ──

  createSession(token: string, userId: string, ttlMs: number) {
    const now = new Date();
    this.db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(token, userId, now.toISOString(), new Date(now.getTime() + ttlMs).toISOString());
  }

  getSessionUser(token: string): UserRow | null {
    const r = this.db.prepare('SELECT user_id, expires_at FROM sessions WHERE token = ?').get(token) as { user_id: string; expires_at: string } | undefined;
    if (!r) return null;
    if (r.expires_at < new Date().toISOString()) {
      this.db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
      return null;
    }
    const u = this.getUser(r.user_id);
    return u && u.active ? u : null;
  }

  deleteSession(token: string) {
    this.db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  }

  // ── 감사 로그 ──

  audit(entry: { at: string; userId: string; kind: string; docId: string; action: string; detail: string }) {
    this.db.prepare('INSERT INTO audit (at, user_id, kind, doc_id, action, detail) VALUES (?, ?, ?, ?, ?, ?)').run(entry.at, entry.userId, entry.kind, entry.docId, entry.action, entry.detail);
  }

  auditFor(kind: string, docId: string, limit = 100) {
    return this.db.prepare('SELECT at, user_id AS userId, action, detail FROM audit WHERE kind = ? AND doc_id = ? ORDER BY id DESC LIMIT ?').all(kind, docId, limit);
  }
}

function rowToUser(r: Record<string, unknown>): User {
  return {
    id: String(r.id),
    username: String(r.username),
    displayName: String(r.display_name),
    role: String(r.role) as UserRole,
    active: Number(r.active) === 1,
    createdAt: String(r.created_at),
  };
}
