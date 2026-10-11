import { describe, expect, it } from 'vitest';
import { assignedMinutes, baseSettings, lessonDates, makePlan, sampleWorld, BY, AT } from './helpers.ts';
import { SAMPLE_IDS } from '../src/sample.ts';
import {
  addMakeupDay,
  cancelLesson,
  confirmBlockers,
  continueAssignment,
  generateSchedule,
  pinAssignment,
  postponeLesson,
  rescheduleRemaining,
  swapLessons,
  undoHistory,
} from '../src/scheduler.ts';
import { remainingAfterRecord, itemCompletion } from '../src/progress.ts';
import type { Plan } from '../src/types.ts';

const meta = { by: BY, at: '2026-04-01T00:00:00.000Z' };

function world() {
  const w = sampleWorld();
  const parallel = w.curricula.find((c) => c.id === SAMPLE_IDS.curriculumParallel)!;
  const basic = w.curricula.find((c) => c.id === SAMPLE_IDS.curriculumBasic)!;
  return { ...w, parallel, basic };
}

describe('시간 배정 테스트 (요구사항 14절)', () => {
  it('8회 × 45분 = 360분, 병행형(A 8×30 + B 8×15)이면 전체가 배정된다', () => {
    const { parallel, tbs } = world();
    const { plan } = makePlan(parallel, tbs, baseSettings());
    expect(lessonDates(plan, 'scheduled')).toEqual(['2026-04-06', '2026-04-09', '2026-04-13', '2026-04-16', '2026-04-20', '2026-04-23', '2026-04-27', '2026-04-30']);
    expect(plan.lessons.every((l) => l.availableMinutes === 45)).toBe(true);
    expect(assignedMinutes(plan)).toBe(360);
    expect(plan.unassigned).toHaveLength(0);
    // 매 수업 A 1개 + B 1개
    for (const l of plan.lessons) {
      const mine = plan.assignments.filter((a) => a.lessonId === l.id);
      expect(mine.map((a) => a.textbookId).sort()).toEqual([SAMPLE_IDS.inhouseTextbook, SAMPLE_IDS.marketTextbook].sort());
    }
  });

  it('미래 수업 1회가 취소되면 45분이 부족하다고 표시한다 (분량 삭제·숙제 전환 없음)', () => {
    const { parallel, tbs } = world();
    const { plan, ctx } = makePlan(parallel, tbs, baseSettings());
    const target = plan.lessons.find((l) => l.date === '2026-04-20')!;
    const res = cancelLesson(plan, ctx, target.id, '학원 사정', meta);
    const p2 = res.plan;
    expect(p2.lessons.find((l) => l.date === '2026-04-20')!.status).toBe('cancelled');
    const pending = p2.unassigned.filter((u) => u.reason !== 'excluded');
    expect(pending.reduce((s, u) => s + u.minutes, 0)).toBe(45);
    expect(pending.every((u) => u.reason === 'time_short')).toBe(true);
    expect(p2.assignments.every((a) => a.activity !== 'homework')).toBe(true);
    expect(assignedMinutes(p2) + 45).toBe(360);
    expect(res.diff.unassignedMinutesAfter).toBe(45);
    expect(res.diff.unassignedMinutesBefore).toBe(0);
    // 확정 불가
    expect(confirmBlockers(p2).length).toBeGreaterThan(0);
  });

  it('보강일을 추가하면 부족이 해소된다', () => {
    const { parallel, tbs } = world();
    const { plan, ctx } = makePlan(parallel, tbs, baseSettings());
    const target = plan.lessons.find((l) => l.date === '2026-04-20')!;
    const p2 = cancelLesson(plan, ctx, target.id, '휴강', meta).plan;
    const p3 = addMakeupDay(p2, ctx, '2026-04-22', undefined, '보강', meta).plan;
    expect(p3.lessons.find((l) => l.date === '2026-04-22')!.status).toBe('makeup');
    expect(p3.unassigned.filter((u) => u.reason !== 'excluded')).toHaveLength(0);
    expect(assignedMinutes(p3)).toBe(360);
  });

  it('종료일 이후의 보강일도 수업일로 추가되어 부족이 해소된다', () => {
    const { parallel, tbs } = world();
    const { plan, ctx } = makePlan(parallel, tbs, baseSettings());
    const target = plan.lessons.find((l) => l.date === '2026-04-20')!;
    const p2 = cancelLesson(plan, ctx, target.id, '휴강', meta).plan;
    const p3 = addMakeupDay(p2, ctx, '2026-05-04', undefined, '기간 뒤 보강', meta).plan;
    const mk = p3.lessons.find((l) => l.date === '2026-05-04')!;
    expect(mk.status).toBe('makeup');
    expect(p3.lessons[p3.lessons.length - 1].date).toBe('2026-05-04');
    expect(p3.unassigned.filter((u) => u.reason !== 'excluded')).toHaveLength(0);
    expect(assignedMinutes(p3)).toBe(360);
    expect(() => addMakeupDay(p3, ctx, '2026-03-01', undefined, '', meta)).toThrow(/시작일/);
  });

  it('동일한 확정 입력은 동일한 편성 결과를 낸다', () => {
    const { parallel, tbs } = world();
    const a = makePlan(parallel, tbs, baseSettings()).plan;
    const b = makePlan(parallel, tbs, baseSettings()).plan;
    const key = (p: Plan) => p.lessons.map((l) => `${l.date}:${p.assignments.filter((x) => x.lessonId === l.id).map((x) => `${x.itemId}/${x.minutes}`).join(',')}`);
    expect(key(a)).toEqual(key(b));
  });
});

describe('달력 규칙', () => {
  it('공휴일·휴강에 걸린 수업 요일은 휴강 수업으로 남고 새 진도는 배정되지 않는다', () => {
    const { basic, tbs } = world();
    const { plan } = makePlan(basic, tbs, baseSettings({ endDate: '2026-05-31' }), ['2026-05-25']);
    const h = plan.lessons.find((l) => l.date === '2026-05-25')!;
    expect(h.status).toBe('holiday');
    expect(h.availableMinutes).toBe(0);
    expect(plan.assignments.some((a) => a.lessonId === h.id)).toBe(false);
  });

  it('월말·연말·학년도 경계를 넘는 수업일을 실제 날짜로 만든다', () => {
    const { basic, tbs } = world();
    const { plan } = makePlan(basic, tbs, baseSettings({ startDate: '2026-12-28', endDate: '2027-03-08', weekdays: [1] }));
    expect(lessonDates(plan)).toEqual(['2026-12-28', '2027-01-04', '2027-01-11', '2027-01-18', '2027-01-25', '2027-02-01', '2027-02-08', '2027-02-15', '2027-02-22', '2027-03-01', '2027-03-08']);
  });

  it('고정 일정은 그날 가능시간을 줄인다', () => {
    const { basic, tbs } = world();
    const s = baseSettings({ fixedEvents: [{ id: 'f1', date: '2026-04-06', title: '레벨 테스트', minutes: 30 }] });
    const { plan } = makePlan(basic, tbs, s);
    expect(plan.lessons[0].availableMinutes).toBe(15);
    expect(plan.lessons[0].fixedMinutes).toBe(30);
  });

  it('속도 우선은 완료 예정일을 계산한다', () => {
    const { basic, tbs } = world();
    const { plan } = makePlan(basic, tbs, baseSettings({ mode: 'pace', endDate: '' }));
    // 240분 / 45분 → 6회 (45,45,45,45,45,15) → 4/6,9,13,16,20,23
    expect(plan.endDateComputed).toBe('2026-04-23');
    expect(plan.lessons[plan.lessons.length - 1].date).toBe('2026-04-23');
    expect(plan.unassigned).toHaveLength(0);
  });

  it('기간이 부족하면 미배정 범위와 부족량을 표시한다', () => {
    const { basic, tbs } = world();
    const { plan } = makePlan(basic, tbs, baseSettings({ endDate: '2026-04-16' })); // 4회 × 45 = 180
    expect(assignedMinutes(plan)).toBe(180);
    const pending = plan.unassigned;
    expect(pending.reduce((s, u) => s + u.minutes, 0)).toBe(60);
    expect(pending.every((u) => u.reason === 'time_short')).toBe(true);
  });
});

describe('분할·순서 제약', () => {
  it('분할 불가 항목은 나누지 않고 다음 수업으로 넘긴다', () => {
    const { basic, tbs } = world();
    const { plan } = makePlan(basic, tbs, baseSettings());
    // 8번째 항목(종합 평가, 분할 불가 30분)은 하나의 배정으로만 존재
    const last = plan.assignments.filter((a) => a.itemId === `${SAMPLE_IDS.marketTextbook}-i8`);
    expect(last).toHaveLength(1);
    expect(last[0].minutes).toBe(30);
    expect(last[0].portion).toEqual({ from: 96, to: 107 });
  });

  it('회당 가능시간보다 큰 분할 불가 항목은 unsplittable 로 미배정된다', () => {
    const { basic, tbs, market } = world();
    const big = structuredClone(basic);
    const snapTbs = new Map(tbs);
    const tb = structuredClone(market);
    tb.items[7].minutes = 50;
    tb.items[7].splittable = false;
    snapTbs.set(tb.id, tb);
    big.sessions.forEach((s) => s.entries.forEach((e) => { if (e.itemId === tb.items[7].id) e.minutes = 50; }));
    const { plan } = makePlan(big, snapTbs, baseSettings());
    const u = plan.unassigned.find((x) => x.itemId === tb.items[7].id);
    expect(u?.reason).toBe('unsplittable');
  });

  it('선수 학습이 배정되지 않으면 prerequisite 사유로 미배정된다', () => {
    const { basic, tbs } = world();
    const c = structuredClone(basic);
    // 1번 항목(선수)을 과정에서 제거하면 2·3번 등이 선수 미충족
    c.sessions.forEach((s) => (s.entries = s.entries.filter((e) => e.itemId !== `${SAMPLE_IDS.marketTextbook}-i1`)));
    const { plan } = makePlan(c, tbs, baseSettings());
    expect(plan.assignments).toHaveLength(0);
    expect(plan.unassigned.every((u) => u.reason === 'prerequisite')).toBe(true);
  });

  it('숙제는 수업시간과 별도로 배정된다', () => {
    const { basic, tbs } = world();
    const c = structuredClone(basic);
    c.sessions[0].entries.push({ id: 'hw1', textbookId: SAMPLE_IDS.marketTextbook, itemId: `${SAMPLE_IDS.marketTextbook}-i1`, track: 'current', activity: 'homework', minutes: 20 });
    const { plan } = makePlan(c, tbs, baseSettings());
    const hw = plan.assignments.find((a) => a.activity === 'homework')!;
    expect(hw).toBeTruthy();
    expect(hw.lessonId).toBe(plan.lessons[0].id);
    const used = plan.assignments.filter((a) => a.lessonId === plan.lessons[0].id && a.activity !== 'homework').reduce((s, a) => s + a.minutes, 0);
    expect(used).toBeLessThanOrEqual(45);
  });
});

describe('안전한 일정 수정', () => {
  it('완료 기록과 고정 배정은 재편성으로 바뀌지 않는다 (시나리오 7)', () => {
    const { parallel, tbs } = world();
    const { plan, ctx } = makePlan(parallel, tbs, baseSettings());
    const first = plan.assignments.filter((a) => a.lessonId === plan.lessons[0].id);
    plan.records.push({ id: 'r1', assignmentId: first[0].id, lessonId: plan.lessons[0].id, date: '2026-04-06', status: 'done', reason: '', note: '', recordedAt: '2026-04-06T10:00:00.000Z', recordedBy: BY });
    const pinned = plan.assignments.find((a) => a.lessonId === plan.lessons[5].id)!;
    const p1 = pinAssignment(plan, ctx, pinned.id, '2026-04-27', meta).plan;
    const p2 = rescheduleRemaining(p1, ctx, '2026-04-09', meta).plan;
    const rec = p2.assignments.find((a) => a.id === first[0].id)!;
    expect(rec.lessonId).toBe(plan.lessons[0].id);
    const pin = p2.assignments.find((a) => a.id === pinned.id)!;
    expect(pin.locked).toBe(true);
    expect(p2.lessons.find((l) => l.id === pin.lessonId)!.date).toBe('2026-04-27');
    expect(p2.records).toHaveLength(1);
  });

  it('이전 날짜로 고정할 때 기존 수업의 배정을 삭제·덮어쓰지 않는다 (시나리오 8)', () => {
    const { parallel, tbs } = world();
    const { plan, ctx } = makePlan(parallel, tbs, baseSettings());
    const l0 = plan.lessons[0];
    const before = plan.assignments.filter((a) => a.lessonId === l0.id).map((a) => a.id);
    const later = plan.assignments.find((a) => a.lessonId === plan.lessons[4].id)!;
    const res = pinAssignment(plan, ctx, later.id, l0.date, meta);
    const after = res.plan.assignments.filter((a) => a.lessonId === l0.id).map((a) => a.id);
    expect(after).toEqual(expect.arrayContaining(before));
    expect(after).toHaveLength(before.length + 1);
    expect(res.warnings.some((w) => w.includes('초과'))).toBe(true);
    expect(res.plan.assignments).toHaveLength(plan.assignments.length);
  });

  it('미루기: 수업의 진도를 다음 수업으로 밀고 뒤 일정을 밀어낸다', () => {
    const { basic, tbs } = world();
    const { plan, ctx } = makePlan(basic, tbs, baseSettings({ endDate: '2026-05-31' }));
    const l1 = plan.lessons[1];
    const moved = plan.assignments.filter((a) => a.lessonId === l1.id).map((a) => a.itemId);
    const res = postponeLesson(plan, ctx, l1.id, meta);
    expect(res.plan.assignments.filter((a) => a.lessonId === l1.id)).toHaveLength(0);
    const l2 = res.plan.lessons[2];
    const nowIn2 = res.plan.assignments.filter((a) => a.lessonId === l2.id).map((a) => a.itemId);
    expect(nowIn2).toEqual(expect.arrayContaining(moved));
    expect(res.diff.affectedLessonDates.length).toBeGreaterThan(1);
  });

  it('이어서 진행: 남은 범위는 원래 배정과 연결되고 새 진도 완료량은 중복되지 않는다 (시나리오 5·6)', () => {
    const { basic, tbs } = world();
    const { plan, ctx } = makePlan(basic, tbs, baseSettings({ endDate: '2026-05-31' }));
    // 첫 배정: 1번 항목 12~23쪽(30분) 전체
    const a0 = plan.assignments.find((a) => a.lessonId === plan.lessons[0].id)!;
    expect(a0.portion).toEqual({ from: 12, to: 23 });
    // 12~17쪽만 완료
    plan.records.push({ id: 'r1', assignmentId: a0.id, lessonId: a0.lessonId, date: '2026-04-06', status: 'partial', completedPortion: { from: 12, to: 17 }, reason: '', note: '', recordedAt: '2026-04-06T10:00:00.000Z', recordedBy: BY });
    const rem = remainingAfterRecord(plan, a0.id)!;
    expect(rem.portion).toEqual({ from: 18, to: 23 });
    expect(rem.minutes).toBe(15);
    const res = continueAssignment(plan, ctx, a0.id, rem, meta);
    const cont = res.plan.assignments.find((a) => a.continuedFrom === a0.id)!;
    expect(cont.portion).toEqual({ from: 18, to: 23 });
    expect(cont.lessonId).toBe(res.plan.lessons[1].id);
    expect(res.plan.assignments.filter((a) => a.lessonId === res.plan.lessons[1].id)[0].id).toBe(cont.id);
    // 이어서 진행 전: 완료 6쪽, 남은 18~23
    const c0 = itemCompletion(res.plan, a0.itemId)!;
    expect(c0.completed).toBe(6);
    expect(c0.remainingRanges).toEqual([{ from: 18, to: 23 }]);
    // 이어서 진행분 완료 + 복습으로 같은 범위 재진행
    const p = res.plan;
    p.records.push({ id: 'r2', assignmentId: cont.id, lessonId: cont.lessonId, date: '2026-04-09', status: 'done', reason: '', note: '', recordedAt: '2026-04-09T10:00:00.000Z', recordedBy: BY });
    const c1 = itemCompletion(p, a0.itemId)!;
    expect(c1.completed).toBe(12);
    expect(c1.remainingRanges).toEqual([]);
    // 복습 배정 추가 후 완료해도 완료량 불변
    p.assignments.push({ ...a0, id: 'rev-1', activity: 'review', portion: { from: 12, to: 23 }, lessonId: p.lessons[2].id, order: 99 });
    p.records.push({ id: 'r3', assignmentId: 'rev-1', lessonId: p.lessons[2].id, date: '2026-04-13', status: 'done', reason: '', note: '', recordedAt: '2026-04-13T10:00:00.000Z', recordedBy: BY });
    const c2 = itemCompletion(p, a0.itemId)!;
    expect(c2.completed).toBe(12);
    // 같은 범위 중복 완료 기록도 합집합
    p.records.push({ id: 'r4', assignmentId: a0.id, lessonId: a0.lessonId, date: '2026-04-06', status: 'done', reason: '', note: '', recordedAt: '2026-04-06T11:00:00.000Z', recordedBy: BY });
    expect(itemCompletion(p, a0.itemId)!.completed).toBe(12);
  });

  it('두 수업 맞바꾸기는 선수 학습 순서를 어기면 차단한다 (사이에 있는 수업까지 검사)', () => {
    const { basic, tbs } = world();
    const { plan, ctx } = makePlan(basic, tbs, baseSettings({ endDate: '2026-05-31' }));
    expect(() => swapLessons(plan, ctx, plan.lessons[0].id, plan.lessons[3].id, meta)).toThrow(/선수 학습/);
    // 인접하지 않은 두 수업을 바꿔도 중간 수업의 선수 관계가 깨지면 차단
    expect(() => swapLessons(plan, ctx, plan.lessons[1].id, plan.lessons[4].id, meta)).toThrow(/선수 학습/);
  });

  it('선수 관계가 없으면 맞바꾸기가 되고 가능시간 초과는 경고한다', () => {
    const { parallel, tbs } = world();
    const snapTbs = new Map(tbs);
    const tb = structuredClone(tbs.get(SAMPLE_IDS.marketTextbook)!);
    tb.items.forEach((it) => (it.prerequisiteItemIds = []));
    snapTbs.set(tb.id, tb);
    const { plan, ctx } = makePlan(parallel, snapTbs, baseSettings());
    const a = plan.lessons[1];
    const b = plan.lessons[5];
    const inA = plan.assignments.filter((x) => x.lessonId === a.id).map((x) => x.id);
    const res = swapLessons(plan, ctx, a.id, b.id, meta);
    expect(res.plan.assignments.filter((x) => x.lessonId === b.id).map((x) => x.id).sort()).toEqual(inA.sort());
    expect(res.warnings).toHaveLength(0);
    expect(res.diff.affectedLessonDates).toEqual([a.date, b.date]);
  });

  it('되돌리기는 배정 상태를 복원하되 실제 기록은 지우지 않는다', () => {
    const { parallel, tbs } = world();
    const { plan, ctx } = makePlan(parallel, tbs, baseSettings());
    const target = plan.lessons.find((l) => l.date === '2026-04-20')!;
    const p2 = cancelLesson(plan, ctx, target.id, '휴강', meta).plan;
    const h = p2.history[p2.history.length - 1];
    const p3 = undoHistory(p2, h.id, { by: BY, at: '2026-04-02T00:00:00.000Z' }).plan;
    expect(p3.unassigned).toHaveLength(0);
    expect(p3.lessons.find((l) => l.date === '2026-04-20')!.status).toBe('scheduled');
    // 변경 이후 기록이 생기면 되돌리기 거부
    const a = p2.assignments[0];
    p2.records.push({ id: 'r1', assignmentId: a.id, lessonId: a.lessonId, date: '2026-04-06', status: 'done', reason: '', note: '', recordedAt: '2026-04-06T10:00:00.000Z', recordedBy: BY });
    expect(() => undoHistory(p2, h.id, { by: BY, at: '2026-04-07T00:00:00.000Z' })).toThrow(/기록/);
    expect(p2.records).toHaveLength(1);
  });

  it('완료 기록이 있는 수업은 취소·미루기를 거부한다', () => {
    const { basic, tbs } = world();
    const { plan, ctx } = makePlan(basic, tbs, baseSettings());
    const a = plan.assignments[0];
    plan.records.push({ id: 'r1', assignmentId: a.id, lessonId: a.lessonId, date: '2026-04-06', status: 'done', reason: '', note: '', recordedAt: AT, recordedBy: BY });
    expect(() => cancelLesson(plan, ctx, a.lessonId, 'x', meta)).toThrow();
    expect(() => postponeLesson(plan, ctx, a.lessonId, meta)).toThrow();
  });
});

describe('현행·선행 트랙', () => {
  it('현행 최소 시간을 유지한 채 선행을 배정한다 (시나리오 9)', () => {
    const { basic, tbs } = world();
    const c = structuredClone(basic);
    // 1~4차시 항목은 현행, 5~8차시 항목은 선행 트랙으로
    c.sessions.forEach((s) => s.entries.forEach((e) => { if (s.order > 4) e.track = 'advance'; }));
    // 선행 항목의 선수 제약 제거 (현행과 섞이도록)
    const snapTbs = new Map(tbs);
    const tb = structuredClone(tbs.get(SAMPLE_IDS.marketTextbook)!);
    tb.items.forEach((it) => (it.prerequisiteItemIds = []));
    snapTbs.set(tb.id, tb);
    const s = baseSettings({ endDate: '2026-05-31', tracks: { review: 0, advance: 15, advanceWeekdays: null, currentMinMinutes: 30 } });
    const { plan } = makePlan(c, snapTbs, s);
    for (const l of plan.lessons) {
      const mine = plan.assignments.filter((a) => a.lessonId === l.id && a.activity !== 'homework');
      const cur = mine.filter((a) => a.track === 'current').reduce((x, a) => x + a.minutes, 0);
      const adv = mine.filter((a) => a.track === 'advance').reduce((x, a) => x + a.minutes, 0);
      const total = cur + adv;
      expect(total).toBeLessThanOrEqual(l.availableMinutes);
      // 현행 분량이 뒤 수업에도 남아 있는 동안에는 현행 최소 30분 확보
      const currentRemainsAfter = plan.assignments.some((a) => a.track === 'current' && plan.lessons.findIndex((x) => x.id === a.lessonId) > plan.lessons.indexOf(l));
      if (currentRemainsAfter) expect(cur).toBeGreaterThanOrEqual(30);
      if (currentRemainsAfter && adv > 0) expect(adv).toBeLessThanOrEqual(15);
    }
    expect(plan.assignments.some((a) => a.track === 'advance')).toBe(true);
  });

  it('선행은 지정 요일에만 배치할 수 있다', () => {
    const { basic, tbs } = world();
    const c = structuredClone(basic);
    c.sessions.forEach((s) => s.entries.forEach((e) => { if (s.order > 4) e.track = 'advance'; }));
    const snapTbs = new Map(tbs);
    const tb = structuredClone(tbs.get(SAMPLE_IDS.marketTextbook)!);
    tb.items.forEach((it) => (it.prerequisiteItemIds = []));
    snapTbs.set(tb.id, tb);
    const s = baseSettings({ endDate: '2026-06-30', tracks: { review: 0, advance: 15, advanceWeekdays: [4], currentMinMinutes: 30 } });
    const { plan } = makePlan(c, snapTbs, s);
    const dateOf = new Map(plan.lessons.map((l) => [l.id, l.date]));
    const advDates = plan.assignments.filter((a) => a.track === 'advance').map((a) => dateOf.get(a.lessonId)!);
    expect(advDates.length).toBeGreaterThan(0);
    // 현행이 남아 있는 동안 선행은 목요일에만
    const lastCurrent = plan.assignments.filter((a) => a.track === 'current').map((a) => dateOf.get(a.lessonId)!).sort().pop()!;
    for (const d of advDates) if (d <= lastCurrent) expect(new Date(d + 'T00:00:00Z').getUTCDay()).toBe(4);
  });
});

describe('교재·과정 개정과 계획 보존 (시나리오 11)', () => {
  it('계획 스냅샷은 교재 수정의 영향을 받지 않는다', () => {
    const { basic, tbs, market } = world();
    const { plan } = makePlan(basic, tbs, baseSettings());
    const before = plan.snapshot.textbooks[0].items[0].range;
    market.items[0].range = { from: 1, to: 2 };
    market.items[0].title = '수정됨';
    expect(plan.snapshot.textbooks[0].items[0].range).toEqual(before);
    expect(plan.snapshot.textbooks[0].items[0].title).not.toBe('수정됨');
    const res = generateSchedule(plan.settings, { snapshot: plan.snapshot, holidayDates: [] });
    expect(res.assignments[0].portion).toEqual({ from: 12, to: 23 });
  });
});
