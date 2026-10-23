import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { LearningItem, Textbook } from '@wb/shared';
import { buildApp } from '../src/app.ts';
import type { AppContext } from '../src/context.ts';

let app: FastifyInstance;
let ctx: AppContext;
const cookie = 'wb_session=prerequisite-test';
const request = (opts: Record<string, unknown>) => app.inject({ ...opts, headers: { cookie } } as never);
const item = (patch: Partial<LearningItem> = {}) => ({ title: '[가상] 선수 검사 항목', progressUnit: 'activity', minutes: 10, ...patch });
const create = async (title: string, items: ReturnType<typeof item>[]) => {
  const result = await request({ method: 'POST', url: '/api/textbooks', payload: { title: `[가상] ${title}`, edition: '검사용 1판', items, isSample: true } });
  expect(result.statusCode).toBe(201);
  return result.json<Textbook>();
};

beforeEach(async () => {
  ({ app, ctx } = await buildApp({ dbPath: ':memory:' }));
  ctx.store.insertUser({ id: 'prerequisite-admin', username: 'prerequisite-admin', displayName: '[가상] 검사 관리자', role: 'admin', passwordHash: '', createdAt: ctx.now() });
  ctx.store.createSession('prerequisite-test', 'prerequisite-admin', 60_000);
  await app.ready();
});

afterEach(async () => { await app.close(); });

describe('전교재 선수 관계 저장 검사', () => {
  it('다른 교재 선수를 저장하고 복제에서도 외부 관계를 유지한다', async () => {
    const a = await create('기초 A', [item({ title: '[가상] 기초' })]);
    const b = await create('응용 B', [item({ title: '[가상] 응용', prerequisiteItemIds: [a.items[0].id] })]);
    expect(b.items[0].prerequisiteItemIds).toEqual([a.items[0].id]);
    const clone = await request({ method: 'POST', url: `/api/textbooks/${b.id}/clone` });
    expect(clone.statusCode).toBe(201);
    expect(clone.json<Textbook>().items[0].id).not.toBe(b.items[0].id);
    expect(clone.json<Textbook>().items[0].prerequisiteItemIds).toEqual([a.items[0].id]);
  });

  it('같은 교재 선수 관계와 복제의 내부 ID 변환을 유지한다', async () => {
    const textbook = await create('같은 교재', [item({ id: 'same-first' }), item({ prerequisiteItemIds: ['same-first'] })]);
    const clone = await request({ method: 'POST', url: `/api/textbooks/${textbook.id}/clone` });
    expect(clone.statusCode).toBe(201);
    const copied = clone.json<Textbook>();
    expect(copied.items[1].prerequisiteItemIds).toEqual([copied.items[0].id]);
    expect(copied.items[0].id).not.toBe('same-first');
  });

  it.each([['없는 선수', 'missing-id', '찾을 수 없습니다'], ['자기 자신', 'self-id', '자기 자신']])('%s를 거절하고 새 문서를 만들지 않는다', async (_name, prerequisiteId, message) => {
    const result = await request({ method: 'POST', url: '/api/textbooks', payload: { title: '[가상] 잘못된 선수', items: [item({ id: 'self-id', prerequisiteItemIds: [prerequisiteId] })] } });
    expect(result.statusCode).toBe(400);
    expect(result.json().error).toContain(message);
    expect(ctx.store.list<Textbook>('textbook', { includeArchived: true })).toHaveLength(0);
  });

  it('수정 후보를 포함하여 A ↔ B 순환을 거절하고 버전·원래 관계를 보존한다', async () => {
    const a = await create('순환 A', [item()]);
    const b = await create('순환 B', [item({ prerequisiteItemIds: [a.items[0].id] })]);
    const result = await request({ method: 'PUT', url: `/api/textbooks/${a.id}`, payload: { ...a, items: [{ ...a.items[0], prerequisiteItemIds: [b.items[0].id] }] } });
    expect(result.statusCode).toBe(400);
    expect(result.json().error).toContain('순환');
    expect(result.json().error).toContain(a.title);
    expect(result.json().error).toContain(b.title);
    expect(ctx.store.mustGet<Textbook>('textbook', a.id)).toEqual(a);
  });

  it('교재 간 항목 ID 중복은 모호한 참조를 만들기 전에 거절한다', async () => {
    const a = await create('중복 A', [item({ id: 'duplicate-item' })]);
    const result = await request({ method: 'POST', url: '/api/textbooks', payload: { title: '[가상] 중복 B', items: [item({ id: a.items[0].id })] } });
    expect(result.statusCode).toBe(400);
    expect(result.json().error).toContain('id가 중복');
    expect(ctx.store.list<Textbook>('textbook')).toHaveLength(1);
  });

  it.each(['제외', '보관', '삭제'])('사용 중인 선수의 %s를 거절하고, 연결을 명시적으로 해제한 뒤에는 허용한다', async (state) => {
    const a = await create(`${state} 선수 A`, [item()]);
    const b = await create(`${state} 응용 B`, [item({ prerequisiteItemIds: [a.items[0].id] })]);
    const change = () => state === '보관'
      ? request({ method: 'POST', url: `/api/textbooks/${a.id}/archive`, payload: { archived: true } })
      : request({ method: 'PUT', url: `/api/textbooks/${a.id}`, payload: { ...a, items: state === '삭제' ? [] : [{ ...a.items[0], excluded: true }] } });
    const rejected = await change();
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error).toContain('선수');
    expect(ctx.store.mustGet<Textbook>('textbook', a.id)).toEqual(a);
    expect(ctx.store.mustGet<Textbook>('textbook', b.id)).toEqual(b);
    const removed = await request({ method: 'PUT', url: `/api/textbooks/${b.id}`, payload: { ...b, items: [{ ...b.items[0], prerequisiteItemIds: [] }] } });
    expect(removed.statusCode).toBe(200);
    expect((await change()).statusCode).toBe(200);
  });

  it.each(['제외', '보관'])('%s된 항목을 새 선수로 선택할 수 없다', async (state) => {
    const a = await create(`${state}된 선수`, [item({ excluded: state === '제외' })]);
    if (state === '보관') expect((await request({ method: 'POST', url: `/api/textbooks/${a.id}/archive`, payload: { archived: true } })).statusCode).toBe(200);
    const result = await request({ method: 'POST', url: '/api/textbooks', payload: { title: '[가상] 사용할 수 없는 선수', items: [item({ prerequisiteItemIds: [a.items[0].id] })] } });
    expect(result.statusCode).toBe(400);
    expect(result.json().error).toContain('보관·제외');
    expect(ctx.store.list<Textbook>('textbook', { includeArchived: true })).toHaveLength(1);
  });

  it('제외된 출발 항목의 기존 관계는 보존하지만, 사용 재개 전 선수를 복원해야 한다', async () => {
    const a = await create('복원할 선수', [item()]);
    const b = await create('제외할 응용', [item({ prerequisiteItemIds: [a.items[0].id] })]);
    const excluded = await request({ method: 'PUT', url: `/api/textbooks/${b.id}`, payload: { ...b, items: [{ ...b.items[0], excluded: true }] } });
    expect(excluded.statusCode).toBe(200);
    expect((await request({ method: 'POST', url: `/api/textbooks/${a.id}/archive`, payload: { archived: true } })).statusCode).toBe(200);
    const excludedBook = excluded.json<Textbook>();
    const unchanged = await request({ method: 'PUT', url: `/api/textbooks/${b.id}`, payload: { ...excludedBook, title: '[가상] 기존 관계 보존' } });
    expect(unchanged.statusCode).toBe(200);
    const saved = unchanged.json<Textbook>();
    expect(saved.items[0].prerequisiteItemIds).toEqual([a.items[0].id]);
    const restore = await request({ method: 'PUT', url: `/api/textbooks/${b.id}`, payload: { ...saved, items: [{ ...saved.items[0], excluded: false }] } });
    expect(restore.statusCode).toBe(400);
    expect(ctx.store.mustGet<Textbook>('textbook', b.id)).toEqual(saved);
  });
});
