import { expect, it } from 'vitest';
import { baseSettings, makePlan, sampleWorld } from './helpers.ts';
import { buildPlanViews } from '../src/views.ts';
import { SAMPLE_IDS } from '../src/sample.ts';

it.each([1, 3, 9])('학년도 시작월 %i에서 반년·학년도 경계에 수업과 배정이 중복·누락되지 않는다', startMonth => {
 const { curricula, tbs } = sampleWorld();
 const { plan } = makePlan(curricula.find(c => c.id === SAMPLE_IDS.curriculumParallel)!, tbs, baseSettings({ startDate: '2026-01-01', endDate: '2027-12-31', academicYearStartMonth: startMonth }));
 const before = JSON.stringify(plan);
 const views = buildPlanViews(plan);
 const halves = views.halfYears;
 expect(halves.reduce((s,h) => s+h.summary.lessonCount,0)).toBe(views.summary.lessonCount);
 expect(halves.reduce((s,h) => s+h.summary.assignedMinutes,0)).toBe(views.summary.assignedMinutes);
 const ids = halves.flatMap(h=>h.quarters.flatMap(q=>q.months.flatMap(m=>m.weeks.flatMap(w=>w.days.map(d=>d.lesson.id)))));
 expect(ids.length).toBe(plan.lessons.length);
 expect(new Set(ids).size).toBe(plan.lessons.length);
 for(const h of halves) {
  const from = new Date(h.from+'T00:00:00Z'), end = new Date(from);
  end.setUTCMonth(end.getUTCMonth()+6); end.setUTCDate(end.getUTCDate()-1);
  expect(h.to).toBe(end.toISOString().slice(0,10));
  expect(h.label).toContain('반기');
 }
 expect(JSON.stringify(plan)).toBe(before);
});
