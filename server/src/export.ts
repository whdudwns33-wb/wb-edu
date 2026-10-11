/**
 * 엑셀 출력 (exceljs). 화면과 같은 집계 함수(buildPlanViews)를 사용해
 * 화면·출력물의 범위·시간·버전이 일치하도록 한다.
 */
import ExcelJS from 'exceljs';
import type { OutputTemplate, Plan } from '@wb/shared';
import { buildPlanViews, dayRows, fmtMinutes, resolveColumns, type DayView } from '@wb/shared';

export type Audience = 'teacher' | 'student';
export type Level = 'year' | 'quarter' | 'month' | 'week' | 'day';

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
  const views = buildPlanViews(plan, opts.from && opts.to ? { from: opts.from, to: opts.to } : undefined);
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
    ['편성 방식', h.mode],
    ['총분량(수업시간)', fmtMinutes(h.totalMinutes)],
    ['미배정 범위', h.unassignedCount ? `${h.unassignedCount}건 (${fmtMinutes(h.unassignedMinutes)})` : '없음'],
    ['변경 사항', h.lastChange],
    ['출력 대상', teacher ? '강사용 (지도 메모·시간 배분 포함)' : '학생·학부모용 (학습목표·범위·과제 중심)'],
    ['출력 양식', opts.template ? `${opts.template.name} (${columns.map((c) => c.label).join(', ')})` : `기본 (${columns.map((c) => c.label).join(', ')})`],
    ['완료율 기준', views.completionBasis],
  ];
  if (teacher) rows.push(['작성자', h.author], ['검토자', h.reviewer]);
  if (plan.isSample) rows.push(['주의', '가상 샘플 데이터입니다.']);
  for (const r of rows) cover.addRow(r);
  cover.getColumn(1).font = { bold: true };

  if (opts.levels.includes('year')) {
    const ws = wb.addWorksheet('연간');
    ws.addRow(['학년도', '기간', '수업 횟수', '총 수업시간', '새 진도 배정', '현행', '복습·보충', '선행', '교재 흐름']).font = { bold: true };
    for (const y of views.years) {
      ws.addRow([
        y.label,
        `${y.from} ~ ${y.to}`,
        y.summary.lessonCount,
        fmtMinutes(y.summary.totalMinutes),
        fmtMinutes(y.summary.assignedMinutes),
        fmtMinutes(y.summary.byTrack.current),
        fmtMinutes(y.summary.byTrack.review),
        fmtMinutes(y.summary.byTrack.advance),
        y.textbookFlow.map((f) => `${f.title} ${f.firstDate}~${f.lastDate}`).join(' → '),
      ]);
    }
    ws.addRow([]);
    ws.addRow(['교육 목표', plan.snapshot.curriculumTitle]);
    ws.addRow(['도달 목표(트랙)', ...views.years.flatMap((y) => y.trackTargets.map((t) => `${t.label} ${t.itemCount}항목 ${fmtMinutes(t.minutes)}`))]);
    autoWidth(ws);
  }

  if (opts.levels.includes('quarter')) {
    const ws = wb.addWorksheet('분기');
    ws.addRow(['분기(학년도 기준)', '기간', '수업', '휴강', '보강', '새 진도', '교재별 범위', '복습·평가 시점', '단계·교재 전환']).font = { bold: true };
    for (const y of views.years) {
      for (const q of y.quarters) {
        ws.addRow([
          q.label,
          `${q.from} ~ ${q.to}`,
          q.summary.lessonCount,
          q.summary.cancelledCount + q.summary.holidayCount,
          q.summary.makeupCount,
          fmtMinutes(q.summary.assignedMinutes),
          q.summary.textbooks.map((t) => `${t.title}: ${t.rangeText}`).join(' / '),
          [...q.summary.reviewDates.map((d) => `복습 ${d}`), ...q.summary.assessmentDates.map((d) => `평가 ${d}`)].join(', '),
          q.transitions.join(', '),
        ]);
      }
    }
    autoWidth(ws);
  }

  if (opts.levels.includes('month')) {
    const ws = wb.addWorksheet('월간');
    ws.addRow(['월', '주', '수업일', '수업 횟수', '가능 분량', '배정 분량', '휴강·보강', '현행', '복습·보충', '선행', '교재별 범위']).font = { bold: true };
    for (const y of views.years) for (const q of y.quarters) for (const m of q.months) {
      for (const w of m.weeks) {
        ws.addRow([
          m.label,
          w.label,
          w.days.map((d) => d.lesson.date.slice(5)).join(', '),
          w.summary.lessonCount,
          fmtMinutes(w.summary.availableMinutes),
          fmtMinutes(w.summary.assignedMinutes),
          [w.summary.cancelledCount + w.summary.holidayCount ? `휴강 ${w.summary.cancelledCount + w.summary.holidayCount}` : '', w.summary.makeupCount ? `보강 ${w.summary.makeupCount}` : ''].filter(Boolean).join(' '),
          fmtMinutes(w.summary.byTrack.current),
          fmtMinutes(w.summary.byTrack.review),
          fmtMinutes(w.summary.byTrack.advance),
          w.summary.textbooks.map((t) => `${t.title}: ${t.rangeText}`).join(' / '),
        ]);
      }
      ws.addRow([`${m.label} 합계`, '', '', m.summary.lessonCount, fmtMinutes(m.summary.availableMinutes), fmtMinutes(m.summary.assignedMinutes)]).font = { bold: true };
    }
    autoWidth(ws);
  }

  // 주간·일간 시트는 출력 양식의 열 선택을 그대로 쓴다 (인쇄 보기와 같은 정의: shared/output.ts)
  if (opts.levels.includes('week')) {
    const ws = wb.addWorksheet('주간');
    ws.addRow(['주', ...columns.map((c) => c.label)]).font = { bold: true };
    for (const y of views.years) for (const q of y.quarters) for (const m of q.months) for (const w of m.weeks) {
      for (const d of w.days) for (const row of dayRows(d, columns, opts.extraLabels)) ws.addRow([w.label, ...row]);
    }
    autoWidth(ws);
  }

  if (opts.levels.includes('day')) {
    const ws = wb.addWorksheet('일간');
    ws.addRow(columns.map((c) => c.label)).font = { bold: true };
    const days: DayView[] = views.years.flatMap((y) => y.quarters).flatMap((q) => q.months).flatMap((m) => m.weeks).flatMap((w) => w.days);
    for (const d of days) for (const row of dayRows(d, columns, opts.extraLabels)) ws.addRow(row);
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
