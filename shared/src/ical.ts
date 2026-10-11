/**
 * 실행 계획 → iCalendar(.ics, RFC 5545).
 * 구글·애플·아웃룩 캘린더에 '파일 가져오기'로 넣을 수 있다. 외부 서비스에 직접 연결하지 않는다.
 *
 *  - 수업(예정·보강)마다 종일 일정 하나 (수업 시각은 계획에 없으므로 종일로 둔다)
 *  - 휴강·공휴일 수업은 기본으로 넣지 않고, includeCancelled 이면 '휴강' 일정으로 넣는다
 *  - 설명에는 교재·범위·활동·시간을 적는다. 학생용(audience=student)은 지도 메모를 넣지 않는다
 *  - UID 는 수업 id 기반이라 다시 내보내 가져오면 같은 일정이 갱신된다
 */
import type { Plan } from './types.ts';
import { addDays } from './dates.ts';
import { dayView } from './views.ts';

export interface IcalOptions {
  audience?: 'teacher' | 'student';
  includeCancelled?: boolean;
  /** 생성 시각 (DTSTAMP). 기본 현재 */
  now?: Date;
  /** 도메인 (UID 꼬리) */
  domain?: string;
}

/** RFC 5545 TEXT 이스케이프 */
function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** 75옥텟 줄 접기 (UTF-8 바이트 기준, 다중 바이트 문자를 자르지 않음) */
export function foldLine(line: string): string {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out: string[] = [];
  let cur = '';
  let curBytes = 0;
  let limit = 75;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    if (curBytes + b > limit) {
      out.push(cur);
      cur = '';
      curBytes = 0;
      limit = 74; // 이어지는 줄은 앞의 공백 1바이트
    }
    cur += ch;
    curBytes += b;
  }
  if (cur) out.push(cur);
  return out.join('\r\n ');
}

const ymd = (d: string) => d.replace(/-/g, '');

function stamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

export function planToIcal(plan: Plan, opts: IcalOptions = {}): string {
  const teacher = (opts.audience ?? 'teacher') === 'teacher';
  const domain = opts.domain ?? 'wb-curriculum-planner';
  const dtstamp = stamp(opts.now ?? new Date());
  const clean = (s: string) => s.replace(/^\[가상\]\s*/, '');
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//WB//Curriculum Planner//KO',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    // 비표준 X- 속성은 앱에 따라 이스케이프를 풀지 않아 '\,' 가 그대로 보이므로, 캘린더 이름에서는 쉼표·세미콜론을 가운뎃점으로 바꾼다
    `X-WR-CALNAME:${esc(clean(plan.title).replace(/\s*[,;]\s*/g, ' · '))}`,
    'X-WR-TIMEZONE:Asia/Seoul',
  ];
  for (const lesson of [...plan.lessons].sort((a, b) => (a.date < b.date ? -1 : 1))) {
    const active = lesson.status === 'scheduled' || lesson.status === 'makeup';
    if (!active && !opts.includeCancelled) continue;
    const d = dayView(plan, lesson);
    const classItems = d.assignments.filter((a) => a.assignment.activity !== 'homework');
    const hw = d.assignments.filter((a) => a.assignment.activity === 'homework');
    let summary: string;
    let desc: string[];
    if (!active) {
      summary = `${clean(plan.title)} · ${lesson.status === 'holiday' ? '공휴일' : '휴강'}`;
      desc = [lesson.note || ''];
    } else {
      const ranges = classItems.map((a) => `${clean(a.textbookTitle)} ${a.rangeText}`).join(', ');
      summary = `${lesson.status === 'makeup' ? '[보강] ' : ''}${clean(plan.title)}${ranges ? ` · ${ranges}` : ''}`;
      desc = classItems.map((a) => {
        const parts = [`${clean(a.textbookTitle)} ${a.rangeText} — ${a.itemTitle}`, `${a.activityLabel} ${a.assignment.minutes}분`];
        if (a.objective) parts.push(`목표: ${a.objective}`);
        if (a.materials) parts.push(`준비물: ${a.materials}`);
        if (teacher && a.teachingNote) parts.push(`지도 메모: ${a.teachingNote}`);
        return parts.join(' / ');
      });
      if (hw.length) desc.push(`과제: ${hw.map((a) => `${clean(a.textbookTitle)} ${a.rangeText}`).join(', ')}`);
      if (teacher) desc.push(`시간 배분: ${d.timeAllocation.filter((t) => t.minutes > 0).map((t) => `${t.label} ${t.minutes}분`).join(', ')}`);
    }
    desc.push(`계획 v${plan.planVersion} · ${plan.snapshot.curriculumTitle.replace(/^\[가상\]\s*/, '')} v${plan.snapshot.curriculumVersion}`);
    if (plan.isSample) desc.push('가상 샘플 데이터');
    lines.push(
      'BEGIN:VEVENT',
      `UID:${lesson.id}@${domain}`,
      `DTSTAMP:${dtstamp}`,
      `DTSTART;VALUE=DATE:${ymd(lesson.date)}`,
      `DTEND;VALUE=DATE:${ymd(addDays(lesson.date, 1))}`,
      `SUMMARY:${esc(summary)}`,
      `DESCRIPTION:${esc(desc.filter(Boolean).join('\n'))}`,
      `STATUS:${active ? 'CONFIRMED' : 'CANCELLED'}`,
      'TRANSP:TRANSPARENT',
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}
