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
    <>
      <div className="topbar">
        <h1>계획 목록</h1>
        <div className="row">
          <input aria-label="계획 검색" placeholder="검색 (계획명·대상·과정)" value={q} onChange={(e) => setQ(e.target.value)} />
          <label className="check">
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> 보관 포함
          </label>
          <Link className="btn primary" to="/plans/new">
            + 계획 만들기
          </Link>
        </div>
      </div>
      {error && <p className="alert danger">{error}</p>}
      <div className="panel tight">
        {loading ? (
          <Loading />
        ) : rows.length === 0 ? (
          <Empty>
            {q ? <>검색 조건에 맞는 계획이 없습니다. <button onClick={() => setQ('')}>검색 지우기</button></> : '아직 계획이 없습니다. 교재를 등록하고 표준과정을 만든 뒤 계획을 만들어 보세요.'}
          </Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>계획</th>
                  <th>대상</th>
                  <th>과정 (버전)</th>
                  <th>기간</th>
                  <th className="num">수업</th>
                  <th className="num">미배정</th>
                  <th className="num">기록</th>
                  <th>상태</th>
                  <th className="hide-mobile">수정</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.id}>
                    <td>
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
                    <td className="num">{p.lessonCount}</td>
                    <td className="num">{p.unassignedCount ? <Badge kind="danger">{p.unassignedCount}</Badge> : 0}</td>
                    <td className="num">{p.recordCount}</td>
                    <td>
                      <Badge kind={STATUS[p.archived ? 'archived' : p.status].kind}>{STATUS[p.archived ? 'archived' : p.status].label}</Badge>
                    </td>
                    <td className="muted small hide-mobile">{formatKST(p.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
