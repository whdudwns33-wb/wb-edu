/**
 * 3차 독립 리뷰(출력·집계·가져오기)에서 재현된 결함의 회귀 테스트.
 */
import { describe, expect, it } from 'vitest';
import { BY, baseSettings, makePlan, sampleWorld } from './helpers.ts';
import { SAMPLE_IDS } from '../src/sample.ts';
import { buildPlanViews } from '../src/views.ts';
import { previewImport, parseTable } from '../src/importer.ts';
import { timingSuggestions } from '../src/timing.ts';
import type { ProgressRecord } from '../src/types.ts';

const I = (n: number) => `${SAMPLE_IDS.marketTextbook}-i${n}`;

describe('3차 리뷰: 집계 보기', () => {
  it('교재별 범위는 새 학습과 복습 활동을 섞지 않고, 끊긴 범위를 처음~끝으로 합치지 않는다', () => {
    const w = sampleWorld();
    const basic = structuredClone(w.curricula.find((c) => c.id === SAMPLE_IDS.curriculumBasic)!);
    basic.sessions[2].entries.push({ id: 'rv', textbookId: SAMPLE_IDS.marketTextbook, itemId: I(1), track: 'review', activity: 'review', minutes: 10 });
    const { plan } = makePlan(basic, w.tbs, baseSettings({ minutesPerLesson: 70 }), ['2026-04-09']);
    const v = buildPlanViews(plan);
    const weeks = v.years[0].quarters[0].months[0].weeks;
    const reviewWeek = weeks.find((wk) => wk.summary.byActivity.review > 0)!;
    const text = reviewWeek.summary.textbooks.map((t) => t.rangeText).join(' / ');
    // 복습 활동의 12~23쪽이 새 학습 범위에 섞이지 않고 따로 표시된다
    expect(text).toContain('복습 12~23쪽');
    expect(text).not.toMatch(/^12~/);
    // 시간 배분에서 '새 학습'은 새 학습 활동만, 복습 활동은 따로
    const day = weeks.flatMap((x) => x.days).find((d) => d.assignments.some((a) => a.assignment.activity === 'review'))!;
    const alloc = Object.fromEntries(day.timeAllocation.map((t) => [t.label, t.minutes]));
    expect(alloc['복습·연습·평가 활동']).toBe(10);
    expect(alloc['새 학습']).toBe(day.assignments.filter((a) => a.assignment.activity === 'new').reduce((s, a) => s + a.assignment.minutes, 0));
  });

  it('다른 단위(쪽·문항)는 한 범위로 합치지 않는다', () => {
    const w = sampleWorld();
    const i2 = w.market.items.find((x) => x.id === I(2))!;
    i2.progressUnit = 'problem';
    i2.range = { from: 1, to: 20 };
    const basic = w.curricula.find((c) => c.id === SAMPLE_IDS.curriculumBasic)!;
    for (const s of basic.sessions) for (const e of s.entries) if (e.itemId === I(2)) e.portion = undefined;
    const { plan } = makePlan(basic, w.tbs, baseSettings());
    const wk = buildPlanViews(plan).years[0].quarters[0].months[0].weeks[0];
    const texts = wk.summary.textbooks.map((t) => t.rangeText);
    expect(texts.some((t) => t.includes('쪽'))).toBe(true);
    expect(texts.some((t) => t.includes('문항'))).toBe(true);
    expect(texts.join(' ')).not.toMatch(/\d+~23문항/);
  });

  it('실제 소요시간 제안은 배정마다 표본 하나만, 완료를 취소한 기록은 빼고 센다', () => {
    const w = sampleWorld();
    const basic = w.curricula.find((c) => c.id === SAMPLE_IDS.curriculumBasic)!;
    const { plan } = makePlan(basic, w.tbs, baseSettings());
    const a = plan.assignments.find((x) => x.itemId === I(1))!;
    const rec = (status: ProgressRecord['status'], actualMinutes: number | undefined, at: string): ProgressRecord => ({ id: at, assignmentId: a.id, lessonId: a.lessonId, date: '2026-04-06', status, actualMinutes, reason: '', note: '', recordedAt: at, recordedBy: BY });
    plan.records.push(rec('done', 90, '2026-04-06T10:00:00Z'), rec('done', 45, '2026-04-06T11:00:00Z'), rec('done', 60, '2026-04-06T12:00:00Z'));
    let s = timingSuggestions(w.market.id, w.market.items, [plan]).find((x) => x.itemId === I(1))!;
    expect(s.samples).toHaveLength(1);
    expect(s.samples[0].actualMinutes).toBe(60);
    expect(s.suggestedMinutes).toBeNull();
    plan.records.push(rec('not_done', undefined, '2026-04-06T13:00:00Z'));
    s = timingSuggestions(w.market.id, w.market.items, [plan]).find((x) => x.itemId === I(1))!;
    expect(s?.samples ?? []).toHaveLength(0);
  });

  it('출력 범위가 있으면 범위 안 수업·배정 시간을 따로 집계한다', () => {
    const w = sampleWorld();
    const basic = w.curricula.find((c) => c.id === SAMPLE_IDS.curriculumBasic)!;
    const { plan } = makePlan(basic, w.tbs, baseSettings());
    const v = buildPlanViews(plan, { from: '2026-04-13', to: '2026-04-19' });
    expect(v.summary.lessonCount).toBe(2);
    expect(v.summary.assignedMinutes).toBeLessThan(v.header.totalMinutes);
  });
});

describe('3차 리뷰: 표 붙여넣기 가져오기', () => {
  it('따옴표 안의 쉼표·줄바꿈·겹따옴표를 칸 안의 글자로 읽는다', () => {
    expect(parseTable('제목,단위\n"읽기, 쓰기",쪽')).toEqual([['제목', '단위'], ['읽기, 쓰기', '쪽']]);
    const p = previewImport('제목\t단위\t시작\t끝\t시간\t메모\n중심 문장\t쪽\t12\t23\t30\t"첫 줄\n둘째 줄"\n요약\t쪽\t24\t35\t30\t', { idGen: () => 'x' });
    expect(p.items.map((i) => i.title)).toEqual(['중심 문장', '요약']);
    expect(p.items[0].teachingNote).toBe('첫 줄\n둘째 줄');
    const q = previewImport('제목\t단위\t시작\t끝\t시간\n"따옴표 ""중요"" 단원"\t쪽\t12\t23\t30', { idGen: () => 'x' });
    expect(q.items[0].title).toBe('따옴표 "중요" 단원');
  });

  it('정수가 아닌 쪽·시간·수량·난이도는 조용히 받아들이지 않고 알린다', () => {
    const p = previewImport('제목,단위,시작,끝,시간\nA,쪽,12.5,23,30\nB,쪽,-3,5,30\nC,쪽,0x10,0x20,1e2', { idGen: () => 'x' });
    expect(p.items.every((i) => !i.range)).toBe(true);
    expect(p.issues.filter((i) => i.level === 'error').map((i) => i.row)).toEqual(expect.arrayContaining([1, 2, 3]));
    expect(p.issues.some((i) => i.row === 3 && i.message.includes('1e2'))).toBe(true);
    const q = previewImport('제목,단위,수량,시간,난이도\nA,활동,abc,30,2.5', { idGen: () => 'x' });
    expect(q.items[0].quantity).toBe(1);
    expect(q.items[0].difficulty).toBeUndefined();
    expect(q.issues.filter((i) => i.level === 'warning').map((i) => i.message).join(' ')).toMatch(/수량.*abc[\s\S]*난이도.*2\.5|난이도.*2\.5[\s\S]*수량.*abc/);
    const r = previewImport('제목,단위,시작,끝,시간\nA,쪽,12,,30', { idGen: () => 'x' });
    expect(r.items[0].range).toEqual({ from: 12, to: 12 });
    expect(r.issues.some((i) => i.message.includes('끝이 비어'))).toBe(true);
  });

  it('범위 겹침·누락 경고는 순서 열 값이 아니라 붙여넣은 표의 행 번호로 알린다', () => {
    const p = previewImport('순서,제목,단위,시작,끝,시간\n10,A,쪽,12,23,30\n20,B,쪽,20,30,30\n30,C,쪽,40,50,30', { idGen: () => 'x' });
    const rows = p.issues.filter((i) => i.row > 0).map((i) => i.row);
    expect(rows.length).toBeGreaterThan(0);
    expect(Math.max(...rows)).toBeLessThanOrEqual(p.rowCount);
  });
});
