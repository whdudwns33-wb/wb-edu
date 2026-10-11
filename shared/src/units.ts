/**
 * 진도 단위·범위 계산.
 * - 12~23쪽은 12쪽이다 (양 끝 포함).
 * - 12~17쪽 완료 시 18~23쪽만 남는다.
 * - 서로 다른 단위(쪽/문항)는 합산하지 않는다.
 */
import type { ItemRange, LearningItem, ProgressUnit } from './types.ts';
import { PROGRESS_UNIT_LABEL } from './types.ts';

export const RANGED_UNITS: ReadonlySet<ProgressUnit> = new Set(['page', 'problem', 'lesson', 'passage', 'vocab']);

export function isRangedUnit(u: ProgressUnit): boolean {
  return RANGED_UNITS.has(u);
}

export function rangeCount(r: ItemRange | undefined): number {
  if (!r) return 0;
  if (r.to < r.from) return 0;
  return r.to - r.from + 1;
}

/** 항목 전체 수량 (범위형이면 범위 개수, 아니면 quantity) */
export function itemQuantity(item: Pick<LearningItem, 'range' | 'quantity' | 'progressUnit'>): number {
  if (item.range && isRangedUnit(item.progressUnit)) return rangeCount(item.range);
  return item.quantity > 0 ? item.quantity : 1;
}

export function rangeLabel(r: ItemRange | undefined, unit: ProgressUnit): string {
  if (!r) return '';
  const u = PROGRESS_UNIT_LABEL[unit] ?? '';
  if (r.from === r.to) return `${r.from}${u}`;
  return `${r.from}~${r.to}${u}`;
}

/** 범위 정규화: 정렬·병합 */
export function normalizeRanges(ranges: ItemRange[]): ItemRange[] {
  const sorted = ranges
    .filter((r) => r.to >= r.from)
    .map((r) => ({ from: r.from, to: r.to }))
    .sort((a, b) => a.from - b.from);
  const out: ItemRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.from <= last.to + 1) {
      last.to = Math.max(last.to, r.to);
    } else {
      out.push({ ...r });
    }
  }
  return out;
}

/** base 에서 subtracts 를 뺀 나머지 범위들 */
export function subtractRanges(base: ItemRange, subtracts: ItemRange[]): ItemRange[] {
  let remaining: ItemRange[] = [{ ...base }];
  for (const s of normalizeRanges(subtracts)) {
    const next: ItemRange[] = [];
    for (const r of remaining) {
      if (s.to < r.from || s.from > r.to) {
        next.push(r);
        continue;
      }
      if (s.from > r.from) next.push({ from: r.from, to: s.from - 1 });
      if (s.to < r.to) next.push({ from: s.to + 1, to: r.to });
    }
    remaining = next;
  }
  return remaining;
}

/** 두 범위의 교집합 */
export function intersectRange(a: ItemRange, b: ItemRange): ItemRange | null {
  const from = Math.max(a.from, b.from);
  const to = Math.min(a.to, b.to);
  if (to < from) return null;
  return { from, to };
}

export function unionCount(ranges: ItemRange[]): number {
  return normalizeRanges(ranges).reduce((s, r) => s + rangeCount(r), 0);
}

/**
 * 범위형 항목을 시간 비율로 앞부분/뒷부분으로 나눈다.
 * 최소 1개 단위는 앞부분에 남긴다. 나눌 수 없으면 null.
 */
export function splitRangeByMinutes(
  range: ItemRange,
  totalMinutes: number,
  firstMinutes: number,
): { first: ItemRange; rest: ItemRange; firstMinutes: number; restMinutes: number } | null {
  const count = rangeCount(range);
  if (count < 2 || totalMinutes <= 0 || firstMinutes <= 0) return null;
  const perUnit = totalMinutes / count;
  let firstCount = Math.floor(firstMinutes / perUnit);
  if (firstCount < 1) return null;
  if (firstCount >= count) firstCount = count - 1;
  const first = { from: range.from, to: range.from + firstCount - 1 };
  const rest = { from: range.from + firstCount, to: range.to };
  const fm = Math.round(perUnit * firstCount);
  return { first, rest, firstMinutes: fm, restMinutes: totalMinutes - fm };
}

/** 분 단위 포맷 */
export function fmtMinutes(min: number): string {
  if (!Number.isFinite(min)) return '-';
  const m = Math.round(min);
  if (m < 60) return `${m}분`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h}시간 ${r}분` : `${h}시간`;
}
