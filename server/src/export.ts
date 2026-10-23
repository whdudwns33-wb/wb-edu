/**
 * 엑셀 출력 (exceljs). 화면과 같은 집계 함수(buildPlanViews)를 사용해
 * 화면·출력물의 범위·시간·버전이 일치하도록 한다.
 */
import ExcelJS from 'exceljs';
import type { OutputTemplate, Plan } from '@wb/shared';
import { buildPlanViews, dayRows, fmtMinutes, isISODate, resolveColumns, resolveSummaryColumns, type DayView } from '@wb/shared';

export type Audience = 'teacher' | 'student';
export type Level = 'year' | 'halfyear' | 'quarter' | 'month' | 'week' | 'day';

export interface ExportOptions {
  audience: Audience;
  levels: Level[];
  from?: string;
  to?: string;
  /** 출력 양식 (열 선택). 없으면 대상별 기본 열 */
  template?: OutputTemplate | null;
  /** 과목별 항목 key → 이름 */
  extraLabels?: Record<string, string>;
}

export async function buildWorkbook(plan: Plan, opts: ExportOptions): Promise<Buffer> {
  // 날짜 범위는 화면(/views)과 같은 기준으로 확인한다: 형식이 틀리거나 뒤집혔으면 전체 계획
  const range = opts.from && opts.to && isISODate(opts.from) && isISODate(opts.to) && opts.from <= opts.to ? { from: opts.from, to: opts.to } : undefined;
  const views = buildPlanViews(plan, range);
  const h = views.header;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'WB 커리큘럼 플래너';
  const teacher = opts.audience === 'teacher';
  const columns = resolveColumns(opts.template, opts.audience);

  // 표지
  const cover = wb.addWorksheet('표지');
  cover.columns = [{ width: 18 }, { width: 70 }];
  const rows: Array<[string, string]> = [
    ['과정명', h.title],
    ['대상', teacher ? h.target : h.target],
    ['과목', h.subject],
    ['기간', h.period],
    ['사용 교재', h.textbooks.join(' / ')],
    ['계획 버전', `v${h.planVersion} (과정 ${h.curriculumTitle} v${h.curriculumVersion})`],
    ['상태', h.status],
    ['집계 기준', '등록된 학습 범위만 집계합니다. 배정이 없는 구간은 학습 내용·목표 미확정입니다. 반년은 학년도 시작월부터 6개월씩 구분합니다.'],
    ['편성 방식', h.mode],
    ['총분량(수업시간)', fmtMinutes(h.totalMinutes)],
    ...(range ? ([['출력 범위', `${range.from} ~ ${range.to} (이 범위 수업 ${views.summary.lessonCount}회, 배정 ${fmtMinutes(views.summary.assignedMinutes)})`]] as Array<[string, string]>) : []),
    ['미배정 범위', h.unassignedCount ? `${h.unassignedCount}건 (${fmtMinutes(h.unassignedMinutes)})` : '없음'],
    ['출력 대상', teacher ? '강사용 (지도 메모·시간 배분 포함)' : '학생·학부모용 (학습목표·범위·과제 중심)'],
    ['출력 양식', opts.template ? `${opts.template.name} (${columns.map((c) => c.label).join(', ')})` : `기본 (${columns.map((c) => c.label).join(', ')})`],
    ['완료율 기준', views.completionBasis],
  ];
  // 변경 사항(이력 문구)에는 지도 메모·상담 내용이 들어갈 수 있어 강사용에만 넣는다 (인쇄 보기와 같음)
  if (teacher) rows.push(['변경 사항', h.lastChange], ['작성자', h.author], ['검토자', h.reviewer]);
  if (plan.isSample) rows.push(['주의', '가상 샘플 데이터입니다.']);
  for (const r of rows) cover.addRow(r);
  cover.getColumn(1).font = { bold: true };

  // 연간·분기·월간 시트도 출력 양식의 열 선택을 따른다 (인쇄 보기와 같은 정의: shared/output.ts)
  const sctx = { clean: (s: string) => s, reviewMinutes: plan.settings.reviewMinutes };
  if (opts.levels.includes('year')) {
    const ws = wb.addWorksheet('연간');
    const cols = resolveSummaryColumns(opts.template, opts.audience, 'year');
    ws.addRow(cols.map((c) => c.label)).font = { bold: true };
    for (const y of views.years) ws.addRow(cols.map((c) => c.value(y, sctx)));
    ws.addRow([]);
    ws.addRow(['교육 목표', plan.snapshot.curriculumTitle]);
    autoWidth(ws);
  }

  if (opts.levels.includes('halfyear')) {
    const ws = wb.addWorksheet('반년');
    const cols = resolveSummaryColumns(opts.template, opts.audience, 'halfyear');
    ws.addRow(cols.map(c => c.label)).font = { bold: true };
    for (const half of views.halfYears) ws.addRow(cols.map(c => c.value(half, sctx)));
    autoWidth(ws);
  }

  if (opts.levels.includes('quarter')) {
    const ws = wb.addWorksheet('분기');
    const cols = resolveSummaryColumns(opts.template, opts.audience, 'quarter');
    ws.addRow(cols.map((c) => c.label)).font = { bold: true };
    for (const y of views.years) for (const q of y.quarters) ws.addRow(cols.map((c) => c.value(q, sctx)));
    autoWidth(ws);
  }

  if (opts.levels.includes('month')) {
    const ws = wb.addWorksheet('월간');
    const cols = resolveSummaryColumns(opts.template, opts.audience, 'month');
    ws.addRow(['월', ...cols.map((c) => c.label)]).font = { bold: true };
    for (const y of views.years) for (const q of y.quarters) for (const m of q.months) {
      for (const w of m.weeks) ws.addRow([m.label, ...cols.map((c) => c.value(w, sctx))]);
      const total: Record<string, string> = { lessons: `${m.summary.lessonCount}회`, available: fmtMinutes(m.summary.availableMinutes), assigned: fmtMinutes(m.summary.assignedMinutes) };
      ws.addRow([`${m.label} 합계`, ...cols.map((c) => total[c.key] ?? '')]).font = { bold: true };
    }
    autoWidth(ws);
  }

  // 시간(분) 열은 숫자 칸으로 써서 엑셀에서 합계를 낼 수 있게 한다
  const minutesCol = columns.findIndex((c) => c.key === 'minutes');
  const numeric = (row: string[]): Array<string | number> => row.map((v, i) => (i === minutesCol && /^\d+$/.test(v) ? Number(v) : v));

  // 주간·일간 시트는 출력 양식의 열 선택을 그대로 쓴다 (인쇄 보기와 같은 정의: shared/output.ts)
  if (opts.levels.includes('week')) {
    const ws = wb.addWorksheet('주간');
    ws.addRow(['주', ...columns.map((c) => c.label)]).font = { bold: true };
    for (const y of views.years) for (const q of y.quarters) for (const m of q.months) for (const w of m.weeks) {
      for (const d of w.days) for (const row of dayRows(d, columns, opts.extraLabels)) ws.addRow([w.label, ...numeric(row)]);
    }
    autoWidth(ws);
  }

  if (opts.levels.includes('day')) {
    const ws = wb.addWorksheet('일간');
    ws.addRow(columns.map((c) => c.label)).font = { bold: true };
    // 일간 시트는 인쇄 보기의 일간과 같이 실제 수업(예정·보강)만 싣는다. 휴강·공휴일은 주간 시트에 표시된다
    const days: DayView[] = views.years.flatMap((y) => y.quarters).flatMap((q) => q.months).flatMap((m) => m.weeks).flatMap((w) => w.days).filter((d) => d.lesson.status === 'scheduled' || d.lesson.status === 'makeup');
    for (const d of days) for (const row of dayRows(d, columns, opts.extraLabels)) ws.addRow(numeric(row));
    autoWidth(ws);
  }

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf as ArrayBuffer);
}

function autoWidth(ws: ExcelJS.Worksheet) {
  ws.columns.forEach((col) => {
    let max = 8;
    col.eachCell?.({ includeEmpty: false }, (cell) => {
      const len = String(cell.value ?? '').length;
      if (len > max) max = Math.min(60, len + 2);
    });
    col.width = max;
  });
}
