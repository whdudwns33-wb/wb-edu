import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { Activity, Curriculum, CurriculumSession, LearningObjective, SessionEntry, Textbook, Track } from '@wb/shared';
import { ACTIVITY_LABEL, ADVANCE_TYPE_LABEL, COMPOSITION_LABEL, TRACK_LABEL, curriculumTotals, fmtMinutes, mergeEntries, moveEntry, rangeLabel, renumber, sessionMinutes, splitEntry } from '@wb/shared';
import { get, post, put, errorMessage } from '../api.ts';
import { useAuth } from '../auth.tsx';
import { Alert, Badge, Empty, Field, Loading, Modal, SampleBadge, useAsync } from '../components/ui.tsx';

type CurriculumRow = Curriculum & { totals: ReturnType<typeof curriculumTotals> };
const STATUS: Record<string, { label: string; kind: string }> = { draft: { label: '초안', kind: 'warn' }, reviewing: { label: '검토 중', kind: 'info' }, verified: { label: '검증됨', kind: 'ok' } };

export function CurriculaPage() {
  const { user } = useAuth();
  const [q, setQ] = useState('');
  const { data, loading, error } = useAsync(() => get<CurriculumRow[]>('/api/curricula'), []);
  const rows = (data ?? []).filter((c) => !q || c.title.includes(q) || c.target.includes(q));
  return (
    <>
      <div className="topbar">
        <h1>표준과정 보관함</h1>
        <div className="row">
          <input placeholder="검색" value={q} onChange={(e) => setQ(e.target.value)} />
          {user?.role === 'admin' && (
            <Link className="btn primary" to="/curricula/new">
              + 과정 만들기
            </Link>
          )}
        </div>
      </div>
      <p className="muted small">교재와 '그 교재를 가르치는 과정'을 분리합니다. 한 교재에 기본 진행안·복습 강화안·방학 집중안·보충안·선행안 등 여러 과정을 둘 수 있습니다.</p>
      {error && <Alert kind="danger">{error}</Alert>}
      <div className="panel tight">
        {loading ? (
          <Loading />
        ) : rows.length === 0 ? (
          <Empty>표준과정이 없습니다.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>과정</th>
                  <th>대상</th>
                  <th>구성</th>
                  <th>교재</th>
                  <th className="num">차시</th>
                  <th className="num">예상 시간</th>
                  <th className="num">미배정</th>
                  <th>버전·상태</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <Link to={`/curricula/${c.id}`}>{c.title}</Link> <SampleBadge show={c.isSample} /> {c.origin === 'recommended' && <Badge kind="info">권장안</Badge>}
                      {c.advance && <Badge kind="info">{ADVANCE_TYPE_LABEL[c.advance.type]}</Badge>}
                    </td>
                    <td>{c.target}</td>
                    <td>{COMPOSITION_LABEL[c.compositionMode]}</td>
                    <td className="small">{c.textbooks.length}권</td>
                    <td className="num">{c.totals.sessions}</td>
                    <td className="num">{fmtMinutes(c.totals.minutes)}</td>
                    <td className="num">{c.totals.unassignedMinutes ? <Badge kind="warn">{c.unassignedEntries.length}건</Badge> : 0}</td>
                    <td>
                      v{c.curriculumVersion} <Badge kind={STATUS[c.status].kind}>{STATUS[c.status].label}</Badge>
                    </td>
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

function blankCurriculum(): Curriculum {
  const at = new Date().toISOString();
  return { id: '', title: '', subject: '', target: '', goal: '', textbooks: [], compositionMode: 'sequential', sessions: [], unassignedEntries: [], recommendedPerWeek: 2, recommendedMinutesPerSession: 60, reviewMinutesPerSession: 10, bufferMinutesPerSession: 5, assessmentEvery: 0, curriculumVersion: 1, status: 'draft', origin: 'custom', reviewComments: [], createdAt: at, createdBy: '', updatedAt: at, updatedBy: '', version: 0, archived: false, isSample: false };
}

export function CurriculumEditorPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const { user } = useAuth();
  const isNew = id === 'new';
  const readOnly = user?.role !== 'admin';
  const [doc, setDoc] = useState<Curriculum | null>(isNew ? blankCurriculum() : null);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [mergeWith, setMergeWith] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [splitTarget, setSplitTarget] = useState<SessionEntry | null>(null);
  const [comment, setComment] = useState('');
  const { data: textbooks } = useAsync(() => get<Textbook[]>('/api/textbooks'), []);
  const { data: objectives } = useAsync(() => get<LearningObjective[]>('/api/objectives'), []);

  useEffect(() => {
    if (!isNew && id) get<Curriculum>(`/api/curricula/${id}`).then(setDoc).catch((e) => setError(errorMessage(e)));
  }, [id, isNew]);

  const tbMap = useMemo(() => new Map((textbooks ?? []).map((t) => [t.id, t])), [textbooks]);
  const itemOf = (e: SessionEntry) => tbMap.get(e.textbookId)?.items.find((i) => i.id === e.itemId);

  if (error && !doc) return <Alert kind="danger">{error}</Alert>;
  if (!doc) return <Loading />;
  const set = (patch: Partial<Curriculum>) => setDoc({ ...doc, ...patch });
  const totals = curriculumTotals(doc);
  const budget = doc.recommendedMinutesPerSession - doc.reviewMinutesPerSession - doc.bufferMinutesPerSession;

  const save = async () => {
    setBusy(true);
    setError('');
    setMsg('');
    try {
      const saved = isNew ? await post<Curriculum>('/api/curricula', doc) : await put<Curriculum>(`/api/curricula/${doc.id}`, doc);
      setDoc(saved);
      setMsg(`저장했습니다. (과정 v${saved.curriculumVersion}, ${STATUS[saved.status].label})`);
      if (isNew) nav(`/curricula/${saved.id}`, { replace: true });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const autoAssemble = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await post<{ sessions: CurriculumSession[]; unassignedEntries: SessionEntry[] }>('/api/curricula/auto-assemble', {
        textbooks: doc.textbooks,
        compositionMode: doc.compositionMode,
        minutesPerSession: doc.recommendedMinutesPerSession,
        reviewMinutes: doc.reviewMinutesPerSession,
        bufferMinutes: doc.bufferMinutesPerSession,
        assessmentEvery: doc.assessmentEvery,
      });
      set({ sessions: r.sessions, unassignedEntries: r.unassignedEntries, status: 'draft' });
      setMsg(`자동 구성: ${r.sessions.length}차시, 미배정 ${r.unassignedEntries.length}건. 자동 초안이며 검증된 과정으로 표시되지 않습니다.`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const findEntry = (eid: string): { entry: SessionEntry; sessionIdx: number } | null => {
    for (let i = 0; i < doc.sessions.length; i++) {
      const e = doc.sessions[i].entries.find((x) => x.id === eid);
      if (e) return { entry: e, sessionIdx: i };
    }
    const u = doc.unassignedEntries.find((x) => x.id === eid);
    return u ? { entry: u, sessionIdx: -1 } : null;
  };
  const sel = selected ? findEntry(selected) : null;
  const updateEntry = (eid: string, patch: Partial<SessionEntry>) =>
    set({ sessions: doc.sessions.map((s) => ({ ...s, entries: s.entries.map((e) => (e.id === eid ? { ...e, ...patch } : e)) })), unassignedEntries: doc.unassignedEntries.map((e) => (e.id === eid ? { ...e, ...patch } : e)) });
  /** 드래그 앤 드롭: 차시(특정 위치 앞) 또는 미배정(null)으로 이동. 같은 차시 안에서 뒤로 옮길 때는 제거 후 인덱스가 하나 당겨지는 것을 보정한다 */
  const dropTo = (sessionId: string | null, beforeIndex?: number) => {
    const id = dragId;
    setDragId(null);
    setDropTarget(null);
    if (!id || readOnly) return;
    let idx = beforeIndex;
    if (sessionId && idx !== undefined) {
      const s = doc.sessions.find((x) => x.id === sessionId);
      const from = s?.entries.findIndex((e) => e.id === id) ?? -1;
      if (from >= 0 && from < idx) idx -= 1;
      if (from === idx) return;
    }
    setDoc(moveEntry(doc, id, sessionId, idx));
    setSelected(id);
  };
  const moveSel = (delta: number) => {
    if (!sel) return;
    const target = sel.sessionIdx + delta;
    if (target < 0 || target >= doc.sessions.length) return;
    setDoc(moveEntry(doc, sel.entry.id, doc.sessions[target].id));
  };
  const addSession = () => set({ sessions: renumber([...doc.sessions, { id: crypto.randomUUID(), order: doc.sessions.length + 1, title: '', entries: [] }]) });
  const removeSession = (sid: string) => {
    const s = doc.sessions.find((x) => x.id === sid);
    if (!s) return;
    set({ sessions: renumber(doc.sessions.filter((x) => x.id !== sid)), unassignedEntries: [...doc.unassignedEntries, ...s.entries] });
  };
  const moveSession = (sid: string, delta: number) => {
    const i = doc.sessions.findIndex((x) => x.id === sid);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= doc.sessions.length) return;
    const arr = [...doc.sessions];
    [arr[i], arr[j]] = [arr[j], arr[i]];
    set({ sessions: renumber(arr) });
  };
  const addItemsToUnassigned = (tbId: string) => {
    const tb = tbMap.get(tbId);
    if (!tb) return;
    const placed = new Set([...doc.sessions.flatMap((s) => s.entries), ...doc.unassignedEntries].map((e) => e.itemId));
    const ref = doc.textbooks.find((r) => r.textbookId === tbId);
    const entries: SessionEntry[] = tb.items
      .filter((it) => !it.excluded && !placed.has(it.id) && (!ref?.includedItemIds || ref.includedItemIds.includes(it.id)) && !ref?.excludedItemIds.includes(it.id))
      .sort((a, b) => a.order - b.order)
      .map((it) => ({ id: crypto.randomUUID(), textbookId: tbId, itemId: it.id, track: 'current', activity: it.usage === 'homework' ? 'homework' : 'new', minutes: it.minutes, portion: it.range ? { ...it.range } : undefined }));
    set({ unassignedEntries: [...doc.unassignedEntries, ...entries] });
  };

  const EntryCard = ({ e, inSession }: { e: SessionEntry; inSession: boolean }) => {
    const it = itemOf(e);
    const tb = tbMap.get(e.textbookId);
    return (
      <div
        className={`entry track-${e.track} ${e.activity === 'homework' ? 'hw' : ''} ${selected === e.id ? 'selected' : ''} ${dragId === e.id ? 'dragging' : ''}`}
        onClick={() => !readOnly && setSelected(e.id)}
        role="button"
        draggable={!readOnly}
        onDragStart={(ev) => {
          ev.dataTransfer.effectAllowed = 'move';
          ev.dataTransfer.setData('text/plain', e.id);
          setDragId(e.id);
        }}
        onDragEnd={() => {
          setDragId(null);
          setDropTarget(null);
        }}
        title={readOnly ? '' : '끌어서 다른 차시나 미배정 목록으로 옮길 수 있습니다'}
      >
        <div className="title">{it?.title ?? e.itemId}</div>
        <div className="muted">
          {tb?.title.replace(/^\[가상\]\s*/, '')} {it && e.portion ? rangeLabel(e.portion, it.progressUnit) : e.fraction !== undefined && e.fraction < 1 ? `${Math.round(e.fraction * 100)}%` : ''}
        </div>
        <div>
          {e.minutes}분 · {TRACK_LABEL[e.track]} · {ACTIVITY_LABEL[e.activity]}
          {e.repeatPurpose && <Badge kind="info">{e.repeatPurpose === 'review' ? '복습' : e.repeatPurpose === 'deepen' ? '심화' : '평가'}</Badge>}
          {it && !it.splittable && <Badge>분할 불가</Badge>}
        </div>
        {!inSession && !readOnly && (
          <div className="row mt" style={{ gap: 4 }}>
            <select
              className="sm"
              onChange={(ev) => {
                if (ev.target.value) setDoc(moveEntry(doc, e.id, ev.target.value));
              }}
              value=""
            >
              <option value="">차시로 이동…</option>
              {doc.sessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.order}차시
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      <div className="topbar">
        <h1>
          {isNew ? '과정 만들기' : doc.title} <SampleBadge show={doc.isSample} /> {!isNew && <Badge kind={STATUS[doc.status].kind}>v{doc.curriculumVersion} {STATUS[doc.status].label}</Badge>}
        </h1>
        <div className="row">
          <Link to="/curricula" className="btn">
            목록
          </Link>
          {!readOnly && !isNew && (
            <>
              <button onClick={async () => nav(`/curricula/${(await post<Curriculum>(`/api/curricula/${doc.id}/clone`)).id}`)}>복제</button>
              <button onClick={async () => setDoc(await post<Curriculum>(`/api/curricula/${doc.id}/publish`))} title="검증 완료로 표시하고 과정 버전을 올립니다">
                검증 완료·새 버전 발행
              </button>
            </>
          )}
          {!readOnly && (
            <button className="primary" disabled={busy} onClick={save}>
              저장
            </button>
          )}
        </div>
      </div>
      {error && <Alert kind="danger">{error}</Alert>}
      {msg && <Alert kind="ok">{msg}</Alert>}
      {readOnly && <Alert kind="info">표준과정은 관리자만 수정할 수 있습니다. 검토 의견은 남길 수 있습니다.</Alert>}

      <div className="panel">
        <h2>과정 정보</h2>
        <div className="grid cols-4">
          <Field label="과정명 *">
            <input value={doc.title} onChange={(e) => set({ title: e.target.value })} disabled={readOnly} />
          </Field>
          <Field label="대상">
            <input value={doc.target} onChange={(e) => set({ target: e.target.value })} disabled={readOnly} placeholder="예: 초5 기본반 (학생·반 등록 없이 작성 가능)" />
          </Field>
          <Field label="과목">
            <input value={doc.subject} onChange={(e) => set({ subject: e.target.value })} disabled={readOnly} />
          </Field>
          <Field label="구성 방식">
            <select value={doc.compositionMode} onChange={(e) => set({ compositionMode: e.target.value as Curriculum['compositionMode'] })} disabled={readOnly}>
              {Object.entries(COMPOSITION_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
          <Field label="권장 수업 빈도 (주당 회)">
            <input type="number" value={doc.recommendedPerWeek} onChange={(e) => set({ recommendedPerWeek: Number(e.target.value) })} disabled={readOnly} />
          </Field>
          <Field label="회당 수업시간(분)">
            <input type="number" value={doc.recommendedMinutesPerSession} onChange={(e) => set({ recommendedMinutesPerSession: Number(e.target.value) })} disabled={readOnly} />
          </Field>
          <Field label="회당 복습(분)">
            <input type="number" value={doc.reviewMinutesPerSession} onChange={(e) => set({ reviewMinutesPerSession: Number(e.target.value) })} disabled={readOnly} />
          </Field>
          <Field label="회당 여유(분)">
            <input type="number" value={doc.bufferMinutesPerSession} onChange={(e) => set({ bufferMinutesPerSession: Number(e.target.value) })} disabled={readOnly} />
          </Field>
          <Field label="N차시마다 평가 (0=없음)">
            <input type="number" value={doc.assessmentEvery} onChange={(e) => set({ assessmentEvery: Number(e.target.value) })} disabled={readOnly} />
          </Field>
          <Field label="검토 상태">
            <select value={doc.status} onChange={(e) => set({ status: e.target.value as Curriculum['status'] })} disabled={readOnly}>
              <option value="draft">초안</option>
              <option value="reviewing">검토 중</option>
              <option value="verified">검증됨</option>
            </select>
          </Field>
          <Field label="출처">
            <select value={doc.origin} onChange={(e) => set({ origin: e.target.value as Curriculum['origin'] })} disabled={readOnly}>
              <option value="custom">사용자 맞춤안</option>
              <option value="recommended">교재별 권장안</option>
            </select>
          </Field>
          <Field label="가상 샘플">
            <label className="check">
              <input type="checkbox" checked={doc.isSample} onChange={(e) => set({ isSample: e.target.checked })} disabled={readOnly} /> 샘플로 표시
            </label>
          </Field>
        </div>
        <Field label="목표">
          <textarea value={doc.goal} onChange={(e) => set({ goal: e.target.value })} disabled={readOnly} />
        </Field>
      </div>

      <div className="panel">
        <div className="row between">
          <h2>사용 교재 및 범위</h2>
          {!readOnly && (
            <select
              value=""
              onChange={(e) => {
                const tb = tbMap.get(e.target.value);
                if (tb && !doc.textbooks.some((r) => r.textbookId === tb.id)) set({ textbooks: [...doc.textbooks, { textbookId: tb.id, edition: tb.edition, textbookVersion: tb.version, role: doc.textbooks.length ? 'sub' : 'main', includedItemIds: null, excludedItemIds: [] }] });
              }}
            >
              <option value="">+ 교재 추가…</option>
              {(textbooks ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title} ({t.edition})
                </option>
              ))}
            </select>
          )}
        </div>
        {doc.textbooks.length === 0 && <Empty>교재를 추가하세요.</Empty>}
        {doc.textbooks.map((ref, idx) => {
          const tb = tbMap.get(ref.textbookId);
          return (
            <div key={ref.textbookId} className="panel tight">
              <div className="row between">
                <div>
                  <strong>{tb?.title ?? ref.textbookId}</strong> <span className="muted small">판본 {ref.edition} · 교재 v{ref.textbookVersion}</span>
                  {tb && tb.version !== ref.textbookVersion && <Badge kind="warn">교재가 v{tb.version}로 개정됨</Badge>}
                </div>
                {!readOnly && (
                  <div className="row">
                    <select value={ref.role} onChange={(e) => set({ textbooks: doc.textbooks.map((r, i) => (i === idx ? { ...r, role: e.target.value as typeof r.role } : r)) })}>
                      <option value="main">주교재</option>
                      <option value="sub">부교재</option>
                      <option value="supplement">보충</option>
                    </select>
                    <button className="sm" onClick={() => addItemsToUnassigned(ref.textbookId)}>
                      항목을 미배정 목록에 추가
                    </button>
                    <button className="sm" onClick={() => set({ textbooks: doc.textbooks.filter((_, i) => i !== idx) })}>
                      제거
                    </button>
                  </div>
                )}
              </div>
              {tb && (
                <details className="mt">
                  <summary className="small muted">포함·제외 범위 ({ref.includedItemIds ? `${ref.includedItemIds.length}개 선택` : '전체'}{ref.excludedItemIds.length ? `, 제외 ${ref.excludedItemIds.length}` : ''})</summary>
                  <div className="row small mt">
                    <button className="sm" disabled={readOnly} onClick={() => set({ textbooks: doc.textbooks.map((r, i) => (i === idx ? { ...r, includedItemIds: null } : r)) })}>
                      전체 포함
                    </button>
                    {[...new Set(tb.items.map((i) => i.unit))].map((u) => (
                      <button key={u} className="sm" disabled={readOnly} onClick={() => set({ textbooks: doc.textbooks.map((r, i) => (i === idx ? { ...r, includedItemIds: tb.items.filter((x) => x.unit === u).map((x) => x.id) } : r)) })}>
                        {u}만
                      </button>
                    ))}
                  </div>
                  <div className="row small mt">
                    {tb.items.map((it) => {
                      const inc = !ref.includedItemIds || ref.includedItemIds.includes(it.id);
                      const exc = ref.excludedItemIds.includes(it.id);
                      return (
                        <label key={it.id} className="check" style={{ opacity: it.excluded ? 0.4 : 1 }}>
                          <input
                            type="checkbox"
                            disabled={readOnly || it.excluded}
                            checked={inc && !exc}
                            onChange={(e) => {
                              const on = e.target.checked;
                              set({ textbooks: doc.textbooks.map((r, i) => (i === idx ? { ...r, excludedItemIds: on ? r.excludedItemIds.filter((x) => x !== it.id) : [...r.excludedItemIds, it.id], includedItemIds: on && r.includedItemIds && !r.includedItemIds.includes(it.id) ? [...r.includedItemIds, it.id] : r.includedItemIds } : r)) });
                            }}
                          />
                          {it.order}. {it.title}
                        </label>
                      );
                    })}
                  </div>
                </details>
              )}
            </div>
          );
        })}
      </div>

      <div className="panel">
        <div className="row between">
          <h2>
            과정 조립판 <span className="muted small">날짜 없이 차시에 배치 · {totals.sessions}차시 · {fmtMinutes(totals.minutes)} (회당 가능 {budget}분)</span>
          </h2>
          {!readOnly && (
            <div className="row">
              <button onClick={autoAssemble} disabled={busy || doc.textbooks.length === 0} title="구성 방식에 따라 차시를 자동으로 만듭니다 (기존 배치를 바꿉니다)">
                자동 구성
              </button>
              <button onClick={addSession}>+ 차시 추가</button>
            </div>
          )}
        </div>
        {sel && !readOnly && (
          <div className="panel tight" style={{ background: 'var(--primary-soft)' }}>
            <div className="row">
              <strong>선택: {itemOf(sel.entry)?.title}</strong>
              <button className="sm" onClick={() => moveSel(-1)} disabled={sel.sessionIdx <= 0}>
                ← 이전 차시
              </button>
              <button className="sm" onClick={() => moveSel(1)} disabled={sel.sessionIdx < 0 || sel.sessionIdx >= doc.sessions.length - 1}>
                다음 차시 →
              </button>
              <button className="sm" onClick={() => setDoc(moveEntry(doc, sel.entry.id, null))} disabled={sel.sessionIdx < 0}>
                미배정으로
              </button>
              <button
                className="sm"
                onClick={() => {
                  const s = doc.sessions[sel.sessionIdx];
                  const i = s.entries.findIndex((e) => e.id === sel.entry.id);
                  if (i > 0) setDoc(moveEntry(doc, sel.entry.id, s.id, i - 1));
                }}
                disabled={sel.sessionIdx < 0}
              >
                위로
              </button>
              <button
                className="sm"
                onClick={() => {
                  const s = doc.sessions[sel.sessionIdx];
                  const i = s.entries.findIndex((e) => e.id === sel.entry.id);
                  if (i < s.entries.length - 1) setDoc(moveEntry(doc, sel.entry.id, s.id, i + 1));
                }}
                disabled={sel.sessionIdx < 0}
              >
                아래로
              </button>
              <button className="sm" onClick={() => setSplitTarget(sel.entry)} disabled={!itemOf(sel.entry)?.splittable} title={itemOf(sel.entry)?.splittable ? '' : '분할 불가 항목'}>
                분할
              </button>
              <button className="sm" onClick={() => setMergeWith(mergeWith ? null : sel.entry.id)}>
                {mergeWith ? '묶기 취소' : '같은 항목 조각과 묶기'}
              </button>
              <select value={sel.entry.track} onChange={(e) => updateEntry(sel.entry.id, { track: e.target.value as Track })}>
                {Object.entries(TRACK_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
              <select value={sel.entry.activity} onChange={(e) => updateEntry(sel.entry.id, { activity: e.target.value as Activity })}>
                {Object.entries(ACTIVITY_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
              <select value={sel.entry.repeatPurpose ?? ''} onChange={(e) => updateEntry(sel.entry.id, { repeatPurpose: (e.target.value || undefined) as SessionEntry['repeatPurpose'] })} title="같은 목표가 여러 번 나올 때 목적">
                <option value="">반복 목적 없음</option>
                <option value="review">복습</option>
                <option value="deepen">심화</option>
                <option value="assessment">평가</option>
              </select>
              <input type="number" style={{ width: 70 }} value={sel.entry.minutes} onChange={(e) => updateEntry(sel.entry.id, { minutes: Number(e.target.value) })} />분
              <button
                className="sm"
                onClick={() => {
                  const it = itemOf(sel.entry);
                  if (!it) return;
                  const copy: SessionEntry = { ...sel.entry, id: crypto.randomUUID(), activity: 'review', repeatPurpose: 'review', minutes: Math.max(5, Math.round(sel.entry.minutes / 2)) };
                  set({ unassignedEntries: [...doc.unassignedEntries, copy] });
                }}
                title="같은 항목을 복습 목적으로 한 번 더 배치 (미배정 목록에 추가)"
              >
                복습으로 복제
              </button>
              <button className="sm danger" onClick={() => { set({ sessions: doc.sessions.map((s) => ({ ...s, entries: s.entries.filter((e) => e.id !== sel.entry.id) })), unassignedEntries: doc.unassignedEntries.filter((e) => e.id !== sel.entry.id) }); setSelected(null); }}>
                과정에서 빼기
              </button>
            </div>
            {mergeWith && <p className="small mt">묶을 다른 조각을 클릭하세요 (같은 학습항목만 가능).</p>}
          </div>
        )}
        {doc.sessions.length === 0 ? (
          <Empty>차시가 없습니다. '자동 구성'을 누르거나 차시를 추가해 미배정 항목을 배치하세요.</Empty>
        ) : (
          <div className="board">
            {doc.sessions.map((s) => {
              const m = sessionMinutes(s);
              return (
                <div className="session" key={s.id}>
                  <div className="head">
                    <span>
                      {s.title} <span className={`small ${m > budget ? 'badge danger' : 'muted'}`}>{m}분</span>
                      {s.marker && <Badge kind="info">{s.marker === 'assessment' ? '평가' : s.marker === 'review' ? '복습' : '여유'}</Badge>}
                    </span>
                    {!readOnly && (
                      <span className="row" style={{ gap: 2 }}>
                        <button className="sm" onClick={() => moveSession(s.id, -1)} title="앞으로">◀</button>
                        <button className="sm" onClick={() => moveSession(s.id, 1)} title="뒤로">▶</button>
                        <select value={s.marker ?? ''} onChange={(e) => set({ sessions: doc.sessions.map((x) => (x.id === s.id ? { ...x, marker: (e.target.value || undefined) as CurriculumSession['marker'] } : x)) })} title="복습·평가 위치">
                          <option value="">-</option>
                          <option value="review">복습</option>
                          <option value="assessment">평가</option>
                          <option value="buffer">여유</option>
                        </select>
                        <button className="sm" onClick={() => removeSession(s.id)} title="차시 삭제 (항목은 미배정으로)">×</button>
                      </span>
                    )}
                  </div>
                  <div
                    className={`body ${dropTarget === s.id ? 'drop-over' : ''}`}
                    onDragOver={(ev) => {
                      if (readOnly || !dragId) return;
                      ev.preventDefault();
                      setDropTarget(s.id);
                    }}
                    onDragLeave={() => setDropTarget((t) => (t === s.id ? null : t))}
                    onDrop={(ev) => {
                      ev.preventDefault();
                      dropTo(s.id);
                    }}
                  >
                    {s.entries.map((e, idx) => (
                      <div
                        key={e.id}
                        onDragOver={(ev) => {
                          if (readOnly || !dragId || dragId === e.id) return;
                          ev.preventDefault();
                          ev.stopPropagation();
                          setDropTarget(`${s.id}:${idx}`);
                        }}
                        onDrop={(ev) => {
                          ev.preventDefault();
                          ev.stopPropagation();
                          dropTo(s.id, idx);
                        }}
                        className={dropTarget === `${s.id}:${idx}` ? 'drop-before' : ''}
                        onClick={() => {
                          if (mergeWith && mergeWith !== e.id) {
                            try {
                              setDoc(mergeEntries(doc, mergeWith, e.id));
                              setMergeWith(null);
                              setSelected(mergeWith);
                            } catch (err) {
                              setError(errorMessage(err));
                            }
                          }
                        }}
                      >
                        <EntryCard e={e} inSession />
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <h3 className="mt">
          미배정 항목 <span className="muted small">{doc.unassignedEntries.length}건 · {fmtMinutes(totals.unassignedMinutes)}</span>
        </h3>
        <div
          className={`unassigned-drop ${dropTarget === 'unassigned' ? 'drop-over' : ''}`}
          onDragOver={(ev) => {
            if (readOnly || !dragId) return;
            ev.preventDefault();
            setDropTarget('unassigned');
          }}
          onDragLeave={() => setDropTarget((t) => (t === 'unassigned' ? null : t))}
          onDrop={(ev) => {
            ev.preventDefault();
            dropTo(null);
          }}
        >
          {doc.unassignedEntries.length === 0 ? (
            <p className="muted small">없음{!readOnly ? ' · 카드를 여기로 끌어 놓으면 미배정으로 돌아갑니다' : ''}</p>
          ) : (
            <div className="grid cols-4">
              {doc.unassignedEntries.map((e) => (
                <EntryCard key={e.id} e={e} inSession={false} />
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="panel">
        <h2>선행 과정 설정 (선택)</h2>
        {!doc.advance ? (
          !readOnly && <button onClick={() => set({ advance: { type: 'next_semester', currentGrade: '', actualStage: '', targetDescription: '', targetDate: '', currentMinMinutes: 0, requiredObjectiveIds: [], prerequisitesConfirmed: false } })}>선행 설정 추가</button>
        ) : (
          <div className="grid cols-4">
            <Field label="선행 유형">
              <select value={doc.advance.type} disabled={readOnly} onChange={(e) => set({ advance: { ...doc.advance!, type: e.target.value as NonNullable<Curriculum['advance']>['type'] } })}>
                {Object.entries(ADVANCE_TYPE_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="현재 학년">
              <input value={doc.advance.currentGrade} disabled={readOnly} onChange={(e) => set({ advance: { ...doc.advance!, currentGrade: e.target.value } })} />
            </Field>
            <Field label="실제 학습 단계" hint="학년 진급만으로 자동 변경하지 않습니다">
              <input value={doc.advance.actualStage} disabled={readOnly} onChange={(e) => set({ advance: { ...doc.advance!, actualStage: e.target.value } })} />
            </Field>
            <Field label="목표 (학년·학기 / 영역·교재·단원)">
              <input value={doc.advance.targetDescription} disabled={readOnly} onChange={(e) => set({ advance: { ...doc.advance!, targetDescription: e.target.value } })} />
            </Field>
            <Field label="목표 완료일">
              <input type="date" value={doc.advance.targetDate} disabled={readOnly} onChange={(e) => set({ advance: { ...doc.advance!, targetDate: e.target.value } })} />
            </Field>
            <Field label="현행에 반드시 확보할 시간 (회당 분)" hint="선행 목표일을 맞추려고 현행 수업을 자동으로 줄이지 않습니다">
              <input type="number" value={doc.advance.currentMinMinutes} disabled={readOnly} onChange={(e) => set({ advance: { ...doc.advance!, currentMinMinutes: Number(e.target.value) } })} />
            </Field>
            <Field label="필요한 기초 개념·확인 항목 (학습목표)">
              <select multiple size={4} value={doc.advance.requiredObjectiveIds} disabled={readOnly} onChange={(e) => set({ advance: { ...doc.advance!, requiredObjectiveIds: [...e.target.selectedOptions].map((o) => o.value) } })}>
                {(objectives ?? []).map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.code} {o.title} {o.prerequisiteVerified ? '' : '(선수관계 미확인)'}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="기초 확인 (담당자 확정)">
              <label className="check">
                <input type="checkbox" checked={doc.advance.prerequisitesConfirmed} disabled={readOnly} onChange={(e) => set({ advance: { ...doc.advance!, prerequisitesConfirmed: e.target.checked, prerequisitesConfirmedBy: e.target.checked ? user?.displayName : undefined, prerequisitesConfirmedAt: e.target.checked ? new Date().toISOString() : undefined } })} /> 담당자가 기초 개념을 확인했음
              </label>
              {doc.advance.prerequisitesConfirmedBy && <small className="muted">{doc.advance.prerequisitesConfirmedBy} · {doc.advance.prerequisitesConfirmedAt?.slice(0, 10)}</small>}
              {!readOnly && (
                <button className="sm mt" onClick={() => set({ advance: undefined })}>
                  선행 설정 제거
                </button>
              )}
            </Field>
          </div>
        )}
      </div>

      {!isNew && (
        <div className="panel">
          <h2>검토 의견</h2>
          {doc.reviewComments.length === 0 && <p className="muted small">아직 의견이 없습니다.</p>}
          {doc.reviewComments.map((c) => (
            <div key={c.id} className="small" style={{ borderBottom: '1px solid var(--line)', padding: '4px 0' }}>
              <strong>{c.by}</strong> <span className="muted">{c.at.slice(0, 16).replace('T', ' ')}</span>
              <div>{c.text}</div>
            </div>
          ))}
          <div className="row mt">
            <input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="검토 의견" style={{ flex: 1 }} />
            <button
              onClick={async () => {
                try {
                  setDoc(await post<Curriculum>(`/api/curricula/${doc.id}/comments`, { text: comment }));
                  setComment('');
                } catch (e) {
                  setError(errorMessage(e));
                }
              }}
              disabled={!comment.trim()}
            >
              남기기
            </button>
          </div>
        </div>
      )}
      {splitTarget && (
        <SplitModal
          entry={splitTarget}
          onClose={() => setSplitTarget(null)}
          onSplit={(firstMinutes) => {
            const it = itemOf(splitTarget);
            if (!it) return;
            try {
              setDoc(splitEntry(doc, splitTarget.id, it, firstMinutes));
              setSplitTarget(null);
            } catch (e) {
              setError(errorMessage(e));
              setSplitTarget(null);
            }
          }}
        />
      )}
    </>
  );
}

function SplitModal({ entry, onClose, onSplit }: { entry: SessionEntry; onClose: () => void; onSplit: (firstMinutes: number) => void }) {
  const [m, setM] = useState(Math.floor(entry.minutes / 2 / 5) * 5 || 5);
  return (
    <Modal title="항목 분할" onClose={onClose}>
      <p className="small">전체 {entry.minutes}분 중 앞부분에 둘 시간을 정하세요. 범위형 항목은 시간 비율로 쪽·문항을 나눕니다.</p>
      <div className="row">
        <input type="number" value={m} min={5} max={entry.minutes - 5} step={5} onChange={(e) => setM(Number(e.target.value))} />분 / 뒷부분 {entry.minutes - m}분
        <button className="primary" onClick={() => onSplit(m)} disabled={m <= 0 || m >= entry.minutes}>
          분할
        </button>
      </div>
    </Modal>
  );
}
