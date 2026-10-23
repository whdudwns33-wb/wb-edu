import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { defaultSettings, SettingsForm } from '../src/pages/PlanCreatePage.tsx';

describe('계획 트랙 설정', () => {
  it.each([
    [0, 15, null, true],
    [0, 0, [1], true],
    [0, 0, null, false],
    [1, 15, [1], false],
    [undefined, 15, [1], false],
  ])('선행 항목 %s건, 시간 %i분, 요일 %s이면 경고=%s', (advanceEntryCount, advance, advanceWeekdays, warn) => {
    const s = defaultSettings();
    s.tracks = { ...s.tracks, advance, advanceWeekdays };
    const html = renderToStaticMarkup(<SettingsForm s={s} onChange={() => {}} holidaySets={[]} showAdvanced={false} setShowAdvanced={() => {}} advanceEntryCount={advanceEntryCount} />);
    expect(html.includes('선행 항목이 없습니다')).toBe(warn);
  });

  it('선행 시간 입력은 시간 설정만 바꾸고 다른 설정과 원본을 보존한다', () => {
    const s = defaultSettings();
    s.tracks = { review: 10, advance: 15, advanceWeekdays: [1], currentMinMinutes: 20 };
    const before = structuredClone(s);
    const onChange = vi.fn();
    const tree = SettingsForm({ s, onChange, holidaySets: [], showAdvanced: true, setShowAdvanced: () => {}, advanceEntryCount: 1 });
    const findField = (node: ReactNode): ReactElement<{ label?: string; children: ReactElement<{ onChange: (e: { target: { value: string } }) => void }> }> | undefined => {
      for (const child of Children.toArray(node)) {
        if (!isValidElement<{ label?: string; children: ReactNode }>(child)) continue;
        if (child.props.label === '선행 트랙(분)') return child as ReturnType<typeof findField>;
        const found = findField(child.props.children);
        if (found) return found;
      }
    };
    const field = findField(tree);
    expect(field).toBeDefined();
    field!.props.children.props.onChange({ target: { value: '25' } });
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ ...before, tracks: { ...before.tracks, advance: 25 } });
    expect(s).toEqual(before);
  });
});
