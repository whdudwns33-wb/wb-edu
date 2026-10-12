/**
 * 실제 소요시간 기반 예상 시간 개선 제안.
 *
 * 규칙
 *  - 새 학습 배정의 '완료' 기록 중 실제 분(actualMinutes)이 입력된 것만 쓴다.
 *  - 배정이 항목의 일부(분할·이어서 진행)라면 실제 분을 그 배정이 다룬 비율로 나눠 '항목 전체 기준 분'으로 환산한다.
 *  - 여러 계획·기록의 환산값 중앙값을 제안값으로 하고, 표본이 3개 이상이고 현재 값과 20% 이상 차이 날 때만 제안한다.
 *  - 제안은 자동 적용하지 않는다. 담당자가 교재 편집 화면에서 적용 후 저장한다.
 */
import type { LearningItem, Plan } from './types.ts';
import { assignmentPortion, latestRecordsByAssignment } from './progress.ts';
import { isRangedUnit, rangeCount } from './units.ts';

export interface TimingSample {
  planId: string;
  planTitle: string;
  date: string;
  actualMinutes: number;
  /** 항목 전체 기준으로 환산한 분 */
  scaledMinutes: number;
  share: number;
}

export interface TimingSuggestion {
  itemId: string;
  title: string;
  currentMinutes: number;
  minutesSource: LearningItem['minutesSource'];
  samples: TimingSample[];
  medianMinutes: number;
  /** 제안할 분 (5분 단위 반올림). 조건을 못 채우면 null */
  suggestedMinutes: number | null;
  /** (중앙값 − 현재) / 현재 */
  diffRatio: number;
  reason: string;
}

export const MIN_SAMPLES = 3;
export const MIN_DIFF_RATIO = 0.2;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** 배정이 항목 전체에서 차지하는 비율 (0~1] */
function shareOf(item: LearningItem, a: Parameters<typeof assignmentPortion>[0]): number {
  const p = assignmentPortion(a, item);
  if (p.range && isRangedUnit(item.progressUnit) && item.range) {
    const total = rangeCount(item.range);
    return total > 0 ? Math.min(1, rangeCount(p.range) / total) : 1;
  }
  return Math.min(1, Math.max(0.01, p.fraction));
}

export function timingSuggestions(textbookId: string, items: LearningItem[], plans: Plan[]): TimingSuggestion[] {
  const out: TimingSuggestion[] = [];
  for (const item of items) {
    if (item.excluded) continue;
    const samples: TimingSample[] = [];
    for (const plan of plans) {
      const snapTb = plan.snapshot.textbooks.find((t) => t.id === textbookId);
      const snapItem = snapTb?.items.find((i) => i.id === item.id);
      if (!snapItem) continue;
      const dateOf = new Map(plan.lessons.map((l) => [l.id, l.date]));
      // 배정마다 표본은 하나다. 가장 최근 기록이 '완료'일 때만 세고(완료를 취소했으면 빼고),
      // 실제 분은 그 배정의 완료 기록 중 분을 적은 가장 최근 것에서 가져온다 (고쳐 쓴 기록이 표본을 늘리지 않게)
      for (const latest of latestRecordsByAssignment(plan).values()) {
        if (latest.status !== 'done') continue;
        const a = plan.assignments.find((x) => x.id === latest.assignmentId);
        if (!a || a.itemId !== item.id || a.textbookId !== textbookId || a.activity !== 'new') continue;
        const withMinutes = plan.records
          .filter((r) => r.assignmentId === a.id && r.status === 'done' && r.actualMinutes && r.actualMinutes > 0)
          .sort((x, y) => (x.recordedAt < y.recordedAt ? 1 : -1))[0];
        if (!withMinutes?.actualMinutes) continue;
        const actual = withMinutes.actualMinutes;
        const share = shareOf(snapItem, a);
        samples.push({ planId: plan.id, planTitle: plan.title, date: dateOf.get(a.lessonId) ?? latest.date, actualMinutes: actual, scaledMinutes: Math.round((actual / share) * 10) / 10, share });
      }
    }
    if (samples.length === 0) continue;
    const med = median(samples.map((s) => s.scaledMinutes));
    const diffRatio = item.minutes > 0 ? (med - item.minutes) / item.minutes : 0;
    let suggested: number | null = null;
    let reason: string;
    if (samples.length < MIN_SAMPLES) reason = `기록 ${samples.length}건 (제안하려면 ${MIN_SAMPLES}건 이상 필요)`;
    else if (Math.abs(diffRatio) < MIN_DIFF_RATIO) reason = `실제 중앙값 ${med}분, 현재 값과 차이 ${Math.round(diffRatio * 100)}% (20% 미만이라 유지)`;
    else {
      suggested = Math.max(5, Math.round(med / 5) * 5);
      reason = `실제 중앙값 ${med}분 (${samples.length}건), 현재 ${item.minutes}분보다 ${Math.round(Math.abs(diffRatio) * 100)}% ${diffRatio > 0 ? '길게' : '짧게'} 걸림`;
    }
    out.push({ itemId: item.id, title: item.title, currentMinutes: item.minutes, minutesSource: item.minutesSource, samples, medianMinutes: med, suggestedMinutes: suggested, diffRatio, reason });
  }
  return out.sort((a, b) => Math.abs(b.diffRatio) - Math.abs(a.diffRatio));
}
