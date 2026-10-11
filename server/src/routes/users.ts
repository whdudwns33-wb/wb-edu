import type { FastifyInstance } from 'fastify';
import type { SessionUser, UserRole } from '@wb/shared';
import type { AppContext } from '../context.ts';
import { HttpError, bool, genId, requireAdmin, requireUser, str, text } from '../context.ts';
import { DUMMY_PASSWORD_HASH, SESSION_COOKIE, SESSION_TTL_MS, hashPassword, newToken, verifyPassword } from '../auth.ts';

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

/** 기간이 지난 실패 기록을 지운다 (여러 아이디로 계속 시도해도 메모리가 쌓이지 않게) */
function sweepLoginFails(now: number) {
  if (loginFails.size < 1000) return;
  for (const [k, v] of loginFails) if (now - v.first >= LOGIN_WINDOW_MS && v.blockedUntil <= now) loginFails.delete(k);
}

const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;
const PASSWORD_MAX = 1024;

export function registerUserRoutes(app: FastifyInstance, ctx: AppContext) {
  const { store } = ctx;

  app.post('/api/auth/login', async (req, reply) => {
    const r = (req.body ?? {}) as Record<string, unknown>;
    const rawName = str(r.username).trim();
    // 아이디 규칙에 맞지 않는 값은 그대로 기록하지 않는다 (아주 긴 값으로 감사 로그·메모리를 채우는 것 방지)
    const username = USERNAME_RE.test(rawName) ? rawName : '';
    const password = str(r.password).slice(0, PASSWORD_MAX);
    const key = `${req.ip}|${username.toLowerCase() || '(invalid)'}`;
    const now = Date.now();
    sweepLoginFails(now);
    const rec = loginFails.get(key);
    if (rec && rec.blockedUntil > now) {
      const min = Math.ceil((rec.blockedUntil - now) / 60000);
      throw new HttpError(429, `로그인 실패가 많아 ${min}분 동안 잠겼습니다. 잠시 후 다시 시도하세요.`);
    }
    const u = username ? store.getUserByUsername(username) : null;
    // 없는 아이디도 같은 비밀번호 계산을 거쳐, 응답 시간으로 아이디 존재 여부가 드러나지 않게 한다
    const passwordOk = verifyPassword(password, u?.passwordHash ?? DUMMY_PASSWORD_HASH);
    if (!u || !u.active || !passwordOk) {
      const cur = rec && now - rec.first < LOGIN_WINDOW_MS ? rec : { count: 0, first: now, blockedUntil: 0 };
      cur.count += 1;
      if (cur.count >= LOGIN_MAX_FAILS) cur.blockedUntil = now + LOGIN_WINDOW_MS;
      loginFails.set(key, cur);
      store.audit({ at: ctx.now(), userId: '-', kind: 'auth', docId: username || '(형식 오류)', action: 'login_failed', detail: `${req.ip} (${cur.count}회)` });
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
    if (!verifyPassword(str(r.currentPassword).slice(0, PASSWORD_MAX), cur.passwordHash)) throw new HttpError(400, '현재 비밀번호가 올바르지 않습니다.');
    const next = str(r.newPassword);
    if (next.length < 8) throw new HttpError(400, '새 비밀번호는 8자 이상이어야 합니다.');
    if (next.length > PASSWORD_MAX) throw new HttpError(400, '새 비밀번호가 너무 깁니다.');
    store.updateUser(me.id, { passwordHash: hashPassword(next) });
    // 다른 기기의 로그인은 끊는다 (지금 쓰는 세션은 유지)
    store.deleteUserSessions(me.id, req.sessionToken ?? undefined);
    store.audit({ at: ctx.now(), userId: me.id, kind: 'user', docId: me.id, action: 'password_change', detail: '' });
    return { ok: true };
  });

  app.get('/api/users', async (req) => {
    requireAdmin(req);
    return store.listUsers();
  });

  app.post('/api/users', async (req, reply) => {
    const me = requireAdmin(req);
    const r = (req.body ?? {}) as Record<string, unknown>;
    const username = str(r.username).trim();
    const password = str(r.password);
    if (!USERNAME_RE.test(username)) throw new HttpError(400, '아이디는 영문·숫자 3~32자여야 합니다.');
    if (password.length < 8 || password.length > PASSWORD_MAX) throw new HttpError(400, '비밀번호는 8자 이상이어야 합니다.');
    if (store.getUserByUsername(username)) throw new HttpError(400, '이미 사용 중인 아이디입니다.');
    const role: UserRole = str(r.role) === 'admin' ? 'admin' : 'teacher';
    const id = genId();
    store.insertUser({ id, username, displayName: text(r.displayName, 40, '이름') || username, role, passwordHash: hashPassword(password), createdAt: ctx.now() });
    store.audit({ at: ctx.now(), userId: me.id, kind: 'user', docId: id, action: 'user_create', detail: `${username} (${role})` });
    reply.code(201);
    return store.listUsers().find((u) => u.id === id);
  });

  app.put('/api/users/:id', async (req) => {
    const me = requireAdmin(req);
    const id = (req.params as { id: string }).id;
    const r = (req.body ?? {}) as Record<string, unknown>;
    const patch: { displayName?: string; role?: UserRole; active?: boolean; passwordHash?: string } = {};
    if (typeof r.displayName === 'string') patch.displayName = text(r.displayName, 40, '이름');
    if (typeof r.role === 'string') patch.role = r.role === 'admin' ? 'admin' : 'teacher';
    if (typeof r.active === 'boolean') patch.active = bool(r.active);
    if (typeof r.password === 'string' && r.password) {
      if (r.password.length < 8 || r.password.length > PASSWORD_MAX) throw new HttpError(400, '비밀번호는 8자 이상이어야 합니다.');
      patch.passwordHash = hashPassword(r.password);
    }
    if (id === me.id && (patch.active === false || (patch.role && patch.role !== 'admin'))) throw new HttpError(400, '자기 자신의 관리자 권한은 해제할 수 없습니다.');
    const before = store.getUser(id);
    if (!before) throw new HttpError(404, '사용자를 찾을 수 없습니다.');
    store.updateUser(id, patch);
    // 비밀번호 초기화·비활성화는 그 사람의 기존 로그인을 모두 끊는다 (다시 활성화해도 옛 세션이 살아나지 않게)
    if (patch.passwordHash || patch.active === false) store.deleteUserSessions(id);
    const changes = [
      patch.role && patch.role !== before.role ? `권한 ${before.role} → ${patch.role}` : '',
      patch.active !== undefined && patch.active !== before.active ? (patch.active ? '활성화' : '비활성화') : '',
      patch.passwordHash ? '비밀번호 초기화' : '',
      patch.displayName !== undefined && patch.displayName !== before.displayName ? '이름 변경' : '',
    ].filter(Boolean);
    if (changes.length) store.audit({ at: ctx.now(), userId: me.id, kind: 'user', docId: id, action: 'user_update', detail: `${before.username}: ${changes.join(', ')}` });
    return store.listUsers().find((u) => u.id === id);
  });
}
