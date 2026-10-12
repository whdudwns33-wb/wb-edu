import { describe, expect, it } from 'vitest';
import {
  academicQuarter,
  academicQuarterRange,
  academicYear,
  academicYearRange,
  addDays,
  calendarQuarter,
  daysInMonth,
  eachDay,
  endOfWeek,
  isISODate,
  startOfWeek,
  todayKST,
  toDayNumber,
  fromDayNumber,
  weekday,
} from '../src/dates.ts';

describe('달력 날짜 계산', () => {
  it('요일을 정확히 계산한다', () => {
    expect(weekday('2026-04-06')).toBe(1); // 월
    expect(weekday('2026-01-01')).toBe(4); // 목
    expect(weekday('2024-02-29')).toBe(4); // 윤년 목
  });

  it('월말·연말 경계를 넘긴다', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2027-01-01', -1)).toBe('2026-12-31');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2028, 2)).toBe(29);
  });

  it('day number 왕복', () => {
    for (const d of ['1970-01-01', '2000-02-29', '2026-10-11', '2099-12-31']) {
      expect(fromDayNumber(toDayNumber(d))).toBe(d);
    }
  });

  it('한 달을 4주로 고정하지 않는다: 2026년 3월의 월·목 수업일은 9회', () => {
    const days = eachDay('2026-03-01', '2026-03-31').filter((d) => [1, 4].includes(weekday(d)));
    expect(days).toHaveLength(9);
  });

  it('학년도 경계: 3월 시작이면 2027-02-28 은 2026학년도', () => {
    expect(academicYear('2027-02-28', 3)).toBe(2026);
    expect(academicYear('2027-03-01', 3)).toBe(2027);
    expect(academicYearRange(2026, 3)).toEqual({ from: '2026-03-01', to: '2027-02-28' });
  });

  it('달력 분기와 학년도 분기를 구분한다', () => {
    expect(calendarQuarter('2026-04-15').key).toBe('2026-CQ2');
    const aq = academicQuarter('2026-04-15', 3);
    expect(aq.key).toBe('2026-AQ1');
    expect(academicQuarter('2027-01-10', 3)).toMatchObject({ academicYear: 2026, quarter: 4 });
    expect(academicQuarterRange(2026, 4, 3)).toEqual({ from: '2026-12-01', to: '2027-02-28' });
    expect(academicQuarterRange(2026, 1, 3)).toEqual({ from: '2026-03-01', to: '2026-05-31' });
  });

  it('학년도 시작월 설정이 가능하다 (1월 시작)', () => {
    expect(academicYear('2026-12-31', 1)).toBe(2026);
    expect(academicQuarter('2026-12-31', 1).quarter).toBe(4);
  });

  it('주는 월요일 시작이며 월을 걸칠 수 있다', () => {
    expect(startOfWeek('2026-04-01')).toBe('2026-03-30');
    expect(endOfWeek('2026-03-30')).toBe('2026-04-05');
  });

  it('오늘은 한국 시간 기준', () => {
    // UTC 2026-10-10T16:00Z 는 KST 2026-10-11 01:00
    expect(todayKST(new Date('2026-10-10T16:00:00Z'))).toBe('2026-10-11');
    expect(todayKST(new Date('2026-10-10T14:59:00Z'))).toBe('2026-10-10');
  });

  it('날짜 형식 검증', () => {
    expect(isISODate('2026-02-29')).toBe(false);
    expect(isISODate('2028-02-29')).toBe(true);
    expect(isISODate('2026-13-01')).toBe(false);
  });
});

describe('한국 시간 표시', () => {
  it('저장된 UTC 시각을 한국 시간으로 보여 준다 (오전 9시 전에는 날짜도 다르다)', async () => {
    const { formatKST } = await import('../src/dates.ts');
    expect(formatKST('2026-10-12T23:30:00.000Z')).toBe('2026-10-13 08:30');
    expect(formatKST('2026-10-12T23:30:00.000Z', false)).toBe('2026-10-13');
    expect(formatKST('2026-10-13T05:00:00Z')).toBe('2026-10-13 14:00');
    expect(formatKST(undefined)).toBe('');
  });
});
