import { Children, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LEARNING_APPROACHES, settingsForApproach } from '@wb/shared';
import { PlanOptions } from '../src/components/PlanOptions.tsx';
import { comparePlanOptions, comparisonSaveFields, defaultSettings } from '../src/pages/PlanCreatePage.tsx';
import * as api from '../src/api.ts';
import { baseSettings, makePlan, sampleWorld } from '../../shared/test/helpers.ts';

const options = LEARNING_APPROACHES.map((learningApproach) => ({ learningApproach, settings: settingsForApproach(defaultSettings(), learningApproach), endDateComputed: '2026-12-01', lessons: [{ status: 'scheduled' }], unassigned: [] }));
afterEach(() => vi.restoreAllMocks());

describe('3안 비교 선택 화면', () => {
  it('세 안을 라디오로 표시하고 미선택·가정·심화 제한을 명시한다', () => {
    const html = renderToStaticMarkup(<PlanOptions options={options} selected={null} onSelect={() => {}} />);
    expect(html.match(/type="radio"/g)).toHaveLength(3);
    expect(html).not.toContain('checked=""');
    for (const name of ['기초·보강형', '표준형', '빠른 진도·심화형', '완료 예정일', '선택 전에는 계획을 저장하지 않습니다', '심화 문항 생성은 하지 않습니다']) expect(html).toContain(name);
  });
  it('선택된 하나만 표시하고 다른 옵션 선택을 전달한다', () => {
    const onSelect = vi.fn();
    const html = renderToStaticMarkup(<PlanOptions options={options} selected="standard" onSelect={onSelect} />);
    expect(html.match(/checked=""/g)).toHaveLength(1);
    const visit = (node: ReactNode) => {
      for (const child of Children.toArray(node)) {
        if (!isValidElement<{ value?: string; onChange?: () => void; children?: ReactNode }>(child)) continue;
        if (child.props.value === 'foundation') child.props.onChange?.();
        visit(child.props.children);
      }
    };
    visit(PlanOptions({ options, selected: 'standard', onSelect }));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('foundation');
  });
  it('저장 중에는 라디오 변경을 잠근다', () => {
    const html = renderToStaticMarkup(<PlanOptions options={options} selected="standard" disabled onSelect={() => {}} />);
    expect(html).toContain('<fieldset class="plan-options" disabled=""');
  });
  it.each([
    ['pace', 0, '완료 예정일'],
    ['period', 0, '마지막 배정일'],
    ['pace', 1, '마지막 배정일'],
  ] as const)('%s 편성, 미배정 %i건의 날짜는 %s로 표시한다', (mode, pending, label) => {
    const option = { ...options[0], settings: { ...options[0].settings, mode }, unassigned: Array(pending).fill({}) };
    const html = renderToStaticMarkup(<PlanOptions options={[option]} selected={null} onSelect={() => {}} />);
    expect(html).toContain(`<dt>${label}</dt><dd>2026-12-01</dd>`);
    if (pending) expect(html).toContain('<dt>완료 예정일</dt><dd>미정</dd>');
  });
  it('지연 응답 중 원래 입력이 바뀌어도 비교한 범위·서버 설정으로 저장한다', async () => {
    const { curricula, tbs } = sampleWorld();
    const { plan } = makePlan(curricula[0], tbs, baseSettings());
    const response = { sourceVersion: 'comparison-source', options: [{ learningApproach: 'standard' as const, settings: settingsForApproach(plan.settings, 'standard'), lessons: plan.lessons, assignments: plan.assignments, unassigned: plan.unassigned, endDateComputed: plan.endDateComputed, warnings: [], shortageMinutes: 0, snapshot: plan.snapshot }] };
    let resolve!: (value: typeof response) => void;
    const pending = new Promise<typeof response>((done) => { resolve = done; });
    const mock = vi.spyOn(api, 'post').mockReturnValue(pending);
    const input = { curriculumId: curricula[0].id, settings: structuredClone(plan.settings), fromSessionOrder: 2, toSessionOrder: 5 };
    const before = structuredClone(input);
    const promise = comparePlanOptions(input);
    input.settings.startDate = '2027-01-01';
    input.settings.weekdays.push(6);
    input.fromSessionOrder = 9;
    resolve(response);
    const comparison = await promise;
    expect(mock).toHaveBeenCalledExactlyOnceWith('/api/plans/compare', before);
    expect(comparison.request).toEqual(before);
    expect(comparisonSaveFields(comparison, 'standard')).toEqual({ curriculumId: before.curriculumId, settings: response.options[0].settings, fromSessionOrder: 2, toSessionOrder: 5, learningApproach: 'standard', expectedSourceVersion: response.sourceVersion });
  });
});
