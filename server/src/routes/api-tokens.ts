import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { HttpError, requireUser, text, genId, type AppContext } from '../context.ts';
import { newToken } from '../auth.ts';
import { toSessionUser } from './users.ts';

const digest = (token: string) => createHash('sha256').update(token).digest('hex');
export function authenticateApi(req: FastifyRequest, ctx: AppContext): boolean {
  if (!req.headers.authorization) return false;
  const match = /^Bearer (wbp_[A-Za-z0-9_-]{43})$/.exec(req.headers.authorization);
  if (!match) throw new HttpError(401, '유효한 API 키가 필요합니다.');
  const row = ctx.store.db.prepare('SELECT id, user_id, scope, expires_at FROM api_tokens WHERE token_hash = ?').get(digest(match[1])) as { id: string; user_id: string; scope: string; expires_at: string } | undefined;
  const user = row ? ctx.store.getUser(row.user_id) : null;
  if (!row || !user?.active || row.expires_at <= ctx.now()) throw new HttpError(401, 'API 키가 만료되었거나 폐기되었습니다.');
  req.user = toSessionUser(user);
  req.sessionToken = null;
  req.apiScope = row.scope;
  req.apiTokenId = row.id;
  return true;
}

export function authorizeApi(req: FastifyRequest) {
  if (!req.apiScope) return;
  const path = req.url.split('?')[0];
  if (req.method === 'GET' && ['/api/health', '/api/openapi.json'].includes(path)) return;
  const readable = /^\/api\/(textbooks|curricula|plans)(\/[A-Za-z0-9_-]+)?(\/views)?$/.test(path);
  const writable = readable || /^\/api\/plans\/[A-Za-z0-9_-]+\/(records|ops)$/.test(path);
  const preview = path === '/api/plans/preview' || (path.endsWith('/ops') && (req.body as { dryRun?: unknown })?.dryRun === true);
  if (path !== '/mcp' && (!(req.method === 'GET' ? readable : writable) || !['GET', 'POST', 'PUT'].includes(req.method))) throw new HttpError(403, 'API 키로 접근할 수 없는 경로입니다.');
  if (path !== '/mcp' && req.method !== 'GET' && req.apiScope !== 'write' && !preview && !path.endsWith('/preview')) throw new HttpError(403, '조회 전용 API 키입니다.');
}

export function registerApiTokenRoutes(app: FastifyInstance, ctx: AppContext) {
  const { store } = ctx;
  app.get('/api/api-tokens', async req => {
    const user = requireUser(req);
    return store.db.prepare('SELECT id, name, scope, created_at AS createdAt, expires_at AS expiresAt FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC').all(user.id);
  });
  app.post('/api/api-tokens', async (req, reply) => {
    const user = requireUser(req);
    const r = (req.body ?? {}) as Record<string, unknown>;
    const name = text(r.name, 80, '연결 이름').trim();
    if (!name) throw new HttpError(400, '연결 이름이 필요합니다.');
    if (r.scope !== 'read' && r.scope !== 'write') throw new HttpError(400, '조회 또는 등록·수정 권한을 선택하세요.');
    const days = r.days === undefined ? 90 : r.days;
    if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > 365) throw new HttpError(400, '유효기간은 1~365일입니다.');
    const count = store.db.prepare('SELECT COUNT(*) AS n FROM api_tokens WHERE user_id = ?').get(user.id) as { n: number };
    if (count.n >= 20) throw new HttpError(400, '기존 API 키를 폐기한 뒤 추가하세요. (최대 20개)');
    const id = genId(), token = 'wbp_' + newToken(), at = ctx.now();
    const expiresAt = new Date(Date.parse(at) + days * 86400000).toISOString();
    store.db.prepare('INSERT INTO api_tokens (id,user_id,name,scope,token_hash,created_at,expires_at) VALUES (?,?,?,?,?,?,?)').run(id, user.id, name, r.scope, digest(token), at, expiresAt);
    store.audit({ at, userId: user.id, kind: 'apiToken', docId: id, action: 'create', detail: name + ' (' + r.scope + ')' });
    reply.header('Cache-Control', 'no-store').code(201);
    return { id, name, scope: r.scope, expiresAt, token };
  });
  app.delete('/api/api-tokens/:id', async req => {
    const user = requireUser(req), id = (req.params as { id: string }).id;
    store.db.prepare('DELETE FROM api_tokens WHERE id = ? AND user_id = ?').run(id, user.id);
    store.audit({ at: ctx.now(), userId: user.id, kind: 'apiToken', docId: id, action: 'revoke', detail: '' });
    return { ok: true };
  });
}
