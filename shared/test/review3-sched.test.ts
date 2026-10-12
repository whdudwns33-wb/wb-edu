/**
 * 3차 독립 리뷰(편성 엔진·진도 집계)에서 재현된 결함의 회귀 테스트.
 * 각 테스트는 리뷰어의 재현 절차를 그대로 옮겼다.
 */
import { describe, expect, it } from 'vitest';
import { BY, baseSettings, makePlan, sampleWorld } from './helpers.ts';
import { SAMPLE_IDS, sampleObjectives } from '../src/sample.ts';
import {
  applySettingsAndReschedule,
  cancelLesson,
  continueAssignment,
  excludeUnassigned,
  generateSchedule,
  overbookedLessons,
  pinAssignment,
  postponeLesson,
} from '../src/scheduler.ts';
import { remainingAfterRecord, textbookProgress } from '../src/progress.ts';
import { advancePrerequisiteGaps, objectiveMap } from '../src/objectives.ts';
import { autoAssemble } from '../src/assembler.ts';
import type { Plan, ProgressRecord, RecordStatus } from '../src/types.ts';

let t = 0;
const meta = () => ({ by: BY, at: `2026-04-01T00:${String(++t % 60).padStart(2, '0')}:00.000Z` });
const I = (n: number) => `${SAMPLE_IDS.marketTextbook}-i${n}`;
const record = (plan: Plan, assignmentId: string, status: RecordStatus, extra: Partial<ProgressRecord> = {}) => {
  const a = plan.assignments.find((x) => x.id === assignmentId)!;
  t += 1;
  plan.records.push({
    id: `r-${t}`,
    assignmentId,
    lessonId: a.lessonId,
    date: plan.lessons.find((l) => l.id === a.lessonId)!.date,
    status,
    reason: '',
    note: '',
    recordedAt: `2026-04-01T02:${String(t % 60).padStart(2, '0')}:00.000Z`,
    recordedBy: BY,
    ...extra,
  });
};
const basic = (over: Record<string, unknown> = {}, mutate?: (c: ReturnType<typeof sampleWorld>['curricula'][number]) => void) => {
  const w = sampleWorld();
  const c = w.curricula.find((x) => x.id === SAMPLE_IDS.curriculumBasic)!;
  mutate?.(c);
  return makePlan(c, w.tbs, baseSettings({ endDate: '2026-05-31', ...over }));
};

describe('3차 리뷰: 편성 엔진', () => {
  it('이어서 진행한 남은 범위가 미배정이 되어도 두 번째 이어서 진행은 거절한다', () => {
    const { plan, ctx } = basic({ endDate: '2026-04-23' });
    const a8 = plan.assignments.find((a) => a.itemId === I(8))!;
    record(plan, a8.id, 'partial', { completedPortion: { from: 96, to: 100 } });
    const rem = remainingAfterRecord(plan, a8.id)!;
    const r1 = continueAssignment(plan, ctx, a8.id, rem, meta()).plan;
    const u = r1.unassigned.find((x) => x.itemId === I(8))!;
    expect(u.continuedFrom).toBe(a8.id);
    expect(() => continueAssignment(r1, ctx, a8.id, rem, meta())).toThrow(/미배정/);
  });

  it('수업을 미뤄도 숙제는 수업 시간을 쓰지 않고, 옮겨 간 차시 수업에 다시 붙는다', () => {
    const { plan, ctx } = basic({}, (c) => {
      c.sessions[0].entries.push({ id: 'hw1', textbookId: SAMPLE_IDS.marketTextbook, itemId: I(1), track: 'current', activity: 'homework', minutes: 40 });
    });
    const r = postponeLesson(plan, ctx, plan.lessons[0].id, meta()).plan;
    const hw = r.assignments.find((a) => a.activity === 'homework')!;
    const host = r.assignments.find((a) => a.itemId === I(1) && a.activity === 'new')!;
    expect(hw.lessonId).toBe(host.lessonId);
    // 숙제가 없을 때와 같은 날 끝난다 (숙제 40분이 수업 시간을 차지하지 않음)
    const { plan: p2, ctx: c2 } = basic();
    const r2 = postponeLesson(p2, c2, p2.lessons[0].id, meta()).plan;
    expect(r.endDateComputed).toBe(r2.endDateComputed);
    expect(overbookedLessons(r)).toEqual([]);
  });

  it('설정에서 고정 배정이 있는 날을 휴강으로 바꾸면 그 수업을 유지하고 알린다', () => {
    const { plan, ctx } = basic();
    const lesson = plan.lessons[3];
    const a = plan.assignments.find((x) => x.lessonId === lesson.id)!;
    const pinned = pinAssignment(plan, ctx, a.id, lesson.date, meta()).plan;
    const s = structuredClone(pinned.settings);
    s.offDays.push({ id: 'o1', date: lesson.date, reason: '학원 행사', source: 'manual' });
    const r = applySettingsAndReschedule(pinned, ctx, s, meta());
    const l = r.plan.lessons.find((x) => x.date === lesson.date)!;
    expect(l.status).toBe('scheduled');
    expect(overbookedLessons(r.plan)).toEqual([]);
    expect(r.warnings.join(' ')).toContain('그대로 두었습니다');
  });

  it('설정에서 휴강일을 지우면 수업이 되살아난다', () => {
    const { plan, ctx } = basic();
    const target = plan.lessons[2];
    const c1 = cancelLesson(plan, ctx, target.id, '감기', meta()).plan;
    expect(c1.lessons.find((l) => l.id === target.id)!.status).toBe('cancelled');
    const s = structuredClone(c1.settings);
    s.offDays = [];
    const r = applySettingsAndReschedule(c1, ctx, s, meta()).plan;
    const l = r.lessons.find((x) => x.date === target.date)!;
    expect(l.status).toBe('scheduled');
    expect(l.note).toBe('');
    expect(l.availableMinutes).toBe(generateSchedule(s, ctx).lessons.find((x) => x.date === target.date)!.availableMinutes);
  });

  it('가운데 범위를 먼저 마친 부분 완료는 남은 두 조각만 이어서 진행한다', () => {
    const { plan, ctx } = basic();
    const a = plan.assignments.find((x) => x.itemId === I(1))!; // 12~23, 30분
    record(plan, a.id, 'partial', { completedPortion: { from: 15, to: 18 } });
    const rem = remainingAfterRecord(plan, a.id)!;
    expect(rem.portions).toEqual([{ from: 12, to: 14 }, { from: 19, to: 23 }]);
    expect(rem.minutes).toBe(20);
    const r = continueAssignment(plan, ctx, a.id, rem, meta()).plan;
    const conts = r.assignments.filter((x) => x.continuedFrom === a.id).map((x) => x.portion);
    const contsU = r.unassigned.filter((x) => x.continuedFrom === a.id).map((x) => x.portion);
    expect([...conts, ...contsU]).toEqual(expect.arrayContaining([expect.objectContaining({ from: 12 }), expect.objectContaining({ to: 23 })]));
    // 이미 마친 15~18 은 다시 배정하지 않는다
    for (const p of [...conts, ...contsU]) expect(p!.to < 15 || p!.from > 18).toBe(true);
  });

  it('미배정을 제외 처리하면 완료율의 분모에서 빠진다', () => {
    const { plan } = basic({ endDate: '2026-04-20' });
    let p = plan;
    expect(p.unassigned.length).toBeGreaterThan(0);
    for (const u of plan.unassigned) p = excludeUnassigned(p, u.id, '이번 학기 범위 아님', meta()).plan;
    for (const a of p.assignments) record(p, a.id, 'done');
    const tp = textbookProgress(p)[0].byUnit[0];
    expect(tp.rate).toBe(1);
    expect(tp.excluded).toBeGreaterThan(0);
  });

  it('이해 확인은 고른 학습목표만 확인된 것으로 본다', () => {
    const w = sampleWorld();
    const it1 = w.market.items.find((x) => x.id === I(1))!;
    it1.objectiveIds = ['sample-obj-RD-5-01', 'sample-obj-RD-5-02'];
    const c = w.curricula.find((x) => x.id === SAMPLE_IDS.curriculumAdvance)!;
    c.advance!.requiredObjectiveIds = ['sample-obj-RD-5-01', 'sample-obj-RD-5-02'];
    const { plan } = makePlan(c, w.tbs, baseSettings({ endDate: '2026-05-31' }));
    const a = plan.assignments.find((x) => x.itemId === I(1))!;
    plan.understandingChecks.push({ id: 'u1', lessonId: a.lessonId, itemId: I(1), textbookId: SAMPLE_IDS.marketTextbook, objectiveIds: ['sample-obj-RD-5-01'], result: 'confirmed', note: '', checkedAt: '2026-04-06T10:00:00Z', checkedBy: BY });
    const objs = sampleObjectives(BY, '2026-01-01T00:00:00Z');
    const states = Object.fromEntries(objectiveMap(plan, objs).map((o) => [o.objectiveId, o.state]));
    expect(states['sample-obj-RD-5-01']).toBe('confirmed');
    expect(states['sample-obj-RD-5-02']).not.toBe('confirmed');
    expect(advancePrerequisiteGaps(plan, objs).map((g) => g.objective.id)).toEqual(['sample-obj-RD-5-02']);
  });

  it('고정 배정 때문에 재편성 뒤 선수 순서가 어긋나면 경고한다', () => {
    const { plan, ctx } = basic({ endDate: '2026-04-30' });
    const a3 = plan.assignments.find((x) => x.itemId === I(3))!;
    const d = plan.lessons.find((l) => l.id === a3.lessonId)!.date;
    const pin = pinAssignment(plan, ctx, a3.id, d, meta());
    const r = postponeLesson(pin.plan, ctx, plan.lessons[0].id, meta());
    expect(r.warnings.join(' ')).toContain('선수 순서 확인 필요');
  });

  it('한 쪽 분량이 어떤 수업에도 들어가지 않는 항목은 분할 불가로 알린다', () => {
    const w = sampleWorld();
    const i3 = w.market.items.find((x) => x.id === I(3))!;
    i3.range = { from: 36, to: 37 };
    i3.minutes = 120;
    const c = w.curricula.find((x) => x.id === SAMPLE_IDS.curriculumBasic)!;
    for (const s of c.sessions) for (const e of s.entries) if (e.itemId === i3.id) { e.minutes = 120; e.portion = { from: 36, to: 37 }; }
    const { plan } = makePlan(c, w.tbs, baseSettings({ endDate: '2026-07-31' }));
    const u = plan.unassigned.find((x) => x.itemId === I(3))!;
    expect(u.reason).toBe('unsplittable');
    expect(u.detail).toContain('한 단위');
  });

  it('붙일 수업이 없는 숙제는 수업 시간 부족 합계에 넣지 않는다', () => {
    const w = sampleWorld();
    const c = w.curricula.find((x) => x.id === SAMPLE_IDS.curriculumBasic)!;
    c.sessions[c.sessions.length - 1].entries.push({ id: 'hw8', textbookId: SAMPLE_IDS.marketTextbook, itemId: I(8), track: 'current', activity: 'homework', minutes: 60 });
    const { plan, ctx } = makePlan(c, w.tbs, baseSettings({ endDate: '2026-04-20' }));
    const res = generateSchedule(plan.settings, ctx);
    const classShort = res.unassigned.filter((u) => u.activity !== 'homework' && u.reason === 'time_short').reduce((s, u) => s + u.minutes, 0);
    expect(res.shortageMinutes).toBe(classShort);
  });

  it('자동 구성은 한 쪽짜리 항목을 두 차시로 나누지 않는다', () => {
    const w = sampleWorld();
    const tb = structuredClone(w.market);
    tb.items = [{ ...tb.items[0], id: 'one-page', title: '긴 지문 1쪽', range: { from: 50, to: 50 }, minutes: 60, splittable: true, prerequisiteItemIds: [] }];
    const tbs = new Map([[tb.id, tb]]);
    const ref = { textbookId: tb.id, edition: '', textbookVersion: 1, role: 'main' as const, includedItemIds: null, excludedItemIds: [] };
    const { sessions, unassigned } = autoAssemble([ref], tbs, 'sequential', { minutesPerSession: 60, reviewMinutes: 10, bufferMinutes: 5, assessmentEvery: 0 });
    const pieces = sessions.flatMap((s) => s.entries).filter((e) => e.itemId === 'one-page');
    expect(pieces.length).toBe(0);
    expect(unassigned.map((e) => e.itemId)).toEqual(['one-page']);
    // 들어갈 수 있으면 한 조각으로
    const r2 = autoAssemble([ref], tbs, 'sequential', { minutesPerSession: 90, reviewMinutes: 10, bufferMinutes: 5, assessmentEvery: 0 });
    expect(r2.sessions.flatMap((s) => s.entries).filter((e) => e.itemId === 'one-page')).toHaveLength(1);
  });
});
