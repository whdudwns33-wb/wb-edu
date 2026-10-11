/**
 * 독립 코드 리뷰에서 확인된 결함의 회귀 테스트 (2026-10-11).
 * 각 테스트 이름의 번호는 리뷰 보고서의 결함 번호다.
 */
import { describe, expect, it } from 'vitest';
import { baseSettings, makePlan, sampleWorld, BY } from './helpers.ts';
import { SAMPLE_IDS } from '../src/sample.ts';
import {
  addMakeupDay,
  applySettingsAndReschedule,
  cancelLesson,
  continueAssignment,
  latestUndoableId,
  pinAssignment,
  postponeLesson,
  rescheduleRemaining,
  swapLessons,
  undoHistory,
} from '../src/scheduler.ts';
import { itemCompletion, remainingAfterRecord } from '../src/progress.ts';
import { buildPlanViews } from '../src/views.ts';
import type { Plan } from '../src/types.ts';

let t = 0;
const meta = () => ({ by: BY, at: `2026-04-01T00:${String(++t).padStart(2, '0')}:00.000Z` });
const rec = (plan: Plan, assignmentId: string, status: 'done' | 'partial' | 'not_done', extra: Record<string, unknown> = {}, at = `2026-04-01T01:${String(++t).padStart(2, '0')}:00.000Z`) => {
  const a = plan.assignments.find((x) => x.id === assignmentId)!;
  plan.records.push({ id: `r-${t}`, assignmentId, lessonId: a.lessonId, date: plan.lessons.find((l) => l.id === a.lessonId)!.date, status, reason: '', note: '', recordedAt: at, recordedBy: BY, ...extra });
};

function world(id = SAMPLE_IDS.curriculumBasic, over = {}) {
  const w = sampleWorld();
  const c = w.curricula.find((x) => x.id === id)!;
  return makePlan(c, w.tbs, baseSettings({ endDate: '2026-05-31', ...over }));
}

describe('리뷰 결함 회귀 테스트', () => {
  it('#1 설정을 바꿔도 기록·고정이 있는 수업은 사라지지 않는다', () => {
    const { plan, ctx } = world();
    const a0 = plan.assignments.find((a) => a.lessonId === plan.lessons[0].id)!;
    rec(plan, a0.id, 'done');
    const late = plan.assignments.find((a) => a.lessonId === plan.lessons[4].id)!;
    const pinned = pinAssignment(plan, ctx, late.id, plan.lessons[4].date, meta()).plan;
    // 월·목 → 화·금, 시작일도 뒤로
    const res = applySettingsAndReschedule(pinned, ctx, { ...pinned.settings, weekdays: [2, 5], startDate: '2026-04-07' }, meta());
    const p = res.plan;
    const lessonIds = new Set(p.lessons.map((l) => l.id));
    for (const a of p.assignments) expect(lessonIds.has(a.lessonId)).toBe(true);
    expect(lessonIds.has(plan.lessons[0].id)).toBe(true);
    expect(p.assignments.find((a) => a.id === late.id)!.locked).toBe(true);
    // 기록이 보기·집계에서 빠지지 않는다
    expect(buildPlanViews(p).summary.recorded.done).toBe(1);
    // 보존된 수업에는 새 진도를 더 넣지 않는다
    const kept = p.lessons.find((l) => l.id === plan.lessons[0].id)!;
    const used = p.assignments.filter((a) => a.lessonId === kept.id && a.activity !== 'homework').reduce((s, a) => s + a.minutes, 0);
    expect(used).toBeLessThanOrEqual(kept.availableMinutes);
    expect(p.assignments.filter((a) => a.lessonId === kept.id).map((a) => a.id)).toEqual([a0.id]);
  });

  it('#2 기록은 배정마다 가장 최근 것만 센다 (완료 → 미진행 정정)', () => {
    const { plan } = world();
    const a0 = plan.assignments[0];
    rec(plan, a0.id, 'done');
    expect(itemCompletion(plan, a0.itemId)!.completed).toBe(12);
    rec(plan, a0.id, 'not_done');
    expect(itemCompletion(plan, a0.itemId)!.completed).toBe(0);
  });

  it('#3 같은 배정은 한 번만 이어서 진행할 수 있다', () => {
    const { plan, ctx } = world();
    const a0 = plan.assignments[0];
    rec(plan, a0.id, 'partial', { completedPortion: { from: 12, to: 13 } });
    const p1 = continueAssignment(plan, ctx, a0.id, remainingAfterRecord(plan, a0.id)!, meta()).plan;
    expect(p1.assignments.filter((a) => a.continuedFrom === a0.id)).toHaveLength(1);
    expect(() => continueAssignment(p1, ctx, a0.id, remainingAfterRecord(p1, a0.id)!, meta())).toThrow(/이미 남은 범위/);
  });

  it('#4 마지막 수업 뒤 날짜부터 재편성하면 아무 수업도 다시 채우지 않는다', () => {
    const { plan, ctx } = world();
    const p1 = postponeLesson(plan, ctx, plan.lessons[0].id, meta()).plan;
    expect(p1.assignments.some((a) => a.lessonId === p1.lessons[0].id)).toBe(false);
    const p2 = rescheduleRemaining(p1, ctx, '2026-06-15', meta()).plan;
    expect(p2.assignments.some((a) => a.lessonId === p2.lessons[0].id)).toBe(false);
  });

  it('#5 종료일 뒤 보강일은 그 날짜만 추가하고 사이의 정규 요일을 늘리지 않는다', () => {
    const { plan, ctx } = world(SAMPLE_IDS.curriculumParallel, { endDate: '2026-04-30' });
    const c = cancelLesson(plan, ctx, plan.lessons.find((l) => l.date === '2026-04-20')!.id, '휴강', meta()).plan;
    const p = addMakeupDay(c, ctx, '2026-05-21', undefined, '보강', meta()).plan;
    expect(p.lessons.filter((l) => l.date > '2026-04-30').map((l) => `${l.date}:${l.status}`)).toEqual(['2026-05-21:makeup']);
    expect(p.unassigned.filter((u) => u.reason !== 'excluded')).toHaveLength(0);
  });

  it('#6 가장 최근 변경부터 차례로만 되돌릴 수 있어 뒤의 고정이 말없이 사라지지 않는다', () => {
    const { plan, ctx } = world();
    const p1 = postponeLesson(plan, ctx, plan.lessons[1].id, meta()).plan;
    const x = p1.assignments.find((a) => a.lessonId === p1.lessons[5].id)!;
    const p2 = pinAssignment(p1, ctx, x.id, p1.lessons[5].date, meta()).plan;
    const postponeEntry = p2.history.find((h) => h.action === 'postpone')!;
    const pinEntry = p2.history.find((h) => h.action === 'pin')!;
    expect(latestUndoableId(p2)).toBe(pinEntry.id);
    expect(() => undoHistory(p2, postponeEntry.id, meta())).toThrow(/최근 변경부터/);
    const p3 = undoHistory(p2, pinEntry.id, meta()).plan;
    expect(p3.assignments.find((a) => a.id === x.id)!.locked).toBe(false);
    expect(latestUndoableId(p3)).toBe(postponeEntry.id);
    const p4 = undoHistory(p3, postponeEntry.id, meta()).plan;
    expect(latestUndoableId(p4)).toBeNull();
  });

  it('#7 휴강·공휴일 수업과는 맞바꿀 수 없다', () => {
    const { plan, ctx } = world(SAMPLE_IDS.curriculumParallel, { endDate: '2026-04-30' });
    const can = plan.lessons.find((l) => l.date === '2026-04-27')!;
    const p = cancelLesson(plan, ctx, can.id, '휴강', meta()).plan;
    expect(() => swapLessons(p, ctx, p.lessons[1].id, can.id, meta())).toThrow(/휴강/);
  });

  it('#9 고정된 배정이 있는 수업은 휴강 처리할 수 없다', () => {
    const { plan, ctx } = world();
    const x = plan.assignments.find((a) => a.lessonId === plan.lessons[3].id)!;
    const p = pinAssignment(plan, ctx, x.id, plan.lessons[2].date, meta()).plan;
    expect(() => cancelLesson(p, ctx, p.lessons[2].id, '휴강', meta())).toThrow(/고정된 배정/);
  });

  it('#10 수량형 부분 완료 %는 이번 배정 분량 기준이다', () => {
    const { plan } = world(SAMPLE_IDS.curriculumParallel, { endDate: '2026-04-30' });
    // 활동지(수량형, 1개)를 0.5 조각으로 만든 배정
    const a = plan.assignments.find((x) => x.textbookId === SAMPLE_IDS.inhouseTextbook)!;
    a.fraction = 0.5;
    rec(plan, a.id, 'partial', { completedFraction: 0.5 });
    const c = itemCompletion(plan, a.itemId)!;
    expect(c.completedFraction).toBeCloseTo(0.25);
    const rem = remainingAfterRecord(plan, a.id)!;
    expect(rem.fraction).toBeCloseTo(0.25);
    expect(rem.minutes).toBe(Math.max(5, Math.round(a.minutes / 2)));
  });
});
