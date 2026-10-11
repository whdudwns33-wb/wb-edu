import { useState } from 'react';
import type { LearningObjective } from '@wb/shared';
import { OBJECTIVE_STATE_LABEL, type ObjectiveStatus } from '@wb/shared';
import { get, post, put, errorMessage } from '../api.ts';
import { useAuth } from '../auth.tsx';
import { Alert, Badge, Empty, Field, Loading, Modal, SampleBadge, useAsync } from '../components/ui.tsx';

interface PlanRow {
  id: string;
  title: string;
  startDate: string;
  endDate: string;
}

export function ObjectivesPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const { data: objectives, loading, error, reload } = useAsync(() => get<LearningObjective[]>('/api/objectives'), []);
  const { data: plans } = useAsync(() => get<PlanRow[]>('/api/plans'), []);
  const [editing, setEditing] = useState<LearningObjective | null>(null);
  const [planId, setPlanId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const { data: map } = useAsync(() => (planId ? get<{ statuses: ObjectiveStatus[] }>(`/api/plans/${planId}/objectives${from && to ? `?from=${from}&to=${to}` : ''}`) : Promise.resolve(null)), [planId, from, to]);
  const byId = new Map((objectives ?? []).map((o) => [o.id, o]));
  const kind: Record<string, string> = { planned: 'info', progressed: 'primary', confirmed: 'ok', unassigned: 'danger' };

  return (
    <>
      <div className="topbar">
        <h1>학습목표 지도</h1>
        {isAdmin && (
          <button className="primary" onClick={() => setEditing({ id: '', code: '', title: '', subject: '독해', schoolLevel: '초', grade: '', description: '', prerequisiteObjectiveIds: [], prerequisiteVerified: false, verificationNote: '', createdAt: '', createdBy: '', updatedAt: '', updatedBy: '', version: 0, archived: false, isSample: false })}>
            + 학습목표
          </button>
        )}
      </div>
      {error && <Alert kind="danger">{error}</Alert>}
      <div className="panel">
        <h2>학습목표 정의와 선수 관계</h2>
        <p className="muted small">검증된 자료 또는 담당자가 확인한 선수 관계만 확정 데이터로 사용합니다. 미확인 관계는 표시만 하고 선행 판단에 쓰지 않습니다.</p>
        {loading ? (
          <Loading />
        ) : !objectives?.length ? (
          <Empty>학습목표가 없습니다.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="compact">
              <thead>
                <tr>
                  <th>코드</th>
                  <th>목표</th>
                  <th>과목·학년</th>
                  <th>선수 목표</th>
                  <th>선수 관계 확인</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {objectives.map((o) => (
                  <tr key={o.id}>
                    <td className="nowrap">
                      <strong>{o.code}</strong> <SampleBadge show={o.isSample} />
                    </td>
                    <td>
                      {o.title}
                      {o.description && <div className="muted small">{o.description}</div>}
                    </td>
                    <td className="small">
                      {o.subject} {o.schoolLevel}
                      {o.grade}
                    </td>
                    <td className="small">{o.prerequisiteObjectiveIds.map((p) => byId.get(p)?.code ?? p).join(', ')}</td>
                    <td>{o.prerequisiteVerified ? <Badge kind="ok">확인됨</Badge> : <Badge kind="warn">미확인</Badge>}</td>
                    <td>{isAdmin && <button className="sm" onClick={() => setEditing(o)}>수정</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="panel">
        <h2>계획별 목표 현황</h2>
        <div className="row mb">
          <select value={planId} onChange={(e) => setPlanId(e.target.value)}>
            <option value="">계획 선택</option>
            {(plans ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.title} ({p.startDate}~{p.endDate})
              </option>
            ))}
          </select>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /> ~ <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          <span className="muted small">기간을 비우면 전체</span>
        </div>
        {planId && map && (
          <div className="table-wrap">
            <table className="compact">
              <thead>
                <tr>
                  <th>목표</th>
                  <th>필수</th>
                  <th>상태</th>
                  <th>계획 배치</th>
                  <th>실제 진행</th>
                  <th>이해 확인</th>
                </tr>
              </thead>
              <tbody>
                {map.statuses.map((s) => (
                  <tr key={s.objectiveId}>
                    <td>
                      <strong>{s.code}</strong> {s.title}
                    </td>
                    <td>{s.required && <Badge kind="primary">필수</Badge>}</td>
                    <td>
                      <Badge kind={kind[s.state]}>{OBJECTIVE_STATE_LABEL[s.state]}</Badge>
                    </td>
                    <td className="small">{s.plannedDates.join(', ')}</td>
                    <td className="small">{s.progressedDates.join(', ')}</td>
                    <td className="small">{s.confirmedDates.join(', ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {editing && (
        <ObjectiveModal
          o={editing}
          all={objectives ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
    </>
  );
}

function ObjectiveModal({ o, all, onClose, onSaved }: { o: LearningObjective; all: LearningObjective[]; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState(o);
  const [err, setErr] = useState('');
  const save = async () => {
    try {
      if (f.id) await put(`/api/objectives/${f.id}`, f);
      else await post('/api/objectives', f);
      onSaved();
    } catch (e) {
      setErr(errorMessage(e));
    }
  };
  return (
    <Modal title={f.id ? '학습목표 수정' : '학습목표 추가'} onClose={onClose}>
      {err && <Alert kind="danger">{err}</Alert>}
      <div className="grid cols-2">
        <Field label="코드 *">
          <input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} />
        </Field>
        <Field label="제목 *">
          <input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
        </Field>
        <Field label="과목">
          <input value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} />
        </Field>
        <Field label="학교급·학년">
          <div className="row">
            <select value={f.schoolLevel} onChange={(e) => setF({ ...f, schoolLevel: e.target.value as LearningObjective['schoolLevel'] })}>
              {['초', '중', '고', '공통'].map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
            <input value={f.grade} onChange={(e) => setF({ ...f, grade: e.target.value })} placeholder="학년" />
          </div>
        </Field>
        <Field label="선수 목표">
          <select multiple size={5} value={f.prerequisiteObjectiveIds} onChange={(e) => setF({ ...f, prerequisiteObjectiveIds: [...e.target.selectedOptions].map((x) => x.value) })}>
            {all.filter((x) => x.id !== f.id).map((x) => (
              <option key={x.id} value={x.id}>
                {x.code} {x.title}
              </option>
            ))}
          </select>
        </Field>
        <Field label="선수 관계 확인">
          <label className="check">
            <input type="checkbox" checked={f.prerequisiteVerified} onChange={(e) => setF({ ...f, prerequisiteVerified: e.target.checked })} /> 검증 자료 또는 담당자 확인 완료
          </label>
          <input placeholder="확인 출처·메모" value={f.verificationNote} onChange={(e) => setF({ ...f, verificationNote: e.target.value })} />
        </Field>
      </div>
      <Field label="설명">
        <textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
      </Field>
      <div className="row mt" style={{ justifyContent: 'space-between' }}>
        {f.id ? <button className="danger" onClick={() => post(`/api/objectives/${f.id}/archive`, { archived: true }).then(onSaved).catch((e) => setErr(errorMessage(e)))}>보관</button> : <span />}
        <div className="row">
          <button onClick={onClose}>취소</button>
          <button className="primary" onClick={save}>
            저장
          </button>
        </div>
      </div>
    </Modal>
  );
}
