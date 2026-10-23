import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { CurriculumEditorPage } from '../src/pages/CurriculaPage.tsx';

vi.mock('../src/auth.tsx', () => ({ useAuth: () => ({ user: { displayName: '[가상] 관리자', role: 'admin' } }) }));

describe('과정 트랙 선택 안내', () => {
  it('자동 구성 기본 현행을 명시하고 일괄 지정 전에 대상 개수를 보여 준다', () => {
    const html = renderToStaticMarkup(<MemoryRouter initialEntries={['/curricula/new']}><Routes><Route path="/curricula/:id" element={<CurriculumEditorPage />} /></Routes></MemoryRouter>);
    expect(html).toContain('생성할 기본 트랙');
    expect(html).toContain('<option value="current" selected="">현행</option>');
    expect(html).toContain('보충형은 주교재와 보충 교재를 연결하는 조합 방식');
    expect(html).toContain('교재별 트랙 일괄 지정');
    expect(html).toContain('적용 대상: 차시 0건 · 미배정 0건 · 합계 0건');
  });
});
