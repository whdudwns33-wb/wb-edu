import { describe, expect, it } from 'vitest';
import { baseSettings, makePlan, sampleWorld, BY } from './helpers.ts';
import { SAMPLE_IDS } from '../src/sample.ts';
import { buildPlanViews, summarizeLessons, dayView } from '../src/views.ts';
import { objectiveMap, missingRequiredObjectives } from '../src/objectives.ts';
import { sampleObjectives } from '../src/sample.ts';
import { textbookProgress } from '../src/progress.ts';

describe('5종 보기 집계 일치 (시나리오 3)', () => {
  it('연간 = 분기 합 = 월 합 = 주 합 = 일 합', () => {
    const { curricula, tbs } = sampleWorld();
    const parallel = curricula.find((c) => c.id === SAMPLE_IDS.curriculumParallel)!;
    const { plan } = makePlan(parallel, tbs, baseSettings({ startDate: '2026-03-23', endDate: '2026-04-30' }));
    const v = buildPlanViews(plan);
    const total = v.summary;
    const yearSum = v.years.reduce((s, y) => s + y.summary.assignedMinutes, 0);
    const quarterSum = v.years.flatMap((y) => y.quarters).reduce((s, q) => s + q.summary.assignedMinutes, 0);
    const monthSum = v.years.flatMap((y) => y.quarters).flatMap((q) => q.months).reduce((s, m) => s + m.summary.assignedMinutes, 0);
    const weekSum = v.years.flatMap((y) => y.quarters).flatMap((q) => q.months).flatMap((m) => m.weeks).reduce((s, w) => s + w.summary.assignedMinutes, 0);
    const daySum = v.years.flatMap((y) => y.quarters).flatMap((q) => q.months).flatMap((m) => m.weeks).flatMap((w) => w.days).reduce((s, d) => s + d.summary.assignedMinutes, 0);
    expect(yearSum).toBe(total.assignedMinutes);
    expect(quarterSum).toBe(total.assignedMinutes);
    expect(monthSum).toBe(total.assignedMinutes);
    expect(weekSum).toBe(total.assignedMinutes);
    expect(daySum).toBe(total.assignedMinutes);
    const lessonCount = v.years.flatMap((y) => y.quarters).flatMap((q) => q.months).flatMap((m) => m.weeks).reduce((s, w) => s + w.summary.lessonCount, 0);
    expect(lessonCount).toBe(total.lessonCount);
  });

  it('월을 걸치는 주는 실제 수업일 기준으로 각 월에 나뉘어 집계된다', () => {
    const { curricula, tbs } = sampleWorld();
    const basic = curricula.find((c) => c.id === SAMPLE_IDS.curriculumBasic)!;
    // 2026-03-30(월) ~ 2026-04-05(일) 주: 3/30 과 4/2 수업
    const { plan } = makePlan(basic, tbs, baseSettings({ startDate: '2026-03-30', endDate: '2026-04-30' }));
    const v = buildPlanViews(plan);
    const months = v.years.flatMap((y) => y.quarters).flatMap((q) => q.months);
    const march = months.find((m) => m.key === '2026-03')!;
    const april = months.find((m) => m.key === '2026-04')!;
    expect(march.summary.lessonCount).toBe(1);
    const marchWeek = march.weeks[0];
    expect(marchWeek.spansMonths).toBe(true);
    expect(marchWeek.days.map((d) => d.lesson.date)).toEqual(['2026-03-30']);
    const aprilFirstWeek = april.weeks[0];
    expect(aprilFirstWeek.key).toBe('2026-03-30');
    expect(aprilFirstWeek.days.map((d) => d.lesson.date)).toEqual(['2026-04-02']);
    expect(march.summary.lessonCount + april.summary.lessonCount).toBe(plan.lessons.filter((l) => l.status === 'scheduled').length);
  });

  it('학년도 경계(2월→3월)에서 연간 보기가 나뉜다', () => {
    const { curricula, tbs } = sampleWorld();
    const basic = curricula.find((c) => c.id === SAMPLE_IDS.curriculumBasic)!;
    const { plan } = makePlan(basic, tbs, baseSettings({ startDate: '2027-02-15', endDate: '2027-03-15', weekdays: [1, 4] }));
    const v = buildPlanViews(plan);
    expect(v.years.map((y) => y.academicYear)).toEqual([2026, 2027]);
    expect(v.years[0].quarters[0].key).toBe('2026-AQ4');
    expect(v.years[1].quarters[0].key).toBe('2027-AQ1');
  });

  it('일간 보기는 시간 배분·범위·PDF 페이지를 보여준다', () => {
    const { curricula, tbs } = sampleWorld();
    const basic = curricula.find((c) => c.id === SAMPLE_IDS.curriculumBasic)!;
    const { plan } = makePlan(basic, tbs, baseSettings());
    const d = dayView(plan, plan.lessons[0]);
    expect(d.assignments[0].rangeText).toBe('12~23쪽');
    expect(d.assignments[0].pdfRangeText).toBe('PDF 14~25p');
    expect(d.timeAllocation.find((t) => t.label === '복습')!.minutes).toBe(10);
    expect(d.timeAllocation.find((t) => t.label === '새 학습')!.minutes).toBe(45);
  });

  it('교재별 진행 단위를 섞지 않고 집계한다', () => {
    const { curricula, tbs } = sampleWorld();
    const parallel = curricula.find((c) => c.id === SAMPLE_IDS.curriculumParallel)!;
    const { plan } = makePlan(parallel, tbs, baseSettings());
    const tp = textbookProgress(plan);
    const m = tp.find((t) => t.textbookId === SAMPLE_IDS.marketTextbook)!;
    const i = tp.find((t) => t.textbookId === SAMPLE_IDS.inhouseTextbook)!;
    expect(m.byUnit.map((u) => u.unit)).toEqual(['page']);
    expect(m.byUnit[0].total).toBe(96);
    expect(i.byUnit.map((u) => u.unit)).toEqual(['activity']);
    expect(i.byUnit[0].total).toBe(8);
    expect(m.byUnit[0].basis).toContain('복습');
  });

  it('summarizeLessons 는 숙제를 수업시간에 포함하지 않는다', () => {
    const { curricula, tbs } = sampleWorld();
    const basic = structuredClone(curricula.find((c) => c.id === SAMPLE_IDS.curriculumBasic)!);
    basic.sessions[0].entries.push({ id: 'hw', textbookId: SAMPLE_IDS.marketTextbook, itemId: `${SAMPLE_IDS.marketTextbook}-i1`, track: 'current', activity: 'homework', minutes: 20 });
    const { plan } = makePlan(basic, tbs, baseSettings());
    const s = summarizeLessons(plan, plan.lessons);
    expect(s.homeworkMinutes).toBe(20);
    expect(s.assignedMinutes).toBe(240);
  });
});

describe('분할된 수량형 진도 표시', () => {
  it.each([
    [[0.1, 0.15, 0.25], '1단원'],
    [[0.25, 0.25, 0.5], '2단원'],
  ] as const)('세 배정을 분할 비율과 전체 수량으로 집계한다: %s', (fractions, expected) => {
    const { curricula, tbs } = sampleWorld();
    const basic = curricula.find((c) => c.id === SAMPLE_IDS.curriculumBasic)!;
    const { plan } = makePlan(basic, tbs, baseSettings());
    const assignment = plan.assignments[0];
    const item = plan.snapshot.textbooks.find((tb) => tb.id === assignment.textbookId)!.items.find((it) => it.id === assignment.itemId)!;
    item.progressUnit = 'unit';
    item.range = undefined;
    item.quantity = 2;
    plan.assignments = fractions.map((fraction, i) => ({ ...assignment, id: `split-${i}`, portion: undefined, fraction }));
    plan.assignments.push({ ...assignment, id: 'practice', portion: undefined, fraction: 0.5, activity: 'practice' });
    expect(summarizeLessons(plan, plan.lessons).textbooks[0].rangeText).toBe(`${expected} · 연습 1단원`);
  });
});

describe('학습목표 지도', () => {
  it('계획 배치·진행·이해 확인·미배정을 구분한다', () => {
    const { curricula, tbs } = sampleWorld();
    const basic = curricula.find((c) => c.id === SAMPLE_IDS.curriculumBasic)!;
    const { plan } = makePlan(basic, tbs, baseSettings({ endDate: '2026-04-16' })); // 4회 → 일부만 배정
    plan.requiredObjectiveIds = ['sample-obj-RD-5-01', 'sample-obj-RD-5-06', 'sample-obj-RD-6-01'];
    const objs = sampleObjectives(BY, '2026-01-01T00:00:00.000Z');
    const a0 = plan.assignments[0];
    plan.records.push({ id: 'r1', assignmentId: a0.id, lessonId: a0.lessonId, date: '2026-04-06', status: 'done', reason: '', note: '', recordedAt: '2026-04-06T10:00:00Z', recordedBy: BY });
    const map = objectiveMap(plan, objs);
    const byId = new Map(map.map((m) => [m.objectiveId, m]));
    expect(byId.get('sample-obj-RD-5-01')!.state).toBe('progressed');
    expect(byId.get('sample-obj-RD-5-02')!.state).toBe('planned');
    expect(byId.get('sample-obj-RD-5-06')!.state).toBe('unassigned');
    expect(byId.get('sample-obj-RD-6-01')!.state).toBe('unassigned');
    plan.understandingChecks.push({ id: 'u1', lessonId: a0.lessonId, itemId: a0.itemId, textbookId: a0.textbookId, objectiveIds: ['sample-obj-RD-5-01'], result: 'confirmed', note: '', checkedAt: '2026-04-06T10:00:00Z', checkedBy: BY });
    expect(objectiveMap(plan, objs).find((m) => m.objectiveId === 'sample-obj-RD-5-01')!.state).toBe('confirmed');
    const missing = missingRequiredObjectives(map);
    expect(missing.map((m) => m.objectiveId).sort()).toEqual(['sample-obj-RD-5-06', 'sample-obj-RD-6-01']);
  });
});
