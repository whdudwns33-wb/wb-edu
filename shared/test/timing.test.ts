import { describe, expect, it } from 'vitest';
import { baseSettings, makePlan, sampleWorld, BY } from './helpers.ts';
import { SAMPLE_IDS } from '../src/sample.ts';
import { timingSuggestions } from '../src/timing.ts';
import type { Plan } from '../src/types.ts';

function done(plan: Plan, assignmentId: string, actualMinutes: number, i: number) {
  const a = plan.assignments.find((x) => x.id === assignmentId)!;
  plan.records.push({ id: `r-${assignmentId}-${i}`, assignmentId, lessonId: a.lessonId, date: '2026-04-06', status: 'done', actualMinutes, reason: '', note: '', recordedAt: `2026-04-06T10:0${i}:00Z`, recordedBy: BY });
}

describe('실제 소요시간 기반 개선 제안', () => {
  const { curricula, tbs, market } = sampleWorld();
  const basic = curricula.find((c) => c.id === SAMPLE_IDS.curriculumBasic)!;
  const item1 = `${SAMPLE_IDS.marketTextbook}-i1`;

  function plansWith(actuals: number[]): Plan[] {
    return actuals.map((m, i) => {
      const { plan } = makePlan(basic, tbs, baseSettings());
      plan.id = `p${i}`;
      const a = plan.assignments.find((x) => x.itemId === item1 && x.activity === 'new')!;
      done(plan, a.id, m, i);
      return plan;
    });
  }

  it('기록이 3건 미만이면 제안하지 않는다', () => {
    const s = timingSuggestions(market.id, market.items, plansWith([45, 50])).find((x) => x.itemId === item1)!;
    expect(s.samples).toHaveLength(2);
    expect(s.suggestedMinutes).toBeNull();
    expect(s.reason).toContain('3건 이상');
  });

  it('3건 이상이고 20% 이상 차이 나면 중앙값을 5분 단위로 제안한다', () => {
    const s = timingSuggestions(market.id, market.items, plansWith([40, 44, 60])).find((x) => x.itemId === item1)!;
    expect(s.medianMinutes).toBe(44);
    expect(s.suggestedMinutes).toBe(45);
    expect(s.diffRatio).toBeCloseTo((44 - 30) / 30);
  });

  it('차이가 20% 미만이면 유지한다', () => {
    const s = timingSuggestions(market.id, market.items, plansWith([30, 32, 34])).find((x) => x.itemId === item1)!;
    expect(s.suggestedMinutes).toBeNull();
    expect(s.reason).toContain('유지');
  });

  it('부분 배정의 실제 분은 항목 전체 기준으로 환산하고, 복습·부분 완료·실제 분 없는 기록은 쓰지 않는다', () => {
    const { plan } = makePlan(basic, tbs, baseSettings());
    // 1번 항목을 12~17쪽 / 18~23쪽 두 조각으로 나눈 것처럼 배정을 직접 구성
    const a = plan.assignments.find((x) => x.itemId === item1)!;
    a.portion = { from: 12, to: 17 };
    a.minutes = 15;
    plan.assignments.push({ ...a, id: 'half2', portion: { from: 18, to: 23 } });
    plan.assignments.push({ ...a, id: 'rev', activity: 'review', portion: { from: 12, to: 23 } });
    done(plan, a.id, 25, 1); // 절반에 25분 → 전체 50분
    done(plan, 'half2', 20, 2); // 절반에 20분 → 전체 40분
    done(plan, 'rev', 99, 3); // 복습은 제외
    plan.records.push({ id: 'nomin', assignmentId: a.id, lessonId: a.lessonId, date: '2026-04-06', status: 'done', reason: '', note: '', recordedAt: '2026-04-06T11:00:00Z', recordedBy: BY });
    const s = timingSuggestions(market.id, market.items, [plan]).find((x) => x.itemId === item1)!;
    expect(s.samples.map((x) => x.scaledMinutes).sort()).toEqual([40, 50]);
    expect(s.samples.every((x) => x.share === 0.5)).toBe(true);
  });

  it('실제 분 기록이 없는 항목은 결과에 나오지 않는다', () => {
    const r = timingSuggestions(market.id, market.items, plansWith([40, 44, 60]));
    expect(r.map((x) => x.itemId)).toEqual([item1]);
  });
});
