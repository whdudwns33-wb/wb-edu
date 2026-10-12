/**
 * 실제 진도 계산.
 *
 * 원칙
 *  - 새 진도 완료량은 활동이 '새 학습'인 배정의 완료 기록만 센다.
 *    복습·연습·평가로 같은 범위를 다시 진행해도 완료량이 늘지 않는다.
 *  - 같은 범위를 여러 번 완료해도 합집합으로 센다 (중복 집계 없음).
 *  - 이어서 진행한 배정(continuedFrom)은 원래 항목의 남은 범위이므로 합집합에 자연히 포함된다.
 *  - 숙제를 배정했다고 완료로 처리하지 않는다.
 *  - 교재별 진행 단위를 구분해 집계하고, 서로 다른 단위를 섞은 비율은 만들지 않는다.
 */
import type { Assignment, ISODate, ItemRange, LearningItem, Plan, ProgressRecord, ProgressUnit } from './types.ts';
import { PROGRESS_UNIT_LABEL } from './types.ts';
import { isRangedUnit, itemQuantity, normalizeRanges, subtractRanges, unionCount } from './units.ts';
import { snapshotItemIndex } from './scheduler.ts';

export interface ItemCompletion {
  itemId: string;
  textbookId: string;
  unit: ProgressUnit;
  /** 항목 전체 수량 */
  total: number;
  /** 계획에 배정된 수량 (새 학습) */
  planned: number;
  /** 완료 수량 (새 학습 합집합) */
  completed: number;
  /** 제외 처리된 수량 */
  excluded: number;
  /** 범위형: 남은 범위 목록 */
  remainingRanges: ItemRange[];
  /** 범위형: 완료 범위 목록 */
  completedRanges: ItemRange[];
  /** 수량형: 완료 비율 */
  completedFraction: number;
}

/** 배정 하나가 다루는 범위 (범위형) 또는 비율 (수량형) */
export function assignmentPortion(a: Assignment, item: LearningItem): { range?: ItemRange; fraction: number } {
  if (isRangedUnit(item.progressUnit) && (a.portion ?? item.range)) {
    return { range: a.portion ?? item.range!, fraction: 1 };
  }
  return { fraction: a.fraction ?? 1 };
}

/** 기록 하나가 완료한 범위/비율 */
export function recordCompleted(r: ProgressRecord, a: Assignment, item: LearningItem): { ranges: ItemRange[]; fraction: number } {
  const p = assignmentPortion(a, item);
  if (r.status === 'done') return { ranges: p.range ? [p.range] : [], fraction: p.fraction };
  if (r.status === 'partial') {
    if (p.range) {
      if (r.completedPortion) {
        const from = Math.max(p.range.from, r.completedPortion.from);
        const to = Math.min(p.range.to, r.completedPortion.to);
        return { ranges: to >= from ? [{ from, to }] : [], fraction: 0 };
      }
      return { ranges: [], fraction: 0 };
    }
    // completedFraction 은 '이 배정(이번 수업 분량)'의 몇 %를 했는지다 (0~1). 항목 전체 기준으로 바꿔 더한다.
    const share = Math.min(1, Math.max(0, r.completedFraction ?? 0));
    return { ranges: [], fraction: p.fraction * share };
  }
  return { ranges: [], fraction: 0 };
}

/** 배정 id → 가장 최근 기록 */
export function latestRecordsByAssignment(plan: Plan): Map<string, ProgressRecord> {
  const m = new Map<string, ProgressRecord>();
  for (const r of plan.records) {
    const cur = m.get(r.assignmentId);
    if (!cur || r.recordedAt >= cur.recordedAt) m.set(r.assignmentId, r);
  }
  return m;
}

export function itemCompletion(plan: Plan, itemId: string): ItemCompletion | null {
  const items = snapshotItemIndex(plan.snapshot);
  const info = items.get(itemId);
  if (!info) return null;
  const { item, textbookId } = info;
  const ranged = isRangedUnit(item.progressUnit) && !!item.range;
  const total = itemQuantity(item);
  const assignmentsById = new Map(plan.assignments.map((a) => [a.id, a]));

  const plannedRanges: ItemRange[] = [];
  let plannedFraction = 0;
  for (const a of plan.assignments) {
    if (a.itemId !== itemId || a.activity !== 'new') continue;
    const p = assignmentPortion(a, item);
    if (p.range) plannedRanges.push(p.range);
    else plannedFraction += p.fraction;
  }

  const completedRanges: ItemRange[] = [];
  const excludedRanges: ItemRange[] = [];
  let completedFraction = 0;
  let excludedFraction = 0;
  // 기록은 추가만 하며 배정마다 가장 최근 기록만 유효하다 (예: 완료 → 미진행으로 고친 경우 완료로 세지 않음)
  for (const r of latestRecordsByAssignment(plan).values()) {
    const a = assignmentsById.get(r.assignmentId);
    if (!a || a.itemId !== itemId) continue;
    if (a.activity !== 'new') continue; // 복습·연습·평가·숙제는 새 진도 완료량에 포함하지 않음
    if (r.status === 'excluded') {
      const p = assignmentPortion(a, item);
      if (p.range) excludedRanges.push(p.range);
      else excludedFraction += p.fraction;
      continue;
    }
    const c = recordCompleted(r, a, item);
    completedRanges.push(...c.ranges);
    completedFraction += c.fraction;
  }

  // 시간이 모자라 미배정이 된 뒤 '제외'로 처리한 범위도 제외 분량이다
  for (const u of plan.unassigned) {
    if (u.itemId !== itemId || u.reason !== 'excluded' || u.activity !== 'new') continue;
    if (ranged) excludedRanges.push(u.portion ?? item.range!);
    else excludedFraction += u.fraction ?? 1;
  }

  if (ranged) {
    const clip = (rs: ItemRange[]) =>
      rs.map((r) => ({ from: Math.max(r.from, item.range!.from), to: Math.min(r.to, item.range!.to) })).filter((r) => r.from <= r.to);
    completedRanges.splice(0, completedRanges.length, ...clip(completedRanges));
    plannedRanges.splice(0, plannedRanges.length, ...clip(plannedRanges));
    excludedRanges.splice(0, excludedRanges.length, ...clip(excludedRanges));
    const completedN = normalizeRanges(completedRanges);
    const remaining = subtractRanges(item.range!, [...completedN, ...excludedRanges]);
    return {
      itemId,
      textbookId,
      unit: item.progressUnit,
      total,
      planned: unionCount(plannedRanges),
      completed: unionCount(completedN),
      excluded: unionCount(subtractRanges(item.range!, subtractRanges(item.range!, normalizeRanges(excludedRanges)).concat(completedN))),
      remainingRanges: remaining,
      completedRanges: completedN,
      completedFraction: total ? unionCount(completedN) / total : 0,
    };
  }
  const cf = Math.min(1, completedFraction);
  return {
    itemId,
    textbookId,
    unit: item.progressUnit,
    total,
    planned: Math.min(total, Math.round(plannedFraction * total * 100) / 100),
    completed: Math.round(cf * total * 100) / 100,
    excluded: Math.round(Math.min(1, excludedFraction) * total * 100) / 100,
    remainingRanges: [],
    completedRanges: [],
    completedFraction: cf,
  };
}

/** 부분 완료 기록 뒤 이어서 진행할 남은 범위와 분 */
export function remainingAfterRecord(plan: Plan, assignmentId: string): { portion?: ItemRange; portions?: ItemRange[]; fraction?: number; minutes: number } | null {
  const a = plan.assignments.find((x) => x.id === assignmentId);
  if (!a) return null;
  const items = snapshotItemIndex(plan.snapshot);
  const info = items.get(a.itemId);
  if (!info) return null;
  const rec = [...plan.records].filter((r) => r.assignmentId === assignmentId).sort((x, y) => (x.recordedAt < y.recordedAt ? 1 : -1))[0];
  const p = assignmentPortion(a, info.item);
  if (!rec || rec.status === 'not_done') {
    return { portion: p.range, fraction: p.range ? undefined : p.fraction, minutes: a.minutes };
  }
  if (rec.status === 'done' || rec.status === 'excluded') return null;
  const c = recordCompleted(rec, a, info.item);
  if (p.range) {
    const rem = subtractRanges(p.range, c.ranges);
    if (rem.length === 0) return null;
    // 가운데를 먼저 마친 경우(예: 12~23 중 15~18 완료) 남은 범위는 12~14, 19~23 두 조각이다.
    // 한 범위(12~23)로 합치면 이미 한 쪽을 다시 배정하게 되므로 조각을 그대로 돌려준다.
    const count = rem.reduce((s, r) => s + (r.to - r.from + 1), 0);
    const perUnit = a.minutes / (p.range.to - p.range.from + 1);
    return { portion: rem[0], portions: rem.length > 1 ? rem : undefined, minutes: Math.max(5, Math.round(perUnit * count)) };
  }
  const remF = Math.max(0, p.fraction - c.fraction);
  if (remF <= 0.0001) return null;
  return { fraction: Number(remF.toFixed(4)), minutes: Math.max(5, Math.round((remF / p.fraction) * a.minutes)) };
}

export interface TextbookProgress {
  textbookId: string;
  title: string;
  edition: string;
  /** 단위별 집계 (서로 섞지 않음) */
  byUnit: Array<{
    unit: ProgressUnit;
    unitLabel: string;
    total: number;
    planned: number;
    completed: number;
    excluded: number;
    rate: number; // completed / (total - excluded)
    basis: string;
  }>;
}

export function textbookProgress(plan: Plan): TextbookProgress[] {
  const out: TextbookProgress[] = [];
  for (const tb of plan.snapshot.textbooks) {
    const byUnit = new Map<ProgressUnit, { total: number; planned: number; completed: number; excluded: number }>();
    for (const it of tb.items) {
      if (it.excluded) continue;
      const c = itemCompletion(plan, it.id);
      if (!c) continue;
      const agg = byUnit.get(it.progressUnit) ?? { total: 0, planned: 0, completed: 0, excluded: 0 };
      agg.total += c.total;
      agg.planned += c.planned;
      agg.completed += c.completed;
      agg.excluded += c.excluded;
      byUnit.set(it.progressUnit, agg);
    }
    out.push({
      textbookId: tb.id,
      title: tb.title,
      edition: tb.edition,
      byUnit: [...byUnit.entries()].map(([unit, v]) => ({
        unit,
        unitLabel: PROGRESS_UNIT_LABEL[unit],
        ...v,
        rate: v.total - v.excluded > 0 ? v.completed / (v.total - v.excluded) : 0,
        basis: `완료율 = 새 학습 완료 ${PROGRESS_UNIT_LABEL[unit]} ÷ (전체 − 제외). 복습·연습·숙제는 포함하지 않음.`,
      })),
    });
  }
  return out;
}

/** 기간 안 수업의 배정 완료 현황 */
export function recordsInRange(plan: Plan, from: ISODate, to: ISODate): ProgressRecord[] {
  return plan.records.filter((r) => r.date >= from && r.date <= to);
}

export function latestRecordFor(plan: Plan, assignmentId: string): ProgressRecord | undefined {
  return [...plan.records].filter((r) => r.assignmentId === assignmentId).sort((a, b) => (a.recordedAt < b.recordedAt ? 1 : -1))[0];
}
