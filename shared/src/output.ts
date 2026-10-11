/**
 * 출력 양식 열 정의. 엑셀(서버)과 A4 인쇄(웹)가 같은 정의를 사용해
 * 양식별로 선택한 열이 두 출력물에 동일하게 적용된다.
 */
import type { AssignmentView, DayView } from './views.ts';
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
  | 'recordNote';

export interface OutputColumnDef {
  key: OutputColumnKey;
  label: string;
  /** 강사용 전용(내부 메모·시간 배분 등). 학생·학부모용 양식에서 선택해도 출력하지 않는다. */
  internal?: boolean;
  /** 수업 단위 값(행마다 같은 값) */
  value: (ctx: { day: DayView; view: AssignmentView }) => string;
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

export const DEFAULT_TEACHER_COLUMNS: OutputColumnKey[] = ['date', 'textbook', 'range', 'pdfRange', 'itemTitle', 'objective', 'activity', 'track', 'minutes', 'homework', 'materials', 'checklist', 'teachingNote', 'timeAllocation', 'record', 'remaining'];
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
export function dayRows(day: DayView, columns: OutputColumnDef[]): string[][] {
  const views = day.assignments.filter((a) => a.assignment.activity !== 'homework');
  if (views.length === 0) {
    const label = day.lesson.status === 'holiday' ? `(공휴일) ${day.lesson.note}` : day.lesson.status === 'cancelled' ? `(휴강) ${day.lesson.note}` : '(배정 없음)';
    return [columns.map((c) => (c.key === 'date' ? day.lesson.date : c.key === 'textbook' || c.key === 'itemTitle' ? label : c.key === 'homework' ? hwOf(day) : ''))];
  }
  return views.map((view) => columns.map((c) => c.value({ day, view })));
}
