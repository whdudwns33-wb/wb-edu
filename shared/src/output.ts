/**
 * 출력 양식 열 정의. 엑셀(서버)과 A4 인쇄(웹)가 같은 정의를 사용해
 * 양식별로 선택한 열이 두 출력물에 동일하게 적용된다.
 */
import type { AssignmentView, DayView, QuarterView, WeekView, YearView } from './views.ts';
import { fmtMinutes } from './units.ts';
import type { OutputTemplate } from './types.ts';

export type OutputColumnKey =
  | 'date'
  | 'textbook'
  | 'range'
  | 'pdfRange'
  | 'itemTitle'
  | 'objective'
  | 'activity'
  | 'track'
  | 'minutes'
  | 'homework'
  | 'materials'
  | 'teachingNote'
  | 'checklist'
  | 'timeAllocation'
  | 'record'
  | 'remaining'
  | 'recordNote'
  | 'extra';

export interface OutputColumnDef {
  key: OutputColumnKey;
  label: string;
  /** 강사용 전용(내부 메모·시간 배분 등). 학생·학부모용 양식에서 선택해도 출력하지 않는다. */
  internal?: boolean;
  /** 수업 단위 값(행마다 같은 값) */
  value: (ctx: { day: DayView; view: AssignmentView; extraLabels?: Record<string, string> }) => string;
}

const hwOf = (day: DayView) =>
  day.assignments
    .filter((a) => a.assignment.activity === 'homework')
    .map((a) => `${a.textbookTitle} ${a.rangeText}`)
    .join(', ');

export const OUTPUT_COLUMNS: OutputColumnDef[] = [
  { key: 'date', label: '날짜', value: ({ day }) => day.lesson.date },
  { key: 'textbook', label: '교재', value: ({ view }) => view.textbookTitle },
  { key: 'range', label: '범위', value: ({ view }) => view.rangeText },
  { key: 'pdfRange', label: 'PDF 페이지', internal: true, value: ({ view }) => view.pdfRangeText },
  { key: 'itemTitle', label: '학습항목', value: ({ view }) => view.itemTitle },
  {
    key: 'extra',
    label: '과목별 항목',
    // 지문·독해 기능·개념·유형·어휘 등 교재 학습항목의 과목별 선택 항목. 설정의 과목별 항목 이름으로 표시한다
    value: ({ view, extraLabels }) =>
      Object.entries(view.extra)
        .filter(([, v]) => v)
        .map(([k, v]) => `${extraLabels?.[k] ?? k}: ${v}`)
        .join(' · '),
  },
  { key: 'objective', label: '학습목표', value: ({ view }) => view.objective },
  { key: 'activity', label: '활동', value: ({ view }) => view.activityLabel },
  { key: 'track', label: '트랙', value: ({ view }) => view.trackLabel },
  { key: 'minutes', label: '시간(분)', value: ({ view }) => String(view.assignment.minutes) },
  { key: 'homework', label: '과제', value: ({ day }) => hwOf(day) },
  { key: 'materials', label: '준비물', value: ({ view }) => view.materials },
  { key: 'teachingNote', label: '지도 메모', internal: true, value: ({ view }) => view.teachingNote },
  { key: 'checklist', label: '점검 사항', internal: true, value: ({ day }) => day.lesson.checklist },
  {
    key: 'timeAllocation',
    label: '시간 배분',
    internal: true,
    value: ({ day }) => day.timeAllocation.filter((t) => t.minutes > 0).map((t) => `${t.label} ${t.minutes}분`).join(', '),
  },
  { key: 'record', label: '실제 완료', value: ({ view }) => (view.record ? view.recordLabel : '') },
  { key: 'remaining', label: '남은 범위', value: ({ view }) => view.remainingText },
  { key: 'recordNote', label: '기록 메모', internal: true, value: ({ view }) => view.record?.note ?? '' },
];

export const OUTPUT_COLUMN_LABEL: Record<OutputColumnKey, string> = Object.fromEntries(OUTPUT_COLUMNS.map((c) => [c.key, c.label])) as Record<OutputColumnKey, string>;

export const DEFAULT_TEACHER_COLUMNS: OutputColumnKey[] = ['date', 'textbook', 'range', 'pdfRange', 'itemTitle', 'extra', 'objective', 'activity', 'track', 'minutes', 'homework', 'materials', 'checklist', 'teachingNote', 'timeAllocation', 'record', 'remaining'];
export const DEFAULT_STUDENT_COLUMNS: OutputColumnKey[] = ['date', 'textbook', 'range', 'objective', 'activity', 'minutes', 'homework', 'record', 'remaining'];

/** 양식의 열 목록을 유효한 정의로 바꾼다. 학생용은 internal 열을 제거한다. */
export function resolveColumns(template: Pick<OutputTemplate, 'audience' | 'columns'> | null | undefined, audience: 'teacher' | 'student'): OutputColumnDef[] {
  const keys = template?.columns?.length ? template.columns : audience === 'teacher' ? DEFAULT_TEACHER_COLUMNS : DEFAULT_STUDENT_COLUMNS;
  const byKey = new Map(OUTPUT_COLUMNS.map((c) => [c.key, c]));
  const out: OutputColumnDef[] = [];
  for (const k of keys) {
    const def = byKey.get(k as OutputColumnKey);
    if (!def) continue;
    if (audience === 'student' && def.internal) continue;
    if (!out.includes(def)) out.push(def);
  }
  return out.length ? out : resolveColumns(null, audience);
}

/** 수업 하나를 선택한 열로 행들로 펼친다 (숙제 활동은 '과제' 열로 묶이므로 행에서 제외). 배정이 없으면 한 행. */
export function dayRows(day: DayView, columns: OutputColumnDef[], extraLabels?: Record<string, string>): string[][] {
  const views = day.assignments.filter((a) => a.assignment.activity !== 'homework');
  if (views.length === 0) {
    const label = day.lesson.status === 'holiday' ? `(공휴일) ${day.lesson.note}` : day.lesson.status === 'cancelled' ? `(휴강) ${day.lesson.note}` : '(배정 없음)';
    return [columns.map((c) => (c.key === 'date' ? day.lesson.date : c.key === 'textbook' || c.key === 'itemTitle' ? label : c.key === 'homework' ? hwOf(day) : ''))];
  }
  return views.map((view) => columns.map((c) => c.value({ day, view, extraLabels })));
}

/** 운영 설정의 과목별 항목 정의로 key → 이름 지도를 만든다 (같은 key 는 먼저 나온 이름) */
export function extraLabelMap(subjectFields: Array<{ fields: Array<{ key: string; label: string }> }> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const sf of subjectFields ?? []) for (const f of sf.fields) if (!(f.key in out)) out[f.key] = f.label;
  return out;
}

// ──────────────────────────────────────────────
// 연간·분기·월간 표 열 (월간 표의 한 행은 그 달의 한 주)
// ──────────────────────────────────────────────

export type SummaryLevel = 'year' | 'quarter' | 'month';

export interface SummaryColumnDef<Row> {
  key: string;
  label: string;
  /** 강사용 전용 (학생·학부모용 양식에서는 고르더라도 출력하지 않음) */
  internal?: boolean;
  value: (row: Row, ctx: SummaryCtx) => string;
}

export interface SummaryCtx {
  /** 표시용 정리 ('[가상]' 머리표 제거 등) */
  clean: (s: string) => string;
  /** 회당 복습 분 (복습·평가 시점이 없을 때 안내용) */
  reviewMinutes: number;
}

const offMakeup = (s: { cancelledCount: number; holidayCount: number; makeupCount: number }) =>
  [s.cancelledCount + s.holidayCount ? `휴강 ${s.cancelledCount + s.holidayCount}` : '', s.makeupCount ? `보강 ${s.makeupCount}` : ''].filter(Boolean).join(' ');
const tracks = (s: { byTrack: Record<'current' | 'review' | 'advance', number> }) => `현행 ${s.byTrack.current} · 복습보충 ${s.byTrack.review} · 선행 ${s.byTrack.advance}분`;

export const YEAR_COLUMNS: SummaryColumnDef<YearView>[] = [
  { key: 'label', label: '학년도', value: (y) => `${y.academicYear}학년도` },
  { key: 'period', label: '기간', value: (y) => `${y.from} ~ ${y.to}` },
  { key: 'lessons', label: '수업 횟수', value: (y) => `${y.summary.lessonCount}회` },
  { key: 'totalMinutes', label: '총 수업시간', internal: true, value: (y) => fmtMinutes(y.summary.totalMinutes) },
  { key: 'assigned', label: '새 진도', value: (y) => fmtMinutes(y.summary.assignedMinutes) },
  { key: 'tracks', label: '트랙별 시간', internal: true, value: (y) => tracks(y.summary) },
  { key: 'flow', label: '교재 흐름', value: (y, c) => y.textbookFlow.map((f) => `${c.clean(f.title)} ${f.firstDate}~${f.lastDate}`).join(' → ') },
  { key: 'targets', label: '현행·복습·선행 도달 목표', value: (y) => y.trackTargets.filter((t) => t.minutes > 0).map((t) => `${t.label} ${t.itemCount}항목 ${fmtMinutes(t.minutes)}`).join(', ') },
];

export const QUARTER_COLUMNS: SummaryColumnDef<QuarterView>[] = [
  { key: 'label', label: '분기 (학년도 기준)', value: (q) => q.label },
  { key: 'period', label: '기간', value: (q) => `${q.from} ~ ${q.to}` },
  { key: 'lessons', label: '수업', value: (q) => `${q.summary.lessonCount}회` },
  { key: 'offMakeup', label: '휴강·보강', value: (q) => offMakeup(q.summary) },
  { key: 'assigned', label: '새 진도', value: (q) => fmtMinutes(q.summary.assignedMinutes) },
  { key: 'tracks', label: '트랙별 시간', internal: true, value: (q) => tracks(q.summary) },
  { key: 'textbooks', label: '교재별 배치', value: (q, c) => q.summary.textbooks.map((t) => `${c.clean(t.title)}: ${t.rangeText}`).join(' / ') },
  { key: 'reviewAssess', label: '복습·평가 시점', value: (q, c) => [...q.summary.reviewDates.map((d) => `복습 ${d}`), ...q.summary.assessmentDates.map((d) => `평가 ${d}`)].join(', ') || `회당 복습 ${c.reviewMinutes}분` },
  { key: 'transitions', label: '단계·교재 전환', value: (q, c) => q.transitions.map(c.clean).join(', ') },
];

export const MONTH_COLUMNS: SummaryColumnDef<WeekView>[] = [
  { key: 'week', label: '주', value: (w) => w.label },
  { key: 'days', label: '실제 수업일', value: (w) => w.days.filter((d) => d.lesson.status === 'scheduled' || d.lesson.status === 'makeup').map((d) => d.lesson.date.slice(5)).join(', ') },
  { key: 'lessons', label: '수업 횟수', value: (w) => `${w.summary.lessonCount}회` },
  { key: 'available', label: '가능 분량', internal: true, value: (w) => fmtMinutes(w.summary.availableMinutes) },
  { key: 'assigned', label: '배정 분량', value: (w) => fmtMinutes(w.summary.assignedMinutes) },
  { key: 'offMakeup', label: '휴강·보강', value: (w) => [...w.days.filter((d) => d.lesson.status === 'cancelled' || d.lesson.status === 'holiday').map((d) => `${d.lesson.date.slice(5)} ${d.lesson.note}`), w.summary.makeupCount ? `보강 ${w.summary.makeupCount}` : ''].filter(Boolean).join(', ') },
  { key: 'tracks', label: '트랙별 시간', internal: true, value: (w) => tracks(w.summary) },
  { key: 'textbooks', label: '주별 진도 (교재별 범위)', value: (w, c) => w.summary.textbooks.map((t) => `${c.clean(t.title)}: ${t.rangeText}`).join(' / ') },
];

const SUMMARY_DEFS = { year: YEAR_COLUMNS, quarter: QUARTER_COLUMNS, month: MONTH_COLUMNS } as const;

export const DEFAULT_SUMMARY_COLUMNS: Record<'teacher' | 'student', Record<SummaryLevel, string[]>> = {
  teacher: {
    year: ['label', 'period', 'lessons', 'totalMinutes', 'assigned', 'tracks', 'flow', 'targets'],
    quarter: ['label', 'period', 'lessons', 'offMakeup', 'assigned', 'textbooks', 'reviewAssess', 'transitions'],
    month: ['week', 'days', 'lessons', 'available', 'assigned', 'offMakeup', 'tracks', 'textbooks'],
  },
  student: {
    year: ['label', 'period', 'lessons', 'flow', 'targets'],
    quarter: ['label', 'period', 'lessons', 'offMakeup', 'textbooks', 'reviewAssess'],
    month: ['week', 'days', 'offMakeup', 'textbooks'],
  },
};

export function summaryColumnKeys(level: SummaryLevel): string[] {
  return SUMMARY_DEFS[level].map((c) => c.key);
}

/** 연간·분기·월간 표의 열. 양식에 없으면 대상별 기본, 학생용은 내부 열 제외 */
export function resolveSummaryColumns<L extends SummaryLevel>(
  template: Pick<OutputTemplate, 'summaryColumns'> | null | undefined,
  audience: 'teacher' | 'student',
  level: L,
): (typeof SUMMARY_DEFS)[L][number][] {
  const defs = SUMMARY_DEFS[level] as readonly SummaryColumnDef<never>[];
  const chosen = template?.summaryColumns?.[level];
  const keys = chosen && chosen.length ? chosen : DEFAULT_SUMMARY_COLUMNS[audience][level];
  const byKey = new Map(defs.map((d) => [d.key, d]));
  const out: SummaryColumnDef<never>[] = [];
  for (const k of keys) {
    const d = byKey.get(k);
    if (!d || out.includes(d)) continue;
    if (audience === 'student' && d.internal) continue;
    out.push(d);
  }
  const result = out.length ? out : DEFAULT_SUMMARY_COLUMNS[audience][level].map((k) => byKey.get(k)!).filter(Boolean);
  return result as unknown as (typeof SUMMARY_DEFS)[L][number][];
}

/** 정의되지 않은 열 키를 걸러 저장용으로 정리 */
export function cleanSummaryColumns(raw: unknown): OutputTemplate['summaryColumns'] {
  if (!raw || typeof raw !== 'object') return undefined;
  const out: NonNullable<OutputTemplate['summaryColumns']> = {};
  for (const level of ['year', 'quarter', 'month'] as SummaryLevel[]) {
    const v = (raw as Record<string, unknown>)[level];
    if (!Array.isArray(v)) continue;
    const valid = new Set(summaryColumnKeys(level));
    out[level] = v.filter((k, i) => typeof k === 'string' && valid.has(k) && v.indexOf(k) === i) as string[];
  }
  return out;
}
