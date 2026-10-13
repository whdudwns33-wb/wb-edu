import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { Layout } from '../src/components/Layout.tsx';
import { Modal, Tabs } from '../src/components/ui.tsx';

vi.mock('../src/auth.tsx', () => ({
  useAuth: () => ({ user: { displayName: '가상 관리자', role: 'admin' }, logout: vi.fn() }),
}));

describe('공용 UI 접근성', () => {
  const tabs = [{ key: 'schedule', label: '일정' }, { key: 'records', label: '진도 기록' }, { key: 'print', label: '출력' }];

  it('선택한 탭만 일반 Tab 키로 접근한다', () => {
    const html = renderToStaticMarkup(<Tabs tabs={tabs} value="records" onChange={() => {}} />);
    expect(html).toContain('aria-selected="true" tabindex="0"');
    expect(html.match(/aria-selected="false" tabindex="-1"/g)).toHaveLength(2);
  });

  it.each([
    [0, 'ArrowRight', 1], [0, 'ArrowLeft', 2], [2, 'ArrowRight', 0],
    [1, 'Home', 0], [1, 'End', 2],
  ])('탭 %i에서 %s를 누르면 %i번 탭을 선택하고 초점을 옮긴다', (index, key, next) => {
    const onChange = vi.fn();
    const preventDefault = vi.fn();
    const children = tabs.map(() => ({ focus: vi.fn() }));
    const rendered = Tabs({ tabs, value: tabs[index].key, onChange });
    rendered.props.children[index].props.onKeyDown({ key, preventDefault, currentTarget: { parentElement: { children } } });
    expect(onChange).toHaveBeenCalledWith(tabs[next].key);
    expect(children[next].focus).toHaveBeenCalledOnce();
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it('탭 이동과 관계없는 키는 가로채지 않는다', () => {
    const onChange = vi.fn();
    const preventDefault = vi.fn();
    const rendered = Tabs({ tabs, value: 'schedule', onChange });
    rendered.props.children[0].props.onKeyDown({ key: 'Tab', preventDefault });
    expect(onChange).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('모달은 이름이 있는 표준 dialog를 사용한다', () => {
    const html = renderToStaticMarkup(<Modal title="학습항목 수정" onClose={() => {}}>항목 내용</Modal>);
    expect(html).toContain('<dialog');
    expect(html).toContain('aria-label="학습항목 수정"');
    expect(html).toContain('aria-label="닫기"');
  });

  it('모바일 더보기에서 계획 생성, 학습목표, 로그아웃에 접근한다', () => {
    const html = renderToStaticMarkup(<MemoryRouter initialEntries={['/plans']}><Layout /></MemoryRouter>);
    const more = html.slice(html.indexOf('<details'));
    expect(more).toContain('<summary>더보기</summary>');
    expect(more).toContain('href="/plans/new"');
    expect(more).toContain('href="/objectives"');
    expect(more).toContain('가상 관리자');
    expect(more).toContain('로그아웃');
  });
});
