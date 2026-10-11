import type { FastifyInstance } from 'fastify';
import type { SessionUser, UserRole } from '@wb/shared';
import type { AppContext } from '../context.ts';
import { HttpError, bool, genId, requireAdmin, requireUser, str } from '../context.ts';
import { SESSION_COOKIE, SESSION_TTL_MS, hashPassword, newToken, verifyPassword } from '../auth.ts';

export function toSessionUser(u: { id: string; username: string; displayName: string; role: UserRole }): SessionUser {
  return { id: u.id, username: u.username, displayName: u.displayName, role: u.role };
}

/** 로그인 실패 제한: 같은 IP·아이디 조합으로 15분 안에 10회 실패하면 15분 동안 거부 */
const LOGIN_MAX_FAILS = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const loginFails = new Map<string, { count: number; first: number; blockedUntil: number }>();

export function resetLoginLimiter() {
  loginFails.clear();
}

export function registerUserRoutes(app: FastifyInstance, ctx: AppContext) {
  const { store } = ctx;

  app.post('/api/auth/login', async (req, reply) => {
    const r = (req.body ?? {}) as Record<string, unknown>;
    const username = str(r.username).trim();
    const password = str(r.password);
    const key = `${req.ip}|${username.toLowerCase()}`;
    const now = Date.now();
    const rec = loginFails.get(key);
    if (rec && rec.blockedUntil > now) {
      const min = Math.ceil((rec.blockedUntil - now) / 60000);
      throw new HttpError(429, `로그인 실패가 많아 ${min}분 동안 잠겼습니다. 잠시 후 다시 시도하세요.`);
    }
    const u = store.getUserByUsername(username);
    if (!u || !u.active || !verifyPassword(password, u.passwordHash)) {
      const cur = rec && now - rec.first < LOGIN_WINDOW_MS ? rec : { count: 0, first: now, blockedUntil: 0 };
      cur.count += 1;
      if (cur.count >= LOGIN_MAX_FAILS) cur.blockedUntil = now + LOGIN_WINDOW_MS;
      loginFails.set(key, cur);
      store.audit({ at: ctx.now(), userId: '-', kind: 'auth', docId: username || '-', action: 'login_failed', detail: `${req.ip} (${cur.count}회)` });
      throw new HttpError(401, '아이디 또는 비밀번호가 올바르지 않습니다.');
    }
    loginFails.delete(key);
    const token = newToken();
    store.createSession(token, u.id, SESSION_TTL_MS);
    reply.setCookie(SESSION_COOKIE, token, { path: '/', httpOnly: true, sameSite: 'lax', maxAge: SESSION_TTL_MS / 1000 });
    return toSessionUser(u);
  });

  app.post('/api/auth/logout', async (req, reply) => {
    if (req.sessionToken) store.deleteSession(req.sessionToken);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => {
    return req.user;
  });

  app.post('/api/auth/password', async (req) => {
    const me = requireUser(req);
    const r = (req.body ?? {}) as Record<string, unknown>;
    const cur = store.getUser(me.id)!;
    if (!verifyPassword(str(r.currentPassword), cur.passwordHash)) throw new HttpError(400, '현재 비밀번호가 올바르지 않습니다.');
    const next = str(r.newPassword);
    if (next.length < 8) throw new HttpError(400, '새 비밀번호는 8자 이상이어야 합니다.');
    store.updateUser(me.id, { passwordHash: hashPassword(next) });
    return { ok: true };
  });

  app.get('/api/users', async (req) => {
    requireAdmin(req);
    return store.listUsers();
  });

  app.post('/api/users', async (req, reply) => {
    requireAdmin(req);
    const r = (req.body ?? {}) as Record<string, unknown>;
    const username = str(r.username).trim();
    const password = str(r.password);
    if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) throw new HttpError(400, '아이디는 영문·숫자 3~32자여야 합니다.');
    if (password.length < 8) throw new HttpError(400, '비밀번호는 8자 이상이어야 합니다.');
    if (store.getUserByUsername(username)) throw new HttpError(400, '이미 사용 중인 아이디입니다.');
    const role: UserRole = str(r.role) === 'admin' ? 'admin' : 'teacher';
    const id = genId();
    store.insertUser({ id, username, displayName: str(r.displayName) || username, role, passwordHash: hashPassword(password), createdAt: ctx.now() });
    reply.code(201);
    return store.listUsers().find((u) => u.id === id);
  });

  app.put('/api/users/:id', async (req) => {
    const me = requireAdmin(req);
    const id = (req.params as { id: string }).id;
    const r = (req.body ?? {}) as Record<string, unknown>;
    const patch: { displayName?: string; role?: UserRole; active?: boolean; passwordHash?: string } = {};
    if (typeof r.displayName === 'string') patch.displayName = r.displayName;
    if (typeof r.role === 'string') patch.role = r.role === 'admin' ? 'admin' : 'teacher';
    if (typeof r.active === 'boolean') patch.active = bool(r.active);
    if (typeof r.password === 'string' && r.password) {
      if (r.password.length < 8) throw new HttpError(400, '비밀번호는 8자 이상이어야 합니다.');
      patch.passwordHash = hashPassword(r.password);
    }
    if (id === me.id && (patch.active === false || (patch.role && patch.role !== 'admin'))) throw new HttpError(400, '자기 자신의 관리자 권한은 해제할 수 없습니다.');
    store.updateUser(id, patch);
    return store.listUsers().find((u) => u.id === id);
  });
}
