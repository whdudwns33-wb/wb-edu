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
  if (u.role !== 'admin') throw new HttpError(403, '관리자만 할 수 있는 작업입니다.');
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

export function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

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
