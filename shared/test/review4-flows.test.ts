/**
 * 4차 독립 리뷰(교재·과정 편집 흐름)에서 재현된 결함의 회귀 테스트 (공용 로직).
 */
import { describe, expect, it } from 'vitest';
import { autoAssemble, mergeEntries, moveEntry, splitEntry } from '../src/assembler.ts';
import { previewImport } from '../src/importer.ts';
import { itemCompletion } from '../src/progress.ts';
import { BY, baseSettings, makePlan, sampleWorld } from './helpers.ts';
import { SAMPLE_IDS } from '../src/sample.ts';
import type { Curriculum, CurriculumTextbookRef, LearningItem, SessionEntry, Textbook } from '../src/types.ts';

let n = 0;
const idGen = () => `n${++n}`;
const item = (o: Partial<LearningItem>): LearningItem => ({ id: 'i', unit: '', subunit: '', order: 1, title: 't', objective: '', objectiveIds: [], progressUnit: 'page', quantity: 1, minutes: 30, minutesSource: 'entered', splittable: true, prerequisiteItemIds: [], usage: 'both', excluded: false, extra: {}, ...o });
const page = item({ id: 'i1', range: { from: 12, to: 23 } });
const E = (id: string, o: Partial<SessionEntry> = {}): SessionEntry => ({ id, textbookId: 'T', itemId: 'i1', track: 'current', activity: 'new', minutes: 30, portion: { from: 12, to: 23 }, ...o });
const cur = (sessions: SessionEntry[][], unassigned: SessionEntry[] = []) =>
  ({ sessions: sessions.map((entries, i) => ({ id: `s${i + 1}`, order: i + 1, title: `${i + 1}차시`, entries })), unassignedEntries: unassigned }) as unknown as Curriculum;

describe('4차 리뷰: 과정 편집 함수', () => {
  it('떨어진 범위·다른 활동·다른 차시의 조각은 묶지 않고 알린다', () => {
    const gap = cur([[E('a', { portion: { from: 12, to: 15 }, minutes: 10 }), E('b', { portion: { from: 20, to: 23 }, minutes: 10 })]]);
    expect(() => mergeEntries(gap, 'a', 'b')).toThrow(/이어진 범위/);
    const review = cur([[E('new1'), E('rev1', { activity: 'review', minutes: 15 })]]);
    expect(() => mergeEntries(review, 'new1', 'rev1')).toThrow(/활동/);
    const apart = cur([[E('p1', { portion: { from: 12, to: 17 }, minutes: 15 })], [E('p2', { portion: { from: 18, to: 23 }, minutes: 15 })]]);
    expect(() => mergeEntries(apart, 'p1', 'p2')).toThrow(/같은 차시/);
    // 이어진 같은 활동 조각은 묶인다
    const ok = mergeEntries(cur([[E('x', { portion: { from: 12, to: 17 }, minutes: 15 }), E('y', { portion: { from: 18, to: 23 }, minutes: 15 })]]), 'x', 'y');
    expect(ok.sessions[0].entries).toEqual([expect.objectContaining({ id: 'x', portion: { from: 12, to: 23 }, minutes: 30 })]);
  });

  it('미배정 항목도 나눌 수 있고, 없는 항목을 나누려 하면 알린다', () => {
    const c = splitEntry(cur([[]], [E('u1')]), 'u1', page, 10, idGen);
    expect(c.unassignedEntries.map((e) => e.portion)).toEqual([{ from: 12, to: 15 }, { from: 16, to: 23 }]);
    expect(() => splitEntry(cur([[]]), 'nope', page, 10, idGen)).toThrow();
  });

  it('옮기기는 입력 과정을 바꾸지 않는다', () => {
    const c = cur([[E('m1')], [E('m2', { portion: { from: 12, to: 12 } })]]);
    const before = JSON.stringify(c);
    const after = moveEntry(c, 'm1', 's2');
    expect(JSON.stringify(c)).toBe(before);
    expect(after.sessions[1].entries.map((e) => e.id)).toEqual(['m2', 'm1']);
  });

  it('자동 구성: 한 단위가 회당 시간보다 큰 항목만 미배정으로 두고 뒤 항목은 계속 배치한다', () => {
    const tb = { id: 'T', title: 'T', items: [
      item({ id: 'a', order: 1, progressUnit: 'lesson', range: { from: 1, to: 1 }, minutes: 30 }),
      item({ id: 'big', order: 2, progressUnit: 'lesson', range: { from: 2, to: 3 }, minutes: 120 }),
      item({ id: 'c', order: 3, progressUnit: 'lesson', range: { from: 4, to: 4 }, minutes: 30 }),
      item({ id: 'd', order: 4, progressUnit: 'lesson', range: { from: 5, to: 5 }, minutes: 30 }),
    ] } as unknown as Textbook;
    const ref: CurriculumTextbookRef = { textbookId: 'T', edition: '', textbookVersion: 1, role: 'main', includedItemIds: null, excludedItemIds: [] };
    const r = autoAssemble([ref], new Map([['T', tb]]), 'sequential', { minutesPerSession: 60, reviewMinutes: 10, bufferMinutes: 5, assessmentEvery: 0, idGen });
    expect(r.unassigned.map((e) => e.itemId)).toEqual(['big']);
    expect(r.sessions.flatMap((s) => s.entries.map((e) => e.itemId))).toEqual(['a', 'c', 'd']);
  });
});

describe('4차 리뷰: 가져오기·진도', () => {
  it("표의 '선수' 열을 제목이나 순서 번호로 연결하고, 못 찾으면 알린다", () => {
    const p = previewImport('순서,제목,단위,시작,끝,시간,선수\n1,중심 문장,쪽,12,23,30,\n2,문단 요약,쪽,24,35,30,중심 문장\n3,글의 구조,쪽,36,47,30,2; 없는 항목', { idGen: () => `id${++n}` });
    const [a, b, c] = p.items;
    expect(b.prerequisiteItemIds).toEqual([a.id]);
    expect(c.prerequisiteItemIds).toEqual([b.id]);
    expect(p.issues.some((i) => i.row === 3 && i.message.includes('없는 항목'))).toBe(true);
  });

  it('항목 범위 밖의 옛 배치·기록은 완료율을 100% 넘게 만들지 않는다', () => {
    const w = sampleWorld();
    const basic = w.curricula.find((c) => c.id === SAMPLE_IDS.curriculumBasic)!;
    const { plan } = makePlan(basic, w.tbs, baseSettings());
    // 교재 범위를 줄인 뒤의 스냅샷을 흉내 (옛 배치 12~23 그대로)
    const i1 = plan.snapshot.textbooks[0].items.find((x) => x.id.endsWith('-i1'))!;
    i1.range = { from: 12, to: 17 };
    for (const a of plan.assignments.filter((x) => x.itemId === i1.id)) {
      plan.records.push({ id: `r-${a.id}`, assignmentId: a.id, lessonId: a.lessonId, date: '2026-04-06', status: 'done', reason: '', note: '', recordedAt: '2026-04-06T10:00:00Z', recordedBy: BY });
    }
    const c = itemCompletion(plan, i1.id)!;
    expect(c.total).toBe(6);
    expect(c.completed).toBe(6);
    expect(c.planned).toBeLessThanOrEqual(6);
  });
});

describe('4차 리뷰: 순환 선수 관계', () => {
  it('옛 스냅샷에 순환 선수 관계가 있으면 시간 부족이 아니라 순서 제약으로 알린다', async () => {
    const { generateSchedule } = await import('../src/scheduler.ts');
    const w = sampleWorld();
    const basic = w.curricula.find((c) => c.id === SAMPLE_IDS.curriculumBasic)!;
    const { plan, ctx } = makePlan(basic, w.tbs, baseSettings({ endDate: '2026-06-30' }));
    const items = ctx.snapshot.textbooks[0].items;
    const i3 = items.find((x) => x.id.endsWith('-i3'))!;
    const i4 = items.find((x) => x.id.endsWith('-i4'))!;
    i3.prerequisiteItemIds = [...i3.prerequisiteItemIds, i4.id]; // i4 는 이미 i3 를 선수로 둔다
    const res = generateSchedule(plan.settings, ctx);
    const reasons = new Set(res.unassigned.map((u) => u.reason));
    expect(reasons.has('prerequisite')).toBe(true);
    expect(reasons.has('time_short')).toBe(false);
    expect(res.shortageMinutes).toBe(0);
  });
});
