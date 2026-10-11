import { describe, expect, it } from 'vitest';
import { rangeCount, subtractRanges, unionCount, splitRangeByMinutes, normalizeRanges, itemQuantity } from '../src/units.ts';

describe('진도 단위·범위 계산', () => {
  it('12~23쪽은 12쪽으로 계산한다 (시나리오 5)', () => {
    expect(rangeCount({ from: 12, to: 23 })).toBe(12);
  });

  it('12~17쪽 완료 시 18~23쪽만 남는다 (시나리오 5)', () => {
    expect(subtractRanges({ from: 12, to: 23 }, [{ from: 12, to: 17 }])).toEqual([{ from: 18, to: 23 }]);
  });

  it('중간 범위 완료 시 양쪽이 남는다', () => {
    expect(subtractRanges({ from: 12, to: 23 }, [{ from: 15, to: 18 }])).toEqual([
      { from: 12, to: 14 },
      { from: 19, to: 23 },
    ]);
  });

  it('겹치는 완료 범위는 합집합으로 센다 (중복 집계 없음)', () => {
    expect(unionCount([{ from: 12, to: 17 }, { from: 15, to: 20 }, { from: 12, to: 14 }])).toBe(9);
    expect(normalizeRanges([{ from: 1, to: 3 }, { from: 4, to: 6 }])).toEqual([{ from: 1, to: 6 }]);
  });

  it('시간 비율로 범위를 나눈다', () => {
    const s = splitRangeByMinutes({ from: 12, to: 23 }, 60, 45);
    expect(s).toEqual({ first: { from: 12, to: 20 }, rest: { from: 21, to: 23 }, firstMinutes: 45, restMinutes: 15 });
    expect(splitRangeByMinutes({ from: 12, to: 12 }, 30, 15)).toBeNull();
  });

  it('수량형 항목은 quantity 를 사용한다', () => {
    expect(itemQuantity({ progressUnit: 'activity', quantity: 3 })).toBe(3);
    expect(itemQuantity({ progressUnit: 'page', quantity: 1, range: { from: 1, to: 10 } })).toBe(10);
  });
});
