import { afterAll, beforeAll, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { hashPassword } from '../src/auth.ts';
import { seedAdmin } from '../src/seed.ts';

const built = await buildApp({ dbPath: ':memory:' });
const { app, ctx } = built;
const cookies: Record<string, string> = {};
beforeAll(async () => {
  for (const role of ['owner', 'admin', 'teacher'] as const) {
    ctx.store.insertUser({ id: role, username: role, displayName: '[가상] ' + role, role, passwordHash: hashPassword('test-password'), createdAt: ctx.now() });
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: role, password: 'test-password' } });
    cookies[role] = 'wb_session=' + res.cookies[0].value;
  }
});
afterAll(() => app.close());
const request = (role: string, method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) => app.inject({ method, url, payload, headers: { cookie: cookies[role] } });
it('원장과 관리자는 사용자·공통 교재를 관리하고 강사는 계정을 등록할 수 없다', async () => {
  for (const role of ['owner', 'admin']) {
    expect((await request(role, 'GET', '/api/users')).statusCode).toBe(200);
    const created = await request(role, 'POST', '/api/users', { username: role === 'owner' ? 'wb가상원장강사' : 'wb가상관리자강사', displayName: '[가상] 강사', role: 'teacher', password: 'teacher-password' });
    expect(created.statusCode).toBe(201);
    expect(created.json().role).toBe('teacher');
  }
  expect((await request('teacher', 'GET', '/api/users')).statusCode).toBe(403);
});
it('관리자는 원장 계정의 이름·비밀번호·활성 상태·권한을 바꾸거나 원장으로 승격할 수 없다', async () => {
  for (const payload of [{ displayName: '변경' }, { password: 'other-password' }, { active: false }, { role: 'teacher' }]) {
    expect((await request('admin', 'PUT', '/api/users/owner', payload)).statusCode).toBe(403);
  }
  expect((await request('admin', 'PUT', '/api/users/admin', { role: 'owner' })).statusCode).toBe(403);
  expect((await request('admin', 'POST', '/api/users', { username: 'forbidden-owner', password: 'test-password', role: 'owner' })).statusCode).toBe(403);
  expect(ctx.store.getUser('owner')?.displayName).toBe('[가상] owner');
});
it('원장은 관리자 이름을 변경할 수 있고 자신의 원장 권한은 해제할 수 없다', async () => {
  expect((await request('owner', 'PUT', '/api/users/admin', { displayName: '[가상] 관리자 변경' })).statusCode).toBe(200);
  expect((await request('owner', 'PUT', '/api/users/owner', { role: 'admin' })).statusCode).toBe(400);
  expect((await request('owner', 'PUT', '/api/users/owner', { active: false })).statusCode).toBe(400);
  expect((await request('owner', 'PUT', '/api/users/admin', { role: 'invalid' })).statusCode).toBe(400);
});
it('원장만 남아 있어도 초기 관리자를 다시 만들지 않는다', () => {
  const admin = ctx.store.getUser('admin')!;
  ctx.store.updateUser('admin', { role: 'teacher' });
  expect(seedAdmin(ctx, 'unexpected-admin', 'test-password').created).toBe(false);
  expect(ctx.store.getUserByUsername('unexpected-admin')).toBeNull();
  ctx.store.updateUser('admin', { role: admin.role });
});
