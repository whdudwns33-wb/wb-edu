/**
 * 시드.
 *  - 관리자 계정이 없으면 초기 계정을 만든다 (환경변수 WB_ADMIN_USER / WB_ADMIN_PASSWORD, 기본 admin / admin1234).
 *  - --sample 플래그: 가상 샘플 교재·학습목표·표준과정을 넣는다 (isSample=true).
 *    실제 운영 DB 에는 넣지 않는 것을 권장하며, 설정 화면에서 일괄 삭제할 수 있다.
 */
import { sampleCurricula, sampleInhouseTextbook, sampleMarketTextbook, sampleObjectives, type Curriculum, type Textbook } from '@wb/shared';
import type { AppContext } from './context.ts';
import { hashPassword } from './auth.ts';
import { genId } from './context.ts';

export function seedAdmin(ctx: AppContext, username = process.env.WB_ADMIN_USER ?? 'admin', password = process.env.WB_ADMIN_PASSWORD ?? 'admin1234'): { created: boolean; username: string } {
  const { store } = ctx;
  if (store.listUsers().some((u) => u.role === 'admin')) return { created: false, username };
  store.insertUser({ id: genId(), username, displayName: '관리자', role: 'admin', passwordHash: hashPassword(password), createdAt: ctx.now() });
  return { created: true, username };
}

export function seedDemoTeacher(ctx: AppContext): boolean {
  const { store } = ctx;
  if (store.getUserByUsername('teacher')) return false;
  store.insertUser({ id: genId(), username: 'teacher', displayName: '샘플 강사', role: 'teacher', passwordHash: hashPassword('teacher1234'), createdAt: ctx.now() });
  return true;
}

export function seedSamples(ctx: AppContext, by = 'system'): { inserted: number } {
  const { store } = ctx;
  const at = ctx.now();
  let inserted = 0;
  const market = sampleMarketTextbook(by, at);
  const inhouse = sampleInhouseTextbook(by, at);
  for (const tb of [market, inhouse]) {
    if (!store.get<Textbook>('textbook', tb.id)) {
      store.insert('textbook', tb);
      inserted++;
    }
  }
  for (const o of sampleObjectives(by, at)) {
    if (!store.get('objective', o.id)) {
      store.insert('objective', o);
      inserted++;
    }
  }
  const tbs = new Map<string, Textbook>([
    [market.id, store.mustGet<Textbook>('textbook', market.id)],
    [inhouse.id, store.mustGet<Textbook>('textbook', inhouse.id)],
  ]);
  for (const c of sampleCurricula(by, at, tbs)) {
    if (!store.get<Curriculum>('curriculum', c.id)) {
      store.insert('curriculum', c);
      inserted++;
    }
  }
  return { inserted };
}

// CLI
if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('seed.ts')) {
  const { buildApp } = await import('./app.ts');
  const { resolveDbPath } = await import('./paths.ts');
  const dbPath = resolveDbPath();
  const { app, ctx } = await buildApp({ dbPath });
  const admin = seedAdmin(ctx);
  console.log(admin.created ? `관리자 계정 생성: ${admin.username}` : `관리자 계정 있음: ${admin.username}`);
  if (process.argv.includes('--sample')) {
    const t = seedDemoTeacher(ctx);
    const r = seedSamples(ctx);
    console.log(`샘플 데이터 ${r.inserted}건 추가${t ? ', 샘플 강사 계정(teacher) 생성' : ''}`);
  }
  console.log(`DB: ${dbPath}`);
  await app.close();
}
