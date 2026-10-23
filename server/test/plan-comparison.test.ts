import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Curriculum, LearningApproach, Plan, PlanSettings, Textbook } from '@wb/shared';
import { buildPlanViews } from '@wb/shared';
import { buildApp } from '../src/app.ts';
import { hashPassword } from '../src/auth.ts';
import { buildWorkbook } from '../src/export.ts';
import ExcelJS from 'exceljs';

let built: Awaited<ReturnType<typeof buildApp>>;
const cookie = 'wb_session=comparison-session';
let tb: Textbook;
let curriculum: Curriculum;
const settings = { startDate: '2026-10-19', weekdays: [1, 3, 5], minutesPerLesson: 90, reviewMinutes: 10, bufferMinutes: 5, mode: 'pace' };
const post = (url: string, payload: object) => built.app.inject({ method: 'POST', url, payload, headers: { cookie } });
const getPlan = (id: string) => built.ctx.store.mustGet<Plan>('plan', id);
type Comparison = { sourceVersion: string; options: Array<{ learningApproach: LearningApproach; settings: PlanSettings; lessons: Plan['lessons']; assignments: Plan['assignments']; snapshot: Plan['snapshot']; endDateComputed: string }> };

beforeEach(async () => {
  built = await buildApp({ dbPath: ':memory:' });
  built.ctx.store.insertUser({ id: 'comparison-admin', username: 'comparison-admin', displayName: '가상 관리자', role: 'admin', passwordHash: hashPassword('comparison-password'), createdAt: built.ctx.now() });
  built.ctx.store.createSession('comparison-session', 'comparison-admin', 60000);
  tb = (await post('/api/textbooks', { title: '[가상] 비교 교재', isSample: true, items: [
    { id: 'chapter-1', title: '분수', progressUnit: 'page', range: { from: 1, to: 24 }, minutes: 300, splittable: true },
    { id: 'chapter-2', title: '도형', progressUnit: 'page', range: { from: 25, to: 48 }, minutes: 300, splittable: true },
  ] })).json<Textbook>();
  const assembled = (await post('/api/curricula/auto-assemble', { textbooks: [{ textbookId: tb.id }], minutesPerSession: 90, reviewMinutes: 10, bufferMinutes: 5 })).json();
  curriculum = (await post('/api/curricula', { ...assembled, title: '[가상] 비교 과정', isSample: true, status: 'draft' })).json<Curriculum>();
});
afterEach(async () => { await built.app.close(); });

async function compare(extra = {}): Promise<Comparison> {
  const response = await post('/api/plans/compare', { curriculumId: curriculum.id, settings, ...extra });
  expect(response.statusCode, response.body).toBe(200);
  return response.json();
}
const create = (comparison: Comparison, approach: LearningApproach = 'standard', extra = {}) => post('/api/plans', {
  curriculumId: curriculum.id, settings, learningApproach: approach, expectedSourceVersion: comparison.sourceVersion,
  title: '[가상] 학생 A의 계획', classOrStudentRef: '[가상] 학생 A', ...extra,
});

describe('학생 맞춤 3안 비교와 단일 저장', () => {
  it('계획을 저장하지 않고 동일 범위의 세 안을 계산한다', async () => {
    const beforeTb = structuredClone(tb);
    const beforeCu = structuredClone(curriculum);
    const comparison = await compare();
    expect(comparison.options.map((x) => x.learningApproach)).toEqual(['foundation', 'standard', 'fast']);
    expect(comparison.options.map((x) => x.settings.reviewMinutes)).toEqual([34, 17, 9]);
    for (const option of comparison.options) {
      expect(option.snapshot.textbooks).toEqual(comparison.options[0].snapshot.textbooks);
      expect(option.snapshot.sessions).toEqual(comparison.options[0].snapshot.sessions);
      expect(option.assignments.reduce((sum, a) => sum + a.minutes, 0)).toBe(600);
    }
    const dates = comparison.options.map((x) => x.endDateComputed);
    expect(dates[0] >= dates[1] && dates[1] >= dates[2]).toBe(true);
    expect(built.ctx.store.list('plan')).toHaveLength(0);
    expect(built.ctx.store.mustGet('textbook', tb.id)).toEqual(beforeTb);
    expect(built.ctx.store.mustGet('curriculum', curriculum.id)).toEqual(beforeCu);
  });
  it.each(['foundation', 'standard', 'fast'] as const)('%s 하나만 저장하고 샘플·학생 표시·예상 일정을 보존한다', async (approach) => {
    const comparison = await compare();
    const response = await create(comparison, approach, { isSample: false });
    expect(response.statusCode, response.body).toBe(201);
    const plan = response.json<Plan>();
    const option = comparison.options.find((x) => x.learningApproach === approach)!;
    expect(plan.learningApproach).toBe(approach);
    expect(plan.settings.reviewMinutes).toBe(option.settings.reviewMinutes);
    expect(plan.endDateComputed).toBe(option.endDateComputed);
    expect(plan.classOrStudentRef).toBe('[가상] 학생 A');
    expect(plan.isSample).toBe(true);
    expect(plan.status).toBe('draft');
    expect(plan.records).toEqual([]);
    expect(built.ctx.store.list('plan')).toHaveLength(1);
  });
  it.each(['교재', '과정'])('비교 뒤 %s가 바뀌면 409이며 저장하지 않는다', async (source) => {
    const comparison = await compare();
    if (source === '교재') built.ctx.store.update('textbook', { ...tb, version: tb.version + 1 }, tb.version);
    else built.ctx.store.update('curriculum', { ...curriculum, version: curriculum.version + 1 }, curriculum.version);
    const response = await create(comparison);
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toContain('다시 비교');
    expect(built.ctx.store.list('plan')).toHaveLength(0);
  });
  it('잘못된 선택·원천 버전 없이 저장하는 요청을 거절한다', async () => {
    const comparison = await compare();
    expect((await create(comparison, 'standard', { learningApproach: 'unknown' })).statusCode).toBe(400);
    expect((await create(comparison, 'standard', { expectedSourceVersion: undefined })).statusCode).toBe(409);
    expect(built.ctx.store.list('plan')).toHaveLength(0);
  });
  it('로그인 없이 비교할 수 없다', async () => {
    expect((await built.app.inject({ method: 'POST', url: '/api/plans/compare', payload: { curriculumId: curriculum.id, settings } })).statusCode).toBe(401);
  });
  it('보관 과정·빈 선택 범위·새 진도 1분 미만은 사용자 오류로 거절한다', async () => {
    expect((await post('/api/plans/compare', { curriculumId: curriculum.id, settings, fromSessionOrder: 999 })).statusCode).toBe(400);
    expect((await post('/api/plans/compare', { curriculumId: curriculum.id, settings: { ...settings, minutesPerLesson: 0.5, reviewMinutes: 0, bufferMinutes: 0 } })).statusCode).toBe(400);
    built.ctx.store.update('curriculum', { ...curriculum, archived: true }, curriculum.version);
    expect((await post('/api/plans/compare', { curriculumId: curriculum.id, settings })).statusCode).toBe(400);
  });
  it('기존 직접 설정 생성 API와 과거 계획은 학습안 없이 동작한다', async () => {
    const response = await post('/api/plans', { curriculumId: curriculum.id, settings });
    expect(response.statusCode).toBe(201);
    expect(response.json().learningApproach).toBeUndefined();
    expect(response.json().settings.reviewMinutes).toBe(10);
  });
  it('진도 기록 후 재편성해도 기록을 지우지 않고 다섯 보기·출력에 같은 선택안을 쓴다', async () => {
    const comparison = await compare();
    let plan = (await create(comparison)).json<Plan>();
    const assignment = plan.assignments[0];
    plan = (await post(`/api/plans/${plan.id}/records`, { version: plan.version, assignmentId: assignment.id, status: 'done' })).json<Plan>();
    const records = structuredClone(plan.records);
    const response = await post(`/api/plans/${plan.id}/ops`, { version: plan.version, op: 'reschedule', params: { fromDate: settings.startDate } });
    expect(response.statusCode, response.body).toBe(200);
    plan = getPlan(plan.id);
    expect(plan.records).toEqual(records);
    expect(plan.assignments.find((a) => a.id === assignment.id)).toEqual(assignment);
    const views = buildPlanViews(plan);
    expect(views.header.mode).toContain('표준형');
    expect(views.years[0].quarters[0].months[0].weeks[0].days.length).toBeGreaterThan(0);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Uint8Array.from(await buildWorkbook(plan, { audience: 'student', levels: ['year', 'quarter', 'month', 'week', 'day'] })).buffer);
    expect(workbook.worksheets.map((ws) => ws.name)).toEqual(['표지', '연간', '분기', '월간', '주간', '일간']);
    expect(workbook.getWorksheet('표지')!.getColumn(2).values.join(' ')).toContain('표준형');
  });
});
