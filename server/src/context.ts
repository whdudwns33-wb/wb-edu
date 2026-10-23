import { isManager } from '@wb/shared';
import type { FastifyRequest } from 'fastify';
import type { AuditMeta, SessionUser } from '@wb/shared';
import type { Store } from './db.ts';

export interface AppContext {
  store: Store;
  now: () => string;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null;
    sessionToken: string | null;
    apiScope: string | null;
    apiTokenId: string | null;
  }
}

export class HttpError extends Error {
  constructor(
    public status: number,
    msg: string,
    public details?: unknown,
  ) {
    super(msg);
  }
}

export function requireUser(req: FastifyRequest): SessionUser {
  if (!req.user) throw new HttpError(401, '로그인이 필요합니다.');
  return req.user;
}

export function requireAdmin(req: FastifyRequest): SessionUser {
  const u = requireUser(req);
  if (!isManager(u.role)) throw new HttpError(403, '관리자만 할 수 있는 작업입니다.');
  return u;
}

export function newMeta(user: SessionUser, at: string, isSample = false): AuditMeta {
  return { createdAt: at, createdBy: user.id, updatedAt: at, updatedBy: user.id, version: 1, archived: false, isSample };
}

export function touched<T extends AuditMeta>(doc: T, user: SessionUser, at: string): T {
  return { ...doc, updatedAt: at, updatedBy: user.id };
}

export function expectVersion(body: unknown): number {
  const v = (body as { version?: unknown })?.version;
  if (typeof v !== 'number') throw new HttpError(400, '저장하려면 현재 version 값을 함께 보내야 합니다.');
  return v;
}

/**
 * 요청 본문의 문자열. 짝이 맞지 않는 UTF-16 대리 문자는 바꿔 둔다
 * (그대로 저장하면 파일 이름 인코딩 등에서 예외가 나 엑셀·달력 내보내기가 계속 실패한다).
 */
export function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�') : fallback;
}

/** 길이 제한이 있는 자유 입력 글자 (제목·메모·의견). 넘으면 400 */
export function text(v: unknown, max: number, label: string): string {
  const s = str(v);
  if (s.length > max) throw new HttpError(400, `${label}은(는) ${max}자 이하로 입력하세요.`);
  return s;
}

/** 내려받기 파일 이름: 경로·제어 문자를 빼고 길이를 줄인다 */
export function safeFileName(name: string): string {
  // eslint-disable-next-line no-control-regex
  return str(name).replace(/[\u0000-\u001f\u007f\\/:*?"<>|]/g, '_').slice(0, 150) || 'download';
}

export const TEXT_LIMIT = { title: 200, note: 2000, comment: 2000 } as const;

export function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

export function bool(v: unknown, fallback = false): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

export function arr<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

export function genId(): string {
  return crypto.randomUUID();
}
