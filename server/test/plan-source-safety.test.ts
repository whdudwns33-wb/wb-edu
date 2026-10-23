import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Curriculum, CurriculumSession, LearningItem, Plan, SessionEntry, Textbook, Track } from '@wb/shared';
import { weekday } from '@wb/shared';
import { buildApp } from '../src/app.ts';
import { hashPassword } from '../src/auth.ts';

let built: Awaited<ReturnType<typeof buildApp>>;
let cookie: string;
const settings = {
  startDate: '2026-04-06', endDate: '2026-04-30', weekdays: [1, 4],
  minutesPerLesson: 60, reviewMinutes: 10, bufferMinutes: 5, mode: 'period',
  tracks: { review: 0, advance: 0, advanceWeekdays: null, currentMinMinutes: 0 },
};

beforeEach(async () => {
  built = await buildApp({ dbPath: ':memory:' });
  built.ctx.store.insertUser({ id: 'gap-admin', username: 'gap-admin', displayName: '가상 관리자', role: 'admin', passwordHash: hashPassword('gap-test-password'), createdAt: built.ctx.now() });
  built.ctx.store.createSession('gap-session', 'gap-admin', 60000);
  cookie = 'wb_session=gap-session';
  await built.app.ready();
});
afterEach(async () => { await built.app.close(); });

const request = (method: 'POST' | 'PUT', url: string, payload: object) => built.app.inject({ method, url, payload, headers: { cookie } });
async function save<T>(method: 'POST' | 'PUT', url: string, payload: object, status = method === 'POST' ? 201 : 200): Promise<T> {
  const res = await request(method, url, payload);
  expect(res.statusCode, res.body).toBe(status);
  return res.json<T>();
}
function textbook(title: string, items: Array<Partial<LearningItem> & { id: string }>): Promise<Textbook> {
  return save('POST', '/api/textbooks', { title: `[가상] ${title}`, edition: '시험판', isSample: true, items: items.map((item) => ({ title: item.id, minutes: 15, progressUnit: 'activity', splittable: false, ...item })) });
}
function entry(tb: Textbook, itemId: string, track: Track = 'current'): SessionEntry {
  return { id: `entry-${itemId}`, textbookId: tb.id, itemId, track, activity: 'new', minutes: tb.items.find((i) => i.id === itemId)!.minutes };
}
function sessions(...entries: SessionEntry[]): CurriculumSession[] {
  return entries.map((e, i) => ({ id: `session-${i}`, title: `${i + 1}차시`, order: i + 1, entries: [e] }));
}
function curriculum(textbooks: Textbook[], assigned: CurriculumSession[], unassignedEntries: SessionEntry[] = []): Promise<Curriculum> {
  return save('POST', '/api/curricula', { title: '[가상] 원천 검사 과정', isSample: true, textbooks: textbooks.map((tb) => ({ textbookId: tb.id, role: 'main' })), sessions: assigned, unassignedEntries, status: 'draft' });
}
const createPlan = (c: Curriculum, extra = {}) => save<Plan>('POST', '/api/plans', { curriculumId: c.id, settings, ...extra });

describe('과정 원천 미배정 차단', () => {
  it('초안 저장은 허용하되 발행·미리보기·생성·갱신은 문서와 버전을 남기지 않고 거절한다', async () => {
    const tb = await textbook('교재', [{ id: 'placed', title: '배치 항목' }, { id: 'pending', title: '미배정 항목' }]);
    const clean = await curriculum([tb], sessions(entry(tb, 'placed')));
    const p = await createPlan(clean);
    const c = await save<Curriculum>('PUT', `/api/curricula/${clean.id}`, { ...clean, unassignedEntries: [entry(tb, 'pending')] });
    const beforePlan = built.ctx.store.mustGet<Plan>('plan', p.id);
    const beforeCurriculum = built.ctx.store.mustGet<Curriculum>('curriculum', c.id);
    const planCount = built.ctx.store.list<Plan>('plan').length;
    const messages: string[] = [];
    for (const [url, payload] of [
      [`/api/curricula/${c.id}/publish`, { version: c.version }],
      ['/api/plans/preview', { curriculumId: c.id, settings }],
      ['/api/plans', { curriculumId: c.id, settings }],
      [`/api/plans/${p.id}/refresh-snapshot`, { version: p.version }],
    ] as const) {
      const res = await request('POST', url, payload);
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().error).toContain('미배정 항목');
      expect(res.json().error).toContain(tb.title);
      messages.push(res.json().error);
    }
    expect(new Set(messages).size).toBe(1);
    expect(built.ctx.store.list<Plan>('plan')).toHaveLength(planCount);
    expect(built.ctx.store.mustGet<Plan>('plan', p.id)).toEqual(beforePlan);
    expect(built.ctx.store.mustGet<Curriculum>('curriculum', c.id)).toEqual(beforeCurriculum);
  });

  it.each(['배치', '명시 제외'])('미배정을 %s로 정리하면 생성된다', async (action) => {
    const tb = await textbook('범위 정리', [{ id: 'placed' }, { id: 'pending' }]);
    const pending = entry(tb, 'pending');
    const c = await curriculum([tb], sessions(entry(tb, 'placed')), [pending]);
    const edited = await save<Curriculum>('PUT', `/api/curricula/${c.id}`, {
      ...c, unassignedEntries: [],
      sessions: action === '배치' ? sessions(entry(tb, 'placed'), pending) : c.sessions,
      textbooks: action === '명시 제외' ? c.textbooks.map((ref) => ({ ...ref, excludedItemIds: ['pending'] })) : c.textbooks,
    });
    const p = await createPlan(edited);
    expect(p.unassigned).toEqual([]);
    expect(p.assignments.some((a) => a.itemId === 'pending')).toBe(action === '배치');
    expect(built.ctx.store.mustGet<Textbook>('textbook', tb.id)).toEqual(tb);
  });

  it('같은 교재의 중간 차시 선택과 갱신은 앞 차시 assumedDone을 유지한다', async () => {
    const tb = await textbook('중간 시작', [{ id: 'first' }, { id: 'second', prerequisiteItemIds: ['first'] }, { id: 'third' }]);
    const c = await curriculum([tb], sessions(entry(tb, 'first'), entry(tb, 'second'), entry(tb, 'third')));
    const p = await createPlan(c, { fromSessionOrder: 2, toSessionOrder: 2 });
    expect(p.assignments.map((a) => a.itemId)).toEqual(['second']);
    expect(p.unassigned).toEqual([]);
    expect(p.snapshot.selection?.assumedDone.map((d) => d.itemId)).toEqual(['first']);
    const refreshed = await save<Plan>('POST', `/api/plans/${p.id}/refresh-snapshot`, { version: p.version }, 200);
    expect(refreshed.snapshot.selection).toEqual(p.snapshot.selection);
    expect(refreshed.snapshot.sessions.map((s) => s.order)).toEqual([2]);
  });

  it.each(['확정', '기록', '고정'])('%s 계획은 원천 변경 후에도 스냅샷·배정·기록을 보존한다', async (protection) => {
    const tb = await textbook('보호', [{ id: 'placed' }, { id: 'pending' }]);
    const c = await curriculum([tb], sessions(entry(tb, 'placed')));
    let p = await createPlan(c);
    if (protection === '확정') p = await save('POST', `/api/plans/${p.id}/confirm`, { version: p.version }, 200);
    if (protection === '기록') p = await save('POST', `/api/plans/${p.id}/records`, { version: p.version, assignmentId: p.assignments[0].id, status: 'done' }, 200);
    if (protection === '고정') p = await save('POST', `/api/plans/${p.id}/ops`, { version: p.version, op: 'pin', params: { assignmentId: p.assignments[0].id, date: p.lessons[0].date } }, 200);
    await save('PUT', `/api/curricula/${c.id}`, { ...c, unassignedEntries: [entry(tb, 'pending')] });
    const before = built.ctx.store.mustGet<Plan>('plan', p.id);
    const res = await request('POST', `/api/plans/${p.id}/refresh-snapshot`, { version: p.version });
    expect(res.statusCode).toBe(400);
    expect(built.ctx.store.mustGet<Plan>('plan', p.id)).toEqual(before);
  });
});

describe('교재 간 선수항목을 포함한 계획', () => {
  it('두 교재가 포함되면 선수보다 후속 항목이 먼저 배정되지 않고 확정 스냅샷에 관계가 남는다', async () => {
    const a = await textbook('기초 A', [{ id: 'foundation' }]);
    const b = await textbook('후속 B', [{ id: 'dependent', prerequisiteItemIds: ['foundation'] }]);
    const c = await curriculum([b, a], sessions(entry(b, 'dependent'), entry(a, 'foundation')));
    const p = await createPlan(c);
    expect(p.assignments.map((x) => x.itemId)).toEqual(['foundation', 'dependent']);
    expect(p.unassigned).toEqual([]);
    const confirmed = await save<Plan>('POST', `/api/plans/${p.id}/confirm`, { version: p.version }, 200);
    await save('PUT', `/api/textbooks/${b.id}`, { ...b, items: b.items.map((item) => ({ ...item, prerequisiteItemIds: [] })) });
    expect(built.ctx.store.mustGet<Plan>('plan', p.id).snapshot).toEqual(confirmed.snapshot);
    expect(confirmed.snapshot.textbooks.find((tb) => tb.id === b.id)!.items[0].prerequisiteItemIds).toEqual(['foundation']);
  });

  it('후속 교재만 선택하면 미리보기·생성·초안 갱신을 거절한다', async () => {
    const a = await textbook('빠진 기초 A', [{ id: 'foundation' }]);
    let b = await textbook('후속 B', [{ id: 'dependent' }]);
    const c = await curriculum([b], sessions(entry(b, 'dependent')));
    const p = await createPlan(c);
    b = await save('PUT', `/api/textbooks/${b.id}`, { ...b, items: b.items.map((item) => ({ ...item, prerequisiteItemIds: ['foundation'] })) });
    const before = built.ctx.store.mustGet<Plan>('plan', p.id);
    for (const [url, payload] of [
      ['/api/plans/preview', { curriculumId: c.id, settings }], ['/api/plans', { curriculumId: c.id, settings }],
      [`/api/plans/${p.id}/refresh-snapshot`, { version: p.version }],
    ] as const) {
      const res = await request('POST', url, payload);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('필요한 선수항목');
      expect(res.json().details.join(' ')).toContain(a.title);
    }
    expect(built.ctx.store.list<Plan>('plan')).toHaveLength(1);
    expect(built.ctx.store.mustGet<Plan>('plan', p.id)).toEqual(before);
  });

  it.each(['삭제', '제외', '보관'])('과거 자료의 %s 선수도 새 계획에서 충족으로 취급하지 않는다', async (state) => {
    const a = await textbook('기초 A', [{ id: 'foundation' }]);
    const b = await textbook('후속 B', [{ id: 'dependent', prerequisiteItemIds: ['foundation'] }]);
    const c = await curriculum([a, b], sessions(entry(b, 'dependent')));
    // 과거에 저장된 사용할 수 없는 참조를 메모리 DB에서 재현한다.
    built.ctx.store.update('textbook', { ...a, archived: state === '보관', items: state === '삭제' ? [] : a.items.map((item) => ({ ...item, excluded: state === '제외' })) }, a.version);
    const res = await request('POST', '/api/plans', { curriculumId: c.id, settings });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('선수항목');
    expect(built.ctx.store.list<Plan>('plan')).toEqual([]);
  });

  it('선수의 선수가 선택 교재 밖에 있어도 거절한다', async () => {
    await textbook('기초 A', [{ id: 'foundation' }]);
    const b = await textbook('중간 B', [{ id: 'middle', prerequisiteItemIds: ['foundation'] }]);
    const c = await textbook('후속 C', [{ id: 'dependent', prerequisiteItemIds: ['middle'] }]);
    const course = await curriculum([b, c], sessions(entry(c, 'dependent')));
    const res = await request('POST', '/api/plans/preview', { curriculumId: course.id, settings });
    expect(res.statusCode).toBe(400);
    expect(res.json().details.join(' ')).toContain('foundation');
  });

  it('과거 자료의 교재 간 같은 id가 배치 원천을 덮지 않고, 모호한 선수 참조는 거절한다', async () => {
    const a = await textbook('선택 A', [{ id: 'same' }, { id: 'dependent', prerequisiteItemIds: ['same'] }]);
    const unrelated = await textbook('선택 밖 B', [{ id: 'other' }]);
    built.ctx.store.update('textbook', { ...unrelated, items: unrelated.items.map((i) => ({ ...i, id: 'same', prerequisiteItemIds: ['missing'] })) }, unrelated.version);
    const c = await curriculum([a], sessions(entry(a, 'same')));
    const p = await createPlan(c);
    expect(p.assignments.map((assignment) => assignment.itemId)).toEqual(['same']);
    const withDependency = await save<Curriculum>('PUT', `/api/curricula/${c.id}`, { ...c, sessions: sessions(entry(a, 'same'), entry(a, 'dependent')) });
    const res = await request('POST', '/api/plans', { curriculumId: withDependency.id, settings });
    expect(res.statusCode).toBe(400);
    expect(res.json().details.join(' ')).toContain('id 중복');
  });

  it('현행이 없어도 선행은 지정 요일에만 배정한다', async () => {
    const tb = await textbook('선행만', [{ id: 'advance-only', minutes: 15 }]);
    const c = await curriculum([tb], sessions(entry(tb, 'advance-only', 'advance')));
    const p = await createPlan(c, { settings: { ...settings, tracks: { ...settings.tracks, advance: 15, advanceWeekdays: [4] } } });
    expect(p.assignments).toHaveLength(1);
    expect(p.lessons.find((l) => l.id === p.assignments[0].lessonId)!.date).toBe('2026-04-09');
  });

  it('현행+선행 혼합 계획은 시간·요일 규칙을 지키고 설정을 바꿔도 원천 트랙을 보존한다', async () => {
    const current = await textbook('현행', [1, 2, 3, 4].map((n) => ({ id: `current-${n}`, minutes: 30 })));
    const advance = await textbook('선행', [1, 2, 3, 4].map((n) => ({ id: `advance-${n}`, minutes: 15 })));
    const c = await curriculum([current, advance], sessions(...current.items.map((i) => entry(current, i.id)), ...advance.items.map((i) => entry(advance, i.id, 'advance'))));
    const mixedSettings = { ...settings, tracks: { review: 0, advance: 15, advanceWeekdays: [4], currentMinMinutes: 30 } };
    const p = await createPlan(c, { settings: mixedSettings });
    expect(p.assignments.some((a) => a.track === 'advance')).toBe(true);
    for (const l of p.lessons) {
      const mine = p.assignments.filter((a) => a.lessonId === l.id);
      const currentMinutes = mine.filter((a) => a.track === 'current').reduce((n, a) => n + a.minutes, 0);
      const advanceMinutes = mine.filter((a) => a.track === 'advance').reduce((n, a) => n + a.minutes, 0);
      expect(currentMinutes + advanceMinutes).toBeLessThanOrEqual(l.availableMinutes);
      if (advanceMinutes > 0) expect(weekday(l.date)).toBe(4);
      const laterCurrent = p.assignments.some((a) => a.track === 'current' && p.lessons.find((next) => next.id === a.lessonId)!.date > l.date);
      if (laterCurrent) expect(currentMinutes).toBeGreaterThanOrEqual(30);
      if (laterCurrent && advanceMinutes > 0) { expect(weekday(l.date)).toBe(4); expect(advanceMinutes).toBeLessThanOrEqual(15); }
    }
    const changed = await save<Plan>('POST', `/api/plans/${p.id}/ops`, { version: p.version, op: 'settings', params: { settings: { ...mixedSettings, tracks: { ...mixedSettings.tracks, advance: 20 } } } }, 200);
    expect(changed.snapshot.sessions).toEqual(c.sessions);
    expect(built.ctx.store.mustGet<Curriculum>('curriculum', c.id).sessions).toEqual(c.sessions);
  });
});
