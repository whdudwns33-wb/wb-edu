import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { isManager, type Plan, type Curriculum, type Textbook } from '@wb/shared';
import { HttpError, genId, type AppContext } from '../context.ts';

const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const operation = (req: FastifyRequest) => { const r = req.body as Record<string, unknown>; return hash({ op: r.op, params: r.params ?? {}, version: r.version }); };
export function registerExternalSafety(app: FastifyInstance, ctx: AppContext) {
  const approvals = new Map<string, { token: string; plan: string; hash: string; source?: string; expires: number }>();
  const limits = new Map<string, { until: number; count: number }>();
  const planInput = (body: Record<string, unknown>) => hash({ curriculumId: body.curriculumId, settings: body.settings, fromSessionOrder: body.fromSessionOrder, toSessionOrder: body.toSessionOrder, includeItemIds: body.includeItemIds });
  const sourceOf = (body: Record<string, unknown>) => {
    const c = typeof body.curriculumId === 'string' ? ctx.store.get<Curriculum>('curriculum', body.curriculumId) : null;
    return hash(c ? [c.id, c.version, c.textbooks.map(ref => [ref.textbookId, ctx.store.get<Textbook>('textbook', ref.textbookId)?.version])] : null);
  };
  const active = new Map<string, string>();
  ctx.store.db.exec('CREATE TABLE IF NOT EXISTS api_requests (token_id TEXT NOT NULL, request_key TEXT NOT NULL, fingerprint TEXT NOT NULL, status INTEGER NOT NULL, response TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(token_id,request_key))');
  app.addHook('preHandler', async (req, reply) => {
    if (!req.apiTokenId) return;
    const now = Date.now(), path = req.url.split('?')[0];
    for (const [key, value] of limits) if (value.until <= now) limits.delete(key);
    for (const [key, value] of approvals) if (value.expires <= now) approvals.delete(key);
    const rate = limits.get(req.apiTokenId) ?? { until: now + 60000, count: 0 };
    rate.count++; limits.set(req.apiTokenId, rate);
    if (rate.count > 120) throw new HttpError(429, '연결당 분당 120회까지 요청할 수 있습니다.');
    if (req.method === 'GET' && /^\/api\/(textbooks|curricula|plans)$/.test(path)) {
      const q = req.query as { limit?: string; cursor?: string };
      if (q.limit !== undefined && (!/^\d+$/.test(q.limit) || Number(q.limit) < 1 || Number(q.limit) > 200)) throw new HttpError(400, 'limit는 1~200입니다.');
      if (q.cursor !== undefined && !/^[A-Za-z0-9_-]{1,100}$/.test(q.cursor)) throw new HttpError(400, 'cursor 형식이 올바르지 않습니다.');
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    if ((req.method === 'PUT' || /\/records$/.test(path)) && (!Number.isInteger(body.version) || (body.version as number) < 1)) throw new HttpError(400, '현재 version을 정수로 입력하세요.');
    const op = /^\/api\/plans\/([A-Za-z0-9_-]+)\/ops$/.exec(path);
    const preview = req.method === 'POST' && (path === '/api/plans/preview' || (op && body.dryRun === true));
    if (op && body.dryRun === true) {
      const current = ctx.store.get<Plan>('plan', op[1]);
      if (typeof body.version !== 'number') throw new HttpError(400, '미리보기에도 현재 version이 필요합니다.');
      if (current && current.version !== body.version) throw new HttpError(409, '계획이 변경되었습니다. 재조회하세요.');
    }
    if (req.method === 'GET' || path === '/mcp' || preview) return;
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(key)) throw new HttpError(400, '8~100자 Idempotency-Key가 필요합니다. 같은 요청 재시도에는 같은 키를 사용하세요.');
    const activeKey = req.apiTokenId + ':' + key;
    if (active.has(activeKey)) throw new HttpError(409, '같은 요청을 처리 중입니다. 잠시 후 재시도하세요.');
    const fingerprint = hash({ path, method: req.method, body, role: req.user?.role });
    ctx.store.db.prepare('DELETE FROM api_requests WHERE created_at < ?').run(now - 86400000);
    const old = ctx.store.db.prepare('SELECT fingerprint,status,response FROM api_requests WHERE token_id=? AND request_key=?').get(req.apiTokenId, key) as { fingerprint: string; status: number; response: string } | undefined;
    if (old) {
      if (old.fingerprint !== fingerprint) throw new HttpError(409, '같은 중복 방지 키에 다른 입력을 사용할 수 없습니다.');
      if (old.status === 0) throw new HttpError(409, '이 요청의 처리 결과를 확인해야 합니다. 자료를 조회해 확인한 뒤 담당자에게 요청하세요. 자동으로 다시 저장하지 않습니다.');
      if ((path.startsWith('/api/textbooks') || path.startsWith('/api/curricula')) && !isManager(req.user?.role)) throw new HttpError(403, '관리자 권한이 필요합니다.');
      const id = /^\/api\/plans\/([A-Za-z0-9_-]+)/.exec(path)?.[1] ?? (path === '/api/plans' ? JSON.parse(old.response).id : undefined);
      if (id) {
        const allowed = await app.inject({ url: '/api/plans/' + id, headers: { authorization: req.headers.authorization! } });
        if (allowed.statusCode !== 200) throw new HttpError(allowed.statusCode, '계획 접근 권한을 다시 확인하세요.');
      }
      return reply.code(old.status).header('Idempotency-Replayed', 'true').type('application/json').send(old.response);
    }
    if (path === '/api/plans') {
      if (body.learningApproach !== undefined) throw new HttpError(400, '외부 계획 생성은 단일 설정 미리보기를 사용하세요. 3안 확정은 앱에서 진행하세요.');
      const approval = typeof body.approvalId === 'string' ? approvals.get(body.approvalId) : undefined;
      if (!approval || approval.token !== req.apiTokenId || approval.plan !== 'new' || approval.hash !== planInput(body) || approval.source !== sourceOf(body)) throw new HttpError(409, '같은 입력의 계획 미리보기를 다시 확인하세요. 교재·과정이 바뀌면 재검토해야 합니다.');
      approvals.delete(body.approvalId as string);
    }
    if (op) {
      const approval = typeof body.approvalId === 'string' ? approvals.get(body.approvalId) : undefined;
      if (!approval || approval.token !== req.apiTokenId || approval.plan !== op[1] || approval.hash !== operation(req)) throw new HttpError(409, '같은 입력의 재편성 미리보기를 먼저 확인하세요.');
      approvals.delete(body.approvalId as string);
    }
    ctx.store.db.prepare('INSERT INTO api_requests(token_id,request_key,fingerprint,status,response,created_at) VALUES(?,?,?,?,?,?)').run(req.apiTokenId, key, fingerprint, 0, '', now);
    active.set(activeKey, req.id);
    reply.raw.once('close', () => { if (active.get(activeKey) === req.id) active.delete(activeKey); });
  });
  app.addHook('onSend', async (req, reply, payload) => {
    if (!req.apiTokenId || typeof payload !== 'string') return payload;
    if (reply.statusCode === 200 && req.method === 'GET' && /^\/api\/(textbooks|curricula|plans)$/.test(req.url.split('?')[0])) {
      const q = req.query as { limit?: string; cursor?: string };
      const items = JSON.parse(payload) as { id: string }[];
      const from = q.cursor ? items.findIndex(item => item.id === q.cursor) + 1 : 0;
      if (q.cursor && from === 0) throw new HttpError(400, '목록이 변경되었습니다. 첫 페이지부터 다시 조회하세요.');
      const page = items.slice(from, from + Number(q.limit ?? 100));
      if (from + page.length < items.length && page.length) reply.header('X-Next-Cursor', page[page.length - 1].id);
      return JSON.stringify(page);
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const op = /^\/api\/plans\/([A-Za-z0-9_-]+)\/ops$/.exec(req.url.split('?')[0]);
    if (req.url === '/api/plans/preview' && reply.statusCode < 400) {
      if (approvals.size >= 1000) throw new HttpError(429, '미리보기 요청이 많습니다. 잠시 후 다시 시도하세요.');
      const approvalId = genId(), expires = Date.now() + 600000, sourceVersion = sourceOf(body);
      approvals.set(approvalId, { token: req.apiTokenId, plan: 'new', hash: planInput(body), source: sourceVersion, expires });
      return JSON.stringify({ ...JSON.parse(payload), sourceVersion, approvalId, expiresAt: new Date(expires).toISOString() });
    }
    if (op && body.dryRun === true && reply.statusCode < 400) {
      if (approvals.size >= 1000) throw new HttpError(429, '미리보기 요청이 많습니다. 잠시 후 다시 시도하세요.');
      const approvalId = genId(), expires = Date.now() + 600000;
      approvals.set(approvalId, { token: req.apiTokenId, plan: op[1], hash: operation(req), expires });
      return JSON.stringify({ ...JSON.parse(payload), version: body.version, approvalId, expiresAt: new Date(expires).toISOString() });
    }
    const key = req.headers['idempotency-key'];
    if (typeof key === 'string' && active.get(req.apiTokenId + ':' + key) === req.id) {
      if (reply.statusCode < 500) ctx.store.db.prepare('UPDATE api_requests SET status=?,response=? WHERE token_id=? AND request_key=?').run(reply.statusCode, payload, req.apiTokenId, key);
      active.delete(req.apiTokenId + ':' + key);
    }
    return payload;
  });
}
