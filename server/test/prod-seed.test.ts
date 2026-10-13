import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.ts';
import { seedAdmin } from '../src/seed.ts';

afterEach(() => vi.unstubAllEnvs());

describe('운영 관리자 첫 생성', () => {
  it('DB가 이미 있어도 비밀번호 없이 기본 계정을 만들지 않는다', async () => {
    vi.stubEnv('WB_MODE', 'prod');
    vi.stubEnv('WB_ADMIN_PASSWORD', undefined);
    const { app, ctx } = await buildApp({ dbPath: ':memory:' });
    try {
      expect(() => seedAdmin(ctx)).toThrow('운영 관리자 비밀번호');
      expect(ctx.store.listUsers()).toHaveLength(0);
    } finally { await app.close(); }
  });

  it('잘못된 초기 계정은 거절하고 기존 관리자의 비밀번호는 유지한다', async () => {
    vi.stubEnv('WB_MODE', 'prod');
    const { app, ctx } = await buildApp({ dbPath: ':memory:' });
    try {
      expect(() => seedAdmin(ctx, '한글', 'A'.repeat(20))).toThrow('WB_ADMIN_USER');
      expect(() => seedAdmin(ctx, 'admin', 'admin1234')).toThrow('운영 관리자 비밀번호');
      seedAdmin(ctx, 'admin', 'A'.repeat(20));
      const passwordHash = ctx.store.getUserByUsername('admin')!.passwordHash;
      expect(seedAdmin(ctx, 'admin', '')).toEqual({ created: false, username: 'admin' });
      expect(ctx.store.getUserByUsername('admin')!.passwordHash).toBe(passwordHash);
    } finally { await app.close(); }
  });
});
