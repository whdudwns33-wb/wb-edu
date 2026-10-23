import { openapi } from './openapi.ts';
import { registerExternalSafety } from './routes/external-safety.ts';
import { authenticateApi, authorizeApi, registerApiTokenRoutes } from './routes/api-tokens.ts';
import { registerMcpRoute } from './routes/mcp.ts';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Store, ConflictError, NotFoundError } from './db.ts';
import { HttpError, type AppContext } from './context.ts';
import { SESSION_COOKIE } from './auth.ts';
import { registerUserRoutes, toSessionUser } from './routes/users.ts';
import { registerTextbookRoutes } from './routes/textbooks.ts';
import { registerCurriculumRoutes } from './routes/curricula.ts';
import { registerPlanRoutes } from './routes/plans.ts';
import { ensureDefaults, registerSettingsRoutes } from './routes/settings.ts';

export interface BuildOptions {
  dbPath: string;
  staticDir?: string;
  logger?: boolean;
  now?: () => string;
}

export async function buildApp(opts: BuildOptions): Promise<{ app: FastifyInstance; ctx: AppContext }> {
  const store = new Store(opts.dbPath);
  const ctx: AppContext = { store, now: opts.now ?? (() => new Date().toISOString()) };
  ensureDefaults(ctx);

  const app = Fastify({ logger: opts.logger ? { redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'] } : false, bodyLimit: 10 * 1024 * 1024 });
  await app.register(fastifyCookie);

  app.decorateRequest('user', null);
  app.decorateRequest('sessionToken', null);
  app.decorateRequest('apiScope', null);
  app.decorateRequest('apiTokenId', null);

  app.addHook('onRequest', async (req) => {
    if (authenticateApi(req, ctx)) return;
    const token = req.cookies[SESSION_COOKIE];
    req.sessionToken = token ?? null;
    req.user = null;
    if (token) {
      const u = store.getSessionUser(token);
      if (u) req.user = toSessionUser(u);
    }
  });

  app.addHook('preHandler', async req => {
    authorizeApi(req);
    const path = req.url.split('?')[0];
    if (req.user?.mustChangePassword && (path.startsWith('/api/') || path === '/mcp') && !['/api/auth/me', '/api/auth/password', '/api/auth/logout'].includes(path)) throw new HttpError(403, '첫 로그인 비밀번호 변경이 필요합니다.');
  });

  app.setErrorHandler((err, req, reply) => {
    const e = err as Error & { status?: number; statusCode?: number; details?: unknown; validation?: unknown };
    if (e instanceof HttpError && e.status === 401 && (req.headers.authorization || req.url.split('?')[0] === '/mcp')) reply.header('WWW-Authenticate', 'Bearer realm="WB Planner"');
    if (e instanceof HttpError) return reply.code(e.status).send({ error: e.message, details: e.details });
    if (e instanceof ConflictError) return reply.code(409).send({ error: e.message });
    if (e instanceof NotFoundError) return reply.code(404).send({ error: e.message });
    const status = e.statusCode ?? e.status ?? 500;
    if (status >= 500) app.log.error(e);
    return reply.code(status).send({ error: status >= 500 ? '서버 오류가 발생했습니다.' : e.message });
  });

  // mode: 화면이 데모 안내(기본 계정 등)를 운영에서 보이지 않게 하는 데 쓴다
  app.get('/api/health', async () => ({ ok: true, time: ctx.now(), mode: process.env.WB_MODE === 'prod' ? 'prod' : 'demo' }));

  app.get('/api/openapi.json', async () => openapi);
  registerExternalSafety(app, ctx);
  registerUserRoutes(app, ctx);
  registerApiTokenRoutes(app, ctx);
  registerMcpRoute(app);
  registerTextbookRoutes(app, ctx);
  registerCurriculumRoutes(app, ctx);
  registerPlanRoutes(app, ctx);
  registerSettingsRoutes(app, ctx);

  // 빌드된 웹앱 정적 서빙 (SPA fallback)
  if (opts.staticDir && existsSync(join(opts.staticDir, 'index.html'))) {
    await app.register(fastifyStatic, { root: opts.staticDir, prefix: '/' });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'Not found' });
      return reply.sendFile('index.html');
    });
  } else {
    app.setNotFoundHandler((req, reply) => reply.code(404).send({ error: req.url.startsWith('/api/') ? 'Not found' : '웹앱이 빌드되지 않았습니다. npm run build 후 실행하거나 개발 모드(npm run dev)로 접속하세요.' }));
  }

  app.addHook('onClose', async () => store.close());
  return { app, ctx };
}
