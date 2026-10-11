import { describe, expect, it } from 'vitest';
import { baseSettings, makePlan, sampleWorld, BY } from './helpers.ts';
import { SAMPLE_IDS } from '../src/sample.ts';
import { dayView } from '../src/views.ts';
import { DEFAULT_STUDENT_COLUMNS, DEFAULT_TEACHER_COLUMNS, OUTPUT_COLUMNS, dayRows, resolveColumns } from '../src/output.ts';

describe('출력 양식 열 선택', () => {
  it('양식의 열 순서를 따르고 정의되지 않은 키는 무시한다', () => {
    const cols = resolveColumns({ audience: 'teacher', columns: ['range', 'date', 'nope', 'teachingNote', 'range'] }, 'teacher');
    expect(cols.map((c) => c.key)).toEqual(['range', 'date', 'teachingNote']);
  });

  it('학생·학부모용은 내부 열(지도 메모·시간 배분·PDF 페이지 등)을 선택해도 출력하지 않는다', () => {
    const cols = resolveColumns({ audience: 'student', columns: ['date', 'teachingNote', 'timeAllocation', 'pdfRange', 'objective', 'checklist', 'recordNote'] }, 'student');
    expect(cols.map((c) => c.key)).toEqual(['date', 'objective']);
    expect(OUTPUT_COLUMNS.filter((c) => c.internal).map((c) => c.key).sort()).toEqual(['checklist', 'pdfRange', 'recordNote', 'teachingNote', 'timeAllocation'].sort());
  });

  it('열이 비어 있거나 양식이 없으면 대상별 기본 열을 쓴다', () => {
    expect(resolveColumns(null, 'teacher').map((c) => c.key)).toEqual(DEFAULT_TEACHER_COLUMNS);
    expect(resolveColumns({ audience: 'student', columns: [] }, 'student').map((c) => c.key)).toEqual(DEFAULT_STUDENT_COLUMNS);
    // 전부 내부 열만 고른 학생용 양식 → 기본 열로 대체
    expect(resolveColumns({ audience: 'student', columns: ['teachingNote'] }, 'student').map((c) => c.key)).toEqual(DEFAULT_STUDENT_COLUMNS);
  });

  it('수업 행 펼치기: 숙제는 과제 열로 묶이고, 배정 없는 수업은 한 행', () => {
    const { curricula, tbs } = sampleWorld();
    const basic = structuredClone(curricula.find((c) => c.id === SAMPLE_IDS.curriculumBasic)!);
    basic.sessions[0].entries.push({ id: 'hw', textbookId: SAMPLE_IDS.marketTextbook, itemId: `${SAMPLE_IDS.marketTextbook}-i1`, track: 'current', activity: 'homework', minutes: 20 });
    const { plan } = makePlan(basic, tbs, baseSettings(), ['2026-04-09']);
    const cols = resolveColumns({ audience: 'teacher', columns: ['date', 'textbook', 'range', 'homework', 'pdfRange', 'record', 'remaining'] }, 'teacher');
    const d0 = dayView(plan, plan.lessons[0]);
    const rows = dayRows(d0, cols);
    expect(rows.length).toBe(d0.assignments.filter((a) => a.assignment.activity !== 'homework').length);
    expect(rows[0][0]).toBe('2026-04-06');
    expect(rows[0][2]).toBe('12~23쪽');
    expect(rows[0][3]).toContain('12~23쪽'); // 숙제가 과제 열에
    expect(rows[0][4]).toBe('PDF 14~25p');
    expect(rows[0][5]).toBe('');
    // 공휴일 수업은 한 행, 교재 열에 사유
    const holiday = plan.lessons.find((l) => l.date === '2026-04-09')!;
    const hrows = dayRows(dayView(plan, holiday), cols);
    expect(hrows).toHaveLength(1);
    expect(hrows[0][1]).toContain('공휴일');
    // 부분 완료 기록 → 실제 완료·남은 범위 열
    const a0 = d0.assignments[0].assignment;
    plan.records.push({ id: 'r1', assignmentId: a0.id, lessonId: a0.lessonId, date: '2026-04-06', status: 'partial', completedPortion: { from: 12, to: 17 }, reason: '', note: '', recordedAt: '2026-04-06T10:00:00Z', recordedBy: BY });
    const rows2 = dayRows(dayView(plan, plan.lessons[0]), cols);
    expect(rows2[0][5]).toBe('부분 완료');
    expect(rows2[0][6]).toBe('18~23쪽');
  });
});

describe('연간·분기·월간 표 열 선택', () => {
  it('양식이 없으면 대상별 기본 열, 학생용은 내부 열(트랙별·가능 분량·총 수업시간) 제외', async () => {
    const { resolveSummaryColumns, DEFAULT_SUMMARY_COLUMNS, cleanSummaryColumns } = await import('../src/output.ts');
    expect(resolveSummaryColumns(null, 'teacher', 'month').map((c) => c.key)).toEqual(DEFAULT_SUMMARY_COLUMNS.teacher.month);
    const student = resolveSummaryColumns({ summaryColumns: { month: ['week', 'tracks', 'available', 'textbooks'] } }, 'student', 'month').map((c) => c.key);
    expect(student).toEqual(['week', 'textbooks']);
    expect(resolveSummaryColumns({ summaryColumns: { year: ['flow', 'label'] } }, 'teacher', 'year').map((c) => c.key)).toEqual(['flow', 'label']);
    expect(cleanSummaryColumns({ year: ['label', 'nope', 'label'], quarter: 'x', month: ['week'] })).toEqual({ year: ['label'], month: ['week'] });
  });

  it('월간 열 값이 같은 원본 집계와 일치한다', async () => {
    const { resolveSummaryColumns } = await import('../src/output.ts');
    const { buildPlanViews } = await import('../src/views.ts');
    const w = sampleWorld();
    const basic = w.curricula.find((c) => c.id === SAMPLE_IDS.curriculumBasic)!;
    const { plan } = makePlan(basic, w.tbs, baseSettings({ startDate: '2026-03-30' }), ['2026-04-09']);
    const v = buildPlanViews(plan);
    const month = v.years[0].quarters[0].months.find((m) => m.key === '2026-04')!;
    const cols = resolveSummaryColumns(null, 'teacher', 'month');
    const row = Object.fromEntries(cols.map((c) => [c.key, c.value(month.weeks[1], { clean: (s) => s, reviewMinutes: 10 })]));
    expect(row.days).toBe('04-06');
    expect(row.offMakeup).toContain('04-09 공휴일');
    expect(row.lessons).toBe('1회');
  });
});
