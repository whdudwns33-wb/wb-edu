import { describe, expect, it } from 'vitest';
import { baseSettings, makePlan, sampleWorld, BY, AT } from './helpers.ts';
import { SAMPLE_IDS, sampleObjectives } from '../src/sample.ts';
import { objectiveMap, supplementSuggestion } from '../src/objectives.ts';
import { dayView } from '../src/views.ts';
import { dayRows, extraLabelMap, resolveColumns } from '../src/output.ts';

const OBJ = (code: string) => `sample-obj-${code}`;

describe('선수 학습 부족 시 보충 제안 (시나리오 10)', () => {
  function advancePlan(required: string[], prereqVerified = true) {
    const w = sampleWorld();
    const basic = w.curricula.find((c) => c.id === SAMPLE_IDS.curriculumBasic)!;
    const { plan } = makePlan(basic, w.tbs, baseSettings());
    plan.snapshot.advance = { type: 'next_semester', currentGrade: '4', actualStage: '4-2', targetDescription: '5-1', targetDate: '', currentMinMinutes: 20, requiredObjectiveIds: required.map(OBJ), prerequisitesConfirmed: false };
    const objectives = sampleObjectives(BY, AT).map((o) => ({ ...o, prerequisiteVerified: prereqVerified }));
    return { plan, objectives, textbooks: [...w.tbs.values()] };
  }

  it('이해 확인이 없는 기초 목표와 담당자 확인된 선수 목표를 함께 제안하고, 연결된 교재 항목을 찾는다', () => {
    const { plan, objectives, textbooks } = advancePlan(['RD-5-04']);
    const s = supplementSuggestion(plan, objectives, textbooks);
    // RD-5-04 → 선수 RD-5-02 → 선수 RD-5-01
    expect(s.objectives.map((o) => o.objective.code)).toEqual(['RD-5-04', 'RD-5-02', 'RD-5-01']);
    expect(s.objectives[1].viaPrerequisiteOf).toBe(OBJ('RD-5-04'));
    const titles = s.items.map((i) => `${i.objectiveId.slice(-7)}:${i.itemTitle}`);
    expect(titles).toContain('RD-5-04:주장과 근거 구분하기');
    expect(titles).toContain('RD-5-01:중심 문장 찾기');
    expect(titles.some((t) => t.includes('활동지 1'))).toBe(true); // 자체교재 활동지도 연결 목표로 찾음
    expect(s.objectivesWithoutMaterial).toEqual([]);
  });

  it('선수 관계가 담당자 확인을 받지 않았으면 따라가지 않는다', () => {
    const { plan, objectives, textbooks } = advancePlan(['RD-5-04'], false);
    const s = supplementSuggestion(plan, objectives, textbooks);
    expect(s.objectives.map((o) => o.objective.code)).toEqual(['RD-5-04']);
  });

  it('이해 확인 기록이 있는 목표는 제안에서 빠지고, 자료가 없는 목표는 따로 알린다', () => {
    const { plan, objectives, textbooks } = advancePlan(['RD-5-01', 'RD-6-01']);
    const a = plan.assignments[0];
    plan.understandingChecks.push({ id: 'u1', lessonId: a.lessonId, itemId: a.itemId, textbookId: a.textbookId, objectiveIds: [OBJ('RD-5-01')], result: 'confirmed', note: '', checkedAt: AT, checkedBy: BY });
    const s = supplementSuggestion(plan, objectives, textbooks);
    const codes = s.objectives.map((o) => o.objective.code);
    expect(codes).not.toContain('RD-5-01');
    expect(codes).toContain('RD-6-01');
    // RD-6-01 은 샘플 교재 어디에도 연결되어 있지 않다
    expect(s.objectivesWithoutMaterial).toContain(OBJ('RD-6-01'));
  });

  it('보관된 교재와 제외된 항목은 제안하지 않는다', () => {
    const { plan, objectives, textbooks } = advancePlan(['RD-5-01'], false);
    const archived = textbooks.map((t) => (t.id === SAMPLE_IDS.inhouseTextbook ? { ...t, archived: true } : t));
    const s = supplementSuggestion(plan, objectives, archived);
    expect(s.items.every((i) => i.textbookId === SAMPLE_IDS.marketTextbook)).toBe(true);
  });
});

describe('같은 목표 반복 시 목적 확인', () => {
  it('다른 항목이 새 학습으로 같은 목표를 다시 다루면 목적 확인을 요청하고, 같은 항목 조각은 반복으로 보지 않는다', () => {
    const w = sampleWorld();
    const basic = w.curricula.find((c) => c.id === SAMPLE_IDS.curriculumBasic)!;
    const { plan } = makePlan(basic, w.tbs, baseSettings({ endDate: '2026-05-31' }));
    const objs = sampleObjectives(BY, AT);
    const map = new Map(objectiveMap(plan, objs).map((s) => [s.objectiveId, s]));
    // 샘플: i5(주장과 근거 구분하기)와 i6(근거의 타당성 판단하기)가 모두 RD-5-04
    expect(map.get(OBJ('RD-5-04'))!.repeatWithoutPurpose).toEqual(['근거의 타당성 판단하기']);
    // RD-5-01 은 i1 하나뿐 (분할 조각이 있어도 반복 아님)
    expect(map.get(OBJ('RD-5-01'))!.repeatWithoutPurpose).toEqual([]);
    // 반복 목적(심화)을 지정하면 확인 요청이 사라진다
    for (const a of plan.assignments) if (a.itemId === `${SAMPLE_IDS.marketTextbook}-i6`) a.repeatPurpose = 'deepen';
    expect(objectiveMap(plan, objs).find((s) => s.objectiveId === OBJ('RD-5-04'))!.repeatWithoutPurpose).toEqual([]);
  });
});

describe('과목별 항목 출력 열', () => {
  it('설정의 과목별 항목 이름으로 표시한다', () => {
    const w = sampleWorld();
    const basic = w.curricula.find((c) => c.id === SAMPLE_IDS.curriculumBasic)!;
    const { plan } = makePlan(basic, w.tbs, baseSettings());
    const labels = extraLabelMap([{ fields: [{ key: 'passage', label: '지문' }, { key: 'skill', label: '독해 기능' }] }, { fields: [{ key: 'passage', label: '중복 무시' }] }]);
    expect(labels).toEqual({ passage: '지문', skill: '독해 기능' });
    const cols = resolveColumns({ audience: 'student', columns: ['range', 'extra'] }, 'student');
    const rows = dayRows(dayView(plan, plan.lessons[0]), cols, labels);
    expect(rows[0]).toEqual(['12~23쪽', '지문: 설명문 2편 · 독해 기능: 중심 문장']);
    expect(resolveColumns(null, 'teacher').map((c) => c.key)).toContain('extra');
  });
});
