import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Curriculum, CurriculumTextbookRef, Textbook } from '@wb/shared';
import { buildApp } from '../src/app.ts';
import { hashPassword } from '../src/auth.ts';

let app: FastifyInstance;
let cookie = '';
let main: Textbook;
let supplement: Textbook;
const request = (options: Record<string, unknown>) => app.inject({ ...options, headers: { cookie } } as never);
const ref = (tb: Textbook, role: CurriculumTextbookRef['role'] = 'main'): CurriculumTextbookRef => ({ textbookId: tb.id, edition: tb.edition, textbookVersion: tb.version, role, includedItemIds: null, excludedItemIds: [] });
const assemble = (patch: Record<string, unknown> = {}) => request({ method: 'POST', url: '/api/curricula/auto-assemble', payload: { textbooks: [ref(main)], compositionMode: 'sequential', minutesPerSession: 60, reviewMinutes: 0, bufferMinutes: 0, ...patch } });

beforeAll(async () => {
  const built = await buildApp({ dbPath: ':memory:' });
  app = built.app;
  built.ctx.store.insertUser({ id: 'curriculum-test-admin', username: 'curriculum-test', displayName: '[가상] 과정 검사 관리자', role: 'admin', passwordHash: hashPassword('curriculum-test-password'), createdAt: built.ctx.now() });
  await app.ready();
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'curriculum-test', password: 'curriculum-test-password' } });
  expect(login.statusCode).toBe(200);
  const session = login.cookies.find((c) => c.name === 'wb_session')!;
  cookie = `${session.name}=${session.value}`;
  const tb = await request({ method: 'POST', url: '/api/textbooks', payload: { title: '[가상] 트랙 주교재', edition: '검사용 1판', isSample: true, items: [
    { id: 'track-main-1', title: '[가상] 차시에 들어가는 항목', progressUnit: 'activity', minutes: 20, splittable: false },
    { id: 'track-main-2', title: '[가상] 긴 미배정 항목', progressUnit: 'activity', minutes: 90, splittable: false },
  ] } });
  expect(tb.statusCode).toBe(201);
  main = tb.json();
  const sub = await request({ method: 'POST', url: '/api/textbooks', payload: { title: '[가상] 트랙 보충교재', edition: '검사용 1판', isSample: true, items: [
    { id: 'track-supplement-1', title: '[가상] 연결 연습', progressUnit: 'activity', minutes: 10, splittable: false, attachToItemId: main.items[0].id },
  ] } });
  expect(sub.statusCode).toBe(201);
  supplement = sub.json();
});

afterAll(async () => { await app.close(); });

describe('자동 구성 기본 트랙과 입력 검사', () => {
  it.each(['current', 'review', 'advance'])('%s 요청을 차시와 미배정 항목에 모두 반영한다', async (track) => {
    const result = await assemble({ track });
    expect(result.statusCode).toBe(200);
    const draft = result.json();
    expect(draft.sessions).toHaveLength(1);
    expect(draft.unassignedEntries).toHaveLength(1);
    expect([...draft.sessions.flatMap((s: Curriculum['sessions'][number]) => s.entries), ...draft.unassignedEntries].every((e) => e.track === track)).toBe(true);
  });

  it('생략한 기본 트랙은 현행이다', async () => {
    const result = await assemble();
    expect(result.statusCode).toBe(200);
    expect(result.json().sessions[0].entries[0].track).toBe('current');
  });

  it('보충형의 연습 활동은 선택 트랙과 독립적으로 유지한다', async () => {
    const result = await assemble({ textbooks: [{ ...ref(main), includedItemIds: [main.items[0].id] }, ref(supplement, 'supplement')], compositionMode: 'supplement', track: 'advance' });
    expect(result.statusCode).toBe(200);
    const entries = result.json().sessions.flatMap((s: Curriculum['sessions'][number]) => s.entries);
    expect(entries.map((e: { track: string }) => e.track)).toEqual(['advance', 'advance']);
    expect(entries.map((e: { activity: string }) => e.activity)).toEqual(['new', 'practice']);
  });

  it.each(['preview', '', null, 1])('잘못된 트랙 %s는 자동 구성과 과정 저장에서 거절한다', async (track) => {
    const result = await assemble({ track });
    expect(result.statusCode).toBe(400);
    expect(result.json().error).toContain('트랙은 현행, 복습·보충, 선행');
    const draft = (await assemble()).json();
    const save = await request({ method: 'POST', url: '/api/curricula', payload: { ...draft, title: '[가상] 잘못된 트랙 과정', sessions: [{ ...draft.sessions[0], entries: [{ ...draft.sessions[0].entries[0], track }] }] } });
    expect(save.statusCode).toBe(400);
  });
});

describe('과정 원천 미배정 발행 차단', () => {
  it('초안 저장은 허용하고 발행 거절은 문서 버전을 바꾸지 않는다', async () => {
    const draft = (await assemble()).json();
    const save = await request({ method: 'POST', url: '/api/curricula', payload: { ...draft, title: '[가상] 미배정 발행 검사', status: 'draft', isSample: true } });
    expect(save.statusCode).toBe(201);
    const c: Curriculum = save.json();
    const publish = await request({ method: 'POST', url: `/api/curricula/${c.id}/publish`, payload: { version: c.version } });
    expect(publish.statusCode).toBe(400);
    expect(publish.json().error).toContain(main.title);
    expect(publish.json().error).toContain(main.items[1].title);
    const latest = await request({ method: 'GET', url: `/api/curricula/${c.id}` });
    expect(latest.json().version).toBe(c.version);
    expect(latest.json().curriculumVersion).toBe(c.curriculumVersion);
    expect(latest.json().unassignedEntries).toEqual(c.unassignedEntries);
    const updated = await request({ method: 'PUT', url: `/api/curricula/${c.id}`, payload: { ...c, sessions: [...c.sessions, { id: 'manual-placed', order: 2, title: '직접 배치', entries: c.unassignedEntries }], unassignedEntries: [] } });
    expect(updated.statusCode).toBe(200);
    const ok = await request({ method: 'POST', url: `/api/curricula/${c.id}/publish`, payload: { version: updated.json().version } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().status).toBe('verified');
  });

  it('검증됨 상태 직접 저장으로도 미배정 차단을 우회할 수 없다', async () => {
    const draft = (await assemble()).json();
    const before = (await request({ method: 'GET', url: '/api/curricula' })).json().length;
    const save = await request({ method: 'POST', url: '/api/curricula', payload: { ...draft, title: '[가상] 검증 상태 우회 검사', status: 'verified', isSample: true } });
    expect(save.statusCode).toBe(400);
    expect((await request({ method: 'GET', url: '/api/curricula' })).json()).toHaveLength(before);
    const created = await request({ method: 'POST', url: '/api/curricula', payload: { ...draft, title: '[가상] 초안 상태 우회 검사', status: 'draft', isSample: true } });
    expect(created.statusCode).toBe(201);
    const c = created.json();
    const put = await request({ method: 'PUT', url: `/api/curricula/${c.id}`, payload: { ...c, status: 'verified' } });
    expect(put.statusCode).toBe(400);
    expect((await request({ method: 'GET', url: `/api/curricula/${c.id}` })).json().version).toBe(c.version);
  });
});
