/**
 * 달력 날짜 유틸. 시간대 문제를 피하기 위해 'YYYY-MM-DD' 문자열과
 * 정수 일수(civil day number)만 사용한다. "오늘"은 Asia/Seoul 기준으로 구한다.
 */
import type { ISODate } from './types.ts';

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isISODate(s: unknown): s is ISODate {
  if (typeof s !== 'string') return false;
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12) return false;
  return d >= 1 && d <= daysInMonth(y, mo);
}

export function assertISODate(s: string, label = '날짜'): ISODate {
  if (!isISODate(s)) throw new Error(`${label} 형식이 올바르지 않습니다: ${s}`);
  return s;
}

export function parts(date: ISODate): { y: number; m: number; d: number } {
  const m = DATE_RE.exec(date);
  if (!m) throw new Error(`잘못된 날짜: ${date}`);
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

export function fmt(y: number, m: number, d: number): ISODate {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function isLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

export function daysInMonth(y: number, m: number): number {
  return [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

/** 1970-01-01 = 0 인 일수 (Howard Hinnant days_from_civil) */
export function toDayNumber(date: ISODate): number {
  const { y, m, d } = parts(date);
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor((yy >= 0 ? yy : yy - 399) / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

export function fromDayNumber(n: number): ISODate {
  const z = n + 719468;
  const era = Math.floor((z >= 0 ? z : z - 146096) / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  return fmt(m <= 2 ? y + 1 : y, m, d);
}

export function addDays(date: ISODate, n: number): ISODate {
  return fromDayNumber(toDayNumber(date) + n);
}

export function diffDays(a: ISODate, b: ISODate): number {
  return toDayNumber(b) - toDayNumber(a);
}

/** 0=일요일 ... 6=토요일 */
export function weekday(date: ISODate): number {
  const n = toDayNumber(date);
  return ((n % 7) + 11) % 7; // 1970-01-01 is Thursday (4)
}

export const WEEKDAY_LABEL = ['일', '월', '화', '수', '목', '금', '토'];

export function compareDates(a: ISODate, b: ISODate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function minDate(a: ISODate, b: ISODate): ISODate {
  return a <= b ? a : b;
}
export function maxDate(a: ISODate, b: ISODate): ISODate {
  return a >= b ? a : b;
}

/** 한국 시간 기준 오늘 */
export function todayKST(now: Date = new Date()): ISODate {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return f.format(now); // en-CA gives YYYY-MM-DD
}

export function nowISO(): string {
  return new Date().toISOString();
}

/** [from, to] 범위의 모든 날짜 */
export function eachDay(from: ISODate, to: ISODate): ISODate[] {
  const out: ISODate[] = [];
  const a = toDayNumber(from);
  const b = toDayNumber(to);
  for (let n = a; n <= b; n++) out.push(fromDayNumber(n));
  return out;
}

/** 월요일 시작 주의 월요일 날짜 */
export function startOfWeek(date: ISODate): ISODate {
  const wd = weekday(date); // 0=Sun
  const back = wd === 0 ? 6 : wd - 1;
  return addDays(date, -back);
}

export function endOfWeek(date: ISODate): ISODate {
  return addDays(startOfWeek(date), 6);
}

export function startOfMonth(date: ISODate): ISODate {
  const { y, m } = parts(date);
  return fmt(y, m, 1);
}

export function endOfMonth(date: ISODate): ISODate {
  const { y, m } = parts(date);
  return fmt(y, m, daysInMonth(y, m));
}

export function monthKey(date: ISODate): string {
  return date.slice(0, 7); // YYYY-MM
}

/** 달력 기준 분기 (1~4) */
export function calendarQuarter(date: ISODate): { year: number; quarter: number; key: string } {
  const { y, m } = parts(date);
  const q = Math.floor((m - 1) / 3) + 1;
  return { year: y, quarter: q, key: `${y}-CQ${q}` };
}

/**
 * 학년도 기준: 시작월(기본 3월)부터 12개월을 한 학년도로 보고 3개월씩 분기.
 * 예) 시작월 3: 2026-03 ~ 2027-02 = 2026학년도, 3~5월 1분기, 6~8월 2분기 ...
 */
export function academicYear(date: ISODate, startMonth: number): number {
  const { y, m } = parts(date);
  return m >= startMonth ? y : y - 1;
}

export function academicQuarter(
  date: ISODate,
  startMonth: number,
): { academicYear: number; quarter: number; key: string; label: string } {
  const { m } = parts(date);
  const ay = academicYear(date, startMonth);
  const offset = (m - startMonth + 12) % 12; // 0..11
  const q = Math.floor(offset / 3) + 1;
  return { academicYear: ay, quarter: q, key: `${ay}-AQ${q}`, label: `${ay}학년도 ${q}분기` };
}

export function academicYearRange(ay: number, startMonth: number): { from: ISODate; to: ISODate } {
  const from = fmt(ay, startMonth, 1);
  const endMonth = startMonth === 1 ? 12 : startMonth - 1;
  const endYear = startMonth === 1 ? ay : ay + 1;
  return { from, to: fmt(endYear, endMonth, daysInMonth(endYear, endMonth)) };
}

export function academicQuarterRange(
  ay: number,
  quarter: number,
  startMonth: number,
): { from: ISODate; to: ISODate } {
  const mStart = ((startMonth - 1 + (quarter - 1) * 3) % 12) + 1;
  const yStart = ay + Math.floor((startMonth - 1 + (quarter - 1) * 3) / 12);
  const mEnd = ((mStart - 1 + 2) % 12) + 1;
  const yEnd = yStart + Math.floor((mStart - 1 + 2) / 12);
  return { from: fmt(yStart, mStart, 1), to: fmt(yEnd, mEnd, daysInMonth(yEnd, mEnd)) };
}

/** 주 식별자: 그 주 월요일 날짜 */
export function weekKey(date: ISODate): string {
  return startOfWeek(date);
}

export function formatKorean(date: ISODate): string {
  const { y, m, d } = parts(date);
  return `${y}년 ${m}월 ${d}일 (${WEEKDAY_LABEL[weekday(date)]})`;
}

export function formatShort(date: ISODate): string {
  const { m, d } = parts(date);
  return `${m}/${d}(${WEEKDAY_LABEL[weekday(date)]})`;
}
