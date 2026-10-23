import { useState } from 'react';
import { Link } from 'react-router-dom';
import { formatKST } from '@wb/shared';
import { get } from '../api.ts';
import { Badge, Empty, Loading, SampleBadge, useAsync } from '../components/ui.tsx';

interface PlanRow {
  id: string;
  title: string;
  subject: string;
  target: string;
  status: 'draft' | 'confirmed' | 'archived';
  planVersion: number;
  curriculumTitle: string;
  curriculumVersion: number;
  startDate: string;
  endDate: string;
  lessonCount: number;
  unassignedCount: number;
  recordCount: number;
  updatedAt: string;
  isSample: boolean;
  archived: boolean;
}

const STATUS: Record<string, { label: string; kind: string }> = {
  draft: { label: '초안', kind: 'warn' },
  confirmed: { label: '확정', kind: 'ok' },
  archived: { label: '보관', kind: '' },
};

export function PlansListPage() {
  const [showArchived, setShowArchived] = useState(false);
  const [q, setQ] = useState('');
  const { data, loading, error } = useAsync(() => get<PlanRow[]>(`/api/plans${showArchived ? '?archived=1' : ''}`), [showArchived]);
  const rows = (data ?? []).filter((p) => !q || p.title.includes(q) || p.target.includes(q) || p.curriculumTitle.includes(q));

  return (
    <section className="plans-page">
      <div className="plans-heading">
        <div>
          <h1>계획 목록</h1>
          {!loading && !error && <p className="muted">{q ? `검색 결과 ${rows.length}건` : `계획 ${rows.length}건`}</p>}
        </div>
        <Link className="btn primary" to="/plans/new">계획 만들기</Link>
      </div>
      <div className="plans-filters">
        <input type="search" aria-label="계획 검색" placeholder="계획명·대상·과정 검색" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="check">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> 보관 포함
        </label>
      </div>
      {error && <p className="alert danger">{error}</p>}
      <div className="panel tight plans-results">
        {loading ? (
          <Loading />
        ) : rows.length === 0 ? (
          <Empty>
            {q ? <>검색 조건에 맞는 계획이 없습니다. <button onClick={() => setQ('')}>검색 지우기</button></> : '아직 계획이 없습니다. 교재를 등록하고 표준과정을 만든 뒤 계획을 만들어 보세요.'}
          </Empty>
        ) : (
          <>
          <div className="table-wrap plans-table">
            <table>
              <thead>
                <tr>
                  <th>계획</th>
                  <th>대상</th>
                  <th>과정 (버전)</th>
                  <th>기간</th>
                  <th>진행</th>
                  <th>상태</th>
                  <th>최근 수정</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.id}>
                    <td className="plans-title-cell">
                      <Link to={`/plans/${p.id}`}>{p.title}</Link> <SampleBadge show={p.isSample} />
                      <div className="muted small">{p.subject} · 계획 v{p.planVersion}</div>
                    </td>
                    <td>{p.target || <span className="muted">-</span>}</td>
                    <td>
                      {p.curriculumTitle} <span className="muted small">v{p.curriculumVersion}</span>
                    </td>
                    <td className="nowrap">
                      {p.startDate} ~ {p.endDate || '?'}
                    </td>
                    <td className="plans-progress">
                      <span>수업 {p.lessonCount}회 · 기록 {p.recordCount}건</span>
                      <span className={p.unassignedCount ? 'plans-pending' : 'muted'}>미배정 {p.unassignedCount}건</span>
                    </td>
                    <td>
                      <Badge kind={STATUS[p.archived ? 'archived' : p.status].kind}>{STATUS[p.archived ? 'archived' : p.status].label}</Badge>
                    </td>
                    <td className="muted small nowrap">{formatKST(p.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="plans-cards">
            {rows.map((p) => (
              <li key={p.id}>
                <div className="plans-card-heading">
                  <Link to={`/plans/${p.id}`}>{p.title}</Link>
                  <Badge kind={STATUS[p.archived ? 'archived' : p.status].kind}>{STATUS[p.archived ? 'archived' : p.status].label}</Badge>
                </div>
                <div className="plans-card-subtitle"><SampleBadge show={p.isSample} /> <span>{p.subject} · {p.target || '대상 미지정'}</span></div>
                <dl>
                  <div><dt>과정</dt><dd>{p.curriculumTitle} <span className="muted">v{p.curriculumVersion}</span></dd></div>
                  <div><dt>기간</dt><dd>{p.startDate} ~ {p.endDate || '미정'}</dd></div>
                  <div><dt>진행</dt><dd>수업 {p.lessonCount}회 · 기록 {p.recordCount}건{p.unassignedCount > 0 && <span className="plans-pending"> · 미배정 {p.unassignedCount}건</span>}</dd></div>
                </dl>
              </li>
            ))}
          </ul>
          </>
        )}
      </div>
    </section>
  );
}
