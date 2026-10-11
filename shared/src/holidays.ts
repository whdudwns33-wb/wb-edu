/**
 * 대한민국 공휴일 기본 데이터.
 *
 * 출처: 「관공서의 공휴일에 관한 규정」·「공휴일에 관한 법률」의 일반 규칙을
 * 적용해 산출한 값이며, 정부 고시(임시공휴일·대체공휴일 변경)에 따라
 * 달라질 수 있다. 따라서 모든 항목은 verified=false 로 제공하고
 * 운영 설정 화면에서 확인·수정하도록 한다.
 */
import type { Holiday, HolidaySet } from './types.ts';

interface RawHoliday {
  date: string;
  name: string;
}

/**
 * 2026-10-11 공개 달력 자료(kholidayz.com 2026·2027)와 대조해 날짜가 일치함을 확인했다.
 * 단, 임시공휴일 지정·변경은 정부 고시로 바뀔 수 있으므로 verified 는 운영자가 직접 확인 후 체크한다.
 * 노동절(5/1)·제헌절(7/17)은 관공서 공휴일이 아니므로 기본 데이터에 넣지 않았다. 학원 휴무라면 직접 추가한다.
 */
const SOURCE = '관공서의 공휴일에 관한 규정 기준 산출, 2026-10-11 공개 달력과 대조 (정부 고시 최종 확인 필요)';

const RAW: Record<number, RawHoliday[]> = {
  2026: [
    { date: '2026-01-01', name: '신정' },
    { date: '2026-02-16', name: '설날 연휴' },
    { date: '2026-02-17', name: '설날' },
    { date: '2026-02-18', name: '설날 연휴' },
    { date: '2026-03-01', name: '삼일절' },
    { date: '2026-03-02', name: '삼일절 대체공휴일' },
    { date: '2026-05-05', name: '어린이날' },
    { date: '2026-05-24', name: '부처님오신날' },
    { date: '2026-05-25', name: '부처님오신날 대체공휴일' },
    { date: '2026-06-03', name: '전국동시지방선거' },
    { date: '2026-06-06', name: '현충일' },
    { date: '2026-08-15', name: '광복절' },
    { date: '2026-08-17', name: '광복절 대체공휴일' },
    { date: '2026-09-24', name: '추석 연휴' },
    { date: '2026-09-25', name: '추석' },
    { date: '2026-09-26', name: '추석 연휴' },
    { date: '2026-10-03', name: '개천절' },
    { date: '2026-10-05', name: '개천절 대체공휴일' },
    { date: '2026-10-09', name: '한글날' },
    { date: '2026-12-25', name: '성탄절' },
  ],
  2027: [
    { date: '2027-01-01', name: '신정' },
    { date: '2027-02-06', name: '설날 연휴' },
    { date: '2027-02-07', name: '설날' },
    { date: '2027-02-08', name: '설날 연휴' },
    { date: '2027-02-09', name: '설날 대체공휴일' },
    { date: '2027-03-01', name: '삼일절' },
    { date: '2027-05-05', name: '어린이날' },
    { date: '2027-05-13', name: '부처님오신날' },
    { date: '2027-06-06', name: '현충일' },
    { date: '2027-08-15', name: '광복절' },
    { date: '2027-08-16', name: '광복절 대체공휴일' },
    { date: '2027-09-14', name: '추석 연휴' },
    { date: '2027-09-15', name: '추석' },
    { date: '2027-09-16', name: '추석 연휴' },
    { date: '2027-10-03', name: '개천절' },
    { date: '2027-10-04', name: '개천절 대체공휴일' },
    { date: '2027-10-09', name: '한글날' },
    { date: '2027-10-11', name: '한글날 대체공휴일' },
    { date: '2027-12-25', name: '성탄절' },
    { date: '2027-12-27', name: '성탄절 대체공휴일' },
  ],
};

export function defaultHolidaySets(by: string, at: string): HolidaySet[] {
  return Object.entries(RAW).map(([yearStr, list]) => {
    const year = Number(yearStr);
    const holidays: Holiday[] = list.map((h) => ({
      id: `kr-${h.date}`,
      date: h.date,
      name: h.name,
      year,
      source: SOURCE,
      verified: false,
      enabled: true,
    }));
    return {
      id: `kr-${year}`,
      name: `대한민국 공휴일 ${year}`,
      year,
      source: SOURCE,
      holidays,
      createdAt: at,
      createdBy: by,
      updatedAt: at,
      updatedBy: by,
      version: 1,
      archived: false,
      isSample: false,
    };
  });
}
