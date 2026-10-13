import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { AppSettings, ImportPreview, LearningItem, LearningObjective, ProgressUnit, Textbook, TimingSuggestion } from '@wb/shared';
import { PROGRESS_UNIT_LABEL, isRangedUnit, itemQuantity, parseToc } from '@wb/shared';
import { extractPdfLines, renderPdfPages } from '../pdfText.ts';
import { recognizeImages } from '../ocr.ts';
import { RemoteChangeBanner, useRemoteVersion } from '../components/RemoteChange.tsx';
import { get, post, put, errorMessage } from '../api.ts';
import { useAuth } from '../auth.tsx';
import { Alert, Badge, Empty, Field, Loading, Modal, SampleBadge, useAsync, useUnsavedWarning } from '../components/ui.tsx';

const VERIFY: Record<string, { label: string; kind: string }> = { unverified: { label: '미확인', kind: 'danger' }, reviewing: { label: '검토 중', kind: 'warn' }, verified: { label: '확인', kind: 'ok' } };

export function TextbooksPage() {
  const { user } = useAuth();
  const [showArchived, setShowArchived] = useState(false);
  const [q, setQ] = useState('');
  const { data, loading, error } = useAsync(() => get<Textbook[]>(`/api/textbooks${showArchived ? '?archived=1' : ''}`), [showArchived]);
  const rows = (data ?? []).filter((t) => !q || t.title.includes(q) || t.publisher.includes(q) || t.subject.includes(q));
  return (
    <>
      <div className="topbar">
        <h1>교재 보관함</h1>
        <div className="row">
          <input placeholder="검색" value={q} onChange={(e) => setQ(e.target.value)} />
          <label className="check">
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> 보관 포함
          </label>
          {user?.role === 'admin' && (
            <Link className="btn primary" to="/textbooks/new">
              + 교재 등록
            </Link>
          )}
        </div>
      </div>
      {error && <Alert kind="danger">{error}</Alert>}
      <div className="panel tight">
        {loading ? (
          <Loading />
        ) : rows.length === 0 ? (
          <Empty>등록된 교재가 없습니다.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>교재</th>
                  <th>구분</th>
                  <th>과목·학년</th>
                  <th>판본</th>
                  <th className="num">학습항목</th>
                  <th className="num">예상 시간</th>
                  <th>정보 확인</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <Link to={`/textbooks/${t.id}`}>{t.title}</Link> <SampleBadge show={t.isSample} /> {t.archived && <Badge>보관</Badge>}
                      <div className="muted small">{t.publisher}</div>
                    </td>
                    <td>{t.kind === 'market' ? '시중' : '자체'}</td>
                    <td>
                      {t.subject} · {t.schoolLevel}
                      {t.grade}
                      {t.semester ? `-${t.semester}` : ''} {t.stage}
                    </td>
                    <td>{t.edition}</td>
                    <td className="num">{t.items.filter((i) => !i.excluded).length}</td>
                    <td className="num">{t.items.filter((i) => !i.excluded).reduce((s, i) => s + i.minutes, 0)}분</td>
                    <td>
                      <Badge kind={VERIFY[t.verification].kind}>{VERIFY[t.verification].label}</Badge>
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

function blankTextbook(): Textbook {
  const at = new Date().toISOString();
  return {
    id: '',
    kind: 'market',
    title: '',
    publisher: '',
    subject: '독해',
    schoolLevel: '초',
    grade: '',
    semester: '',
    stage: '',
    edition: '',
    verification: 'unverified',
    usageNote: '',
    pdfPageOffset: 0,
    excludedRanges: [],
    items: [],
    defaultUnit: 'page',
    createdAt: at,
    createdBy: '',
    updatedAt: at,
    updatedBy: '',
    version: 0,
    archived: false,
    isSample: false,
  };
}

function blankItem(order: number, unit: ProgressUnit): LearningItem {
  return { id: crypto.randomUUID(), unit: '', subunit: '', order, title: '', objective: '', objectiveIds: [], progressUnit: unit, range: isRangedUnit(unit) ? { from: 1, to: 1 } : undefined, quantity: 1, minutes: 30, minutesSource: 'entered', splittable: true, prerequisiteItemIds: [], usage: 'both', excluded: false, extra: {} };
}

export function TextbookEditorPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const { user } = useAuth();
  const isNew = id === 'new';
  const [doc, setDoc] = useState<Textbook | null>(isNew ? blankTextbook() : null);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const { data: settings } = useAsync(() => get<AppSettings>('/api/settings'), []);
  const { data: objectives } = useAsync(() => get<LearningObjective[]>('/api/objectives'), []);
  const attachments = useAsync(() => get<Textbook[]>('/api/textbooks?archived=1'), [], [doc?.version]);
  const readOnly = user?.role !== 'admin';
  // 마지막으로 불러오거나 저장한 상태 (편집 중인지 판단용)
  const [baseline, setBaseline] = useState('');
  const loaded = (t: Textbook) => {
    setDoc(t);
    setBaseline(JSON.stringify(t));
  };
  const remote = useRemoteVersion('textbook', isNew ? undefined : id, doc?.version);
  useUnsavedWarning(!!doc && !!baseline && JSON.stringify(doc) !== baseline);
  const reloadLatest = () =>
    get<Textbook>(`/api/textbooks/${id}`)
      .then(loaded)
      .then(() => {
        setError('');
        setMsg('최신 버전을 불러왔습니다.');
      })
      .catch((e) => setError(errorMessage(e)));

  useEffect(() => {
    if (!isNew && id) get<Textbook>(`/api/textbooks/${id}`).then(loaded).catch((e) => setError(errorMessage(e)));
  }, [id, isNew]);

  const subjectFields = useMemo(() => {
    if (!settings || !doc) return [];
    const bySubject = settings.subjectFields.find((s) => s.subject === doc.subject)?.fields ?? [];
    const inhouse = doc.kind === 'inhouse' ? settings.subjectFields.find((s) => s.subject === '자체')?.fields ?? [] : [];
    const merged = [...bySubject, ...inhouse];
    return merged.filter((f, i) => merged.findIndex((g) => g.key === f.key) === i);
  }, [settings, doc?.subject, doc?.kind]);
  const attachmentGroups = useMemo(() => (attachments.data ?? [])
    .filter((tb) => !tb.archived && tb.id !== doc?.id)
    .map((tb) => ({ ...tb, items: tb.items.filter((it) => !it.excluded && !doc?.items.some((own) => own.id === it.id)).sort((a, b) => a.order - b.order) }))
    .filter((tb) => tb.items.length > 0), [attachments.data, doc?.id, doc?.items]);
  const attachmentIds = new Set(attachmentGroups.flatMap((tb) => tb.items.map((it) => it.id)));

  if (error && !doc) return <Alert kind="danger">{error}</Alert>;
  if (!doc) return <Loading />;

  const set = (patch: Partial<Textbook>) => setDoc({ ...doc, ...patch });
  const setItem = (idx: number, patch: Partial<LearningItem>) => set({ items: doc.items.map((it, i) => (i === idx ? { ...it, ...patch } : it)) });
  const totalMinutes = doc.items.filter((i) => !i.excluded).reduce((s, i) => s + i.minutes, 0);

  const save = async () => {
    setBusy(true);
    setError('');
    setMsg('');
    try {
      const payload = { ...doc, items: doc.items.map((it, i) => ({ ...it, order: it.order || i + 1 })) };
      const res = isNew ? await post<Textbook>('/api/textbooks', payload) : await put<Textbook & { warnings?: string[] }>(`/api/textbooks/${doc.id}`, payload);
      const { warnings, ...saved } = res as Textbook & { warnings?: string[] };
      loaded(saved);
      setMsg(warnings?.length ? `저장했습니다. 확인할 것: ${warnings.join(' ')}` : '저장했습니다.');
      if (isNew) nav(`/textbooks/${saved.id}`, { replace: true });
    } catch (e) {
      setError(errorMessage(e));
      if ((e as { status?: number }).status === 409 && !isNew) {
        const latest = await get<Textbook>(`/api/textbooks/${doc.id}`);
        setError(`다른 사용자가 먼저 수정했습니다 (v${latest.version}). 아래 '최신 버전 불러오기'를 누르면 내 변경이 사라집니다.`);
      }
    } finally {
      setBusy(false);
    }
  };

  const dirty = !!baseline && JSON.stringify(doc) !== baseline;
  // 복제·보관은 저장된 내용을 대상으로 하므로, 고친 내용이 있으면 먼저 저장하게 한다 (화면의 편집이 말없이 사라지지 않게)
  const runSaved = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const clone = () =>
    runSaved(async () => {
      const c = await post<Textbook>(`/api/textbooks/${doc.id}/clone`);
      nav(`/textbooks/${c.id}`);
    });
  const archive = (archived: boolean) =>
    runSaved(async () => {
      loaded(await post<Textbook>(`/api/textbooks/${doc.id}/archive`, { archived }));
    });
  const needSave = dirty ? '고친 내용을 먼저 저장하세요' : undefined;

  return (
    <>
      <div className="topbar">
        <h1>
          {isNew ? '교재 등록' : doc.title} <SampleBadge show={doc.isSample} /> {doc.archived && <Badge>보관</Badge>}
        </h1>
        <div className="row">
          <Link to="/textbooks" className="btn">
            목록
          </Link>
          {!readOnly && !isNew && (
            <>
              <button onClick={clone} disabled={busy || dirty} title={needSave}>
                복제
              </button>
              <button onClick={() => archive(!doc.archived)} disabled={busy || dirty} title={needSave}>
                {doc.archived ? '보관 해제' : '보관'}
              </button>
              <button onClick={() => setImportOpen(true)}>표·목차·PDF 가져오기</button>
            </>
          )}
          {!readOnly && isNew && <button onClick={() => setImportOpen(true)}>표·목차·PDF 가져오기</button>}
          {!readOnly && (
            <button className="primary" disabled={busy} onClick={save}>
              저장 {doc.version ? `(v${doc.version})` : ''}
            </button>
          )}
        </div>
      </div>
      {error && (
        <Alert kind="danger">
          {error}
          {error.includes('먼저 수정') && (
            <div>
              <button className="sm" onClick={reloadLatest}>
                최신 버전 불러오기
              </button>
            </div>
          )}
        </Alert>
      )}
      {!error && <RemoteChangeBanner remote={remote} localVersion={doc.version} dirty={dirty} onReload={reloadLatest} />}
      {msg && <Alert kind="ok">{msg}</Alert>}
      {readOnly && <Alert kind="info">교재는 관리자만 수정할 수 있습니다. (읽기 전용)</Alert>}

      <div className="panel">
        <h2>기본 정보</h2>
        <div className="grid cols-4">
          <Field label="교재 구분">
            <select value={doc.kind} onChange={(e) => set({ kind: e.target.value as Textbook['kind'] })} disabled={readOnly}>
              <option value="market">시중교재</option>
              <option value="inhouse">자체교재</option>
            </select>
          </Field>
          <Field label="교재명 *">
            <input value={doc.title} onChange={(e) => set({ title: e.target.value })} disabled={readOnly} />
          </Field>
          <Field label={doc.kind === 'market' ? '출판사' : '제작자'}>
            <input value={doc.publisher} onChange={(e) => set({ publisher: e.target.value })} disabled={readOnly} />
          </Field>
          <Field label="과목">
            <input list="subjects" value={doc.subject} onChange={(e) => set({ subject: e.target.value })} disabled={readOnly} />
            <datalist id="subjects">
              {['독해', '국어', '영어', '수학', '기타'].map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          </Field>
          <Field label="학교급">
            <select value={doc.schoolLevel} onChange={(e) => set({ schoolLevel: e.target.value as Textbook['schoolLevel'] })} disabled={readOnly}>
              {['초', '중', '고', '공통'].map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </Field>
          <Field label="학년">
            <input value={doc.grade} onChange={(e) => set({ grade: e.target.value })} disabled={readOnly} />
          </Field>
          <Field label="학기">
            <input value={doc.semester} onChange={(e) => set({ semester: e.target.value })} disabled={readOnly} />
          </Field>
          <Field label="단계">
            <input value={doc.stage} onChange={(e) => set({ stage: e.target.value })} disabled={readOnly} />
          </Field>
          <Field label={doc.kind === 'market' ? '판본·개정연도' : '자체교재 버전'}>
            <input value={doc.edition} onChange={(e) => set({ edition: e.target.value })} disabled={readOnly} />
          </Field>
          <Field label="ISBN (선택)">
            <input value={doc.isbn ?? ''} onChange={(e) => set({ isbn: e.target.value })} disabled={readOnly} />
          </Field>
          <Field label="자료 출처·연결 주소 (선택)">
            <input value={doc.sourceUrl ?? ''} onChange={(e) => set({ sourceUrl: e.target.value })} disabled={readOnly} />
          </Field>
          <Field label="정보 확인 상태">
            <select value={doc.verification} onChange={(e) => set({ verification: e.target.value as Textbook['verification'] })} disabled={readOnly}>
              <option value="unverified">미확인</option>
              <option value="reviewing">검토 중</option>
              <option value="verified">확인</option>
            </select>
          </Field>
          <Field label="기본 진도 단위 (완료율 집계)">
            <select value={doc.defaultUnit} onChange={(e) => set({ defaultUnit: e.target.value as ProgressUnit })} disabled={readOnly}>
              {Object.entries(PROGRESS_UNIT_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
          <Field label="PDF 페이지 보정 (PDF쪽 − 인쇄쪽)" hint="인쇄된 쪽수와 PDF 파일 페이지 번호를 구분합니다">
            <input type="number" value={doc.pdfPageOffset} onChange={(e) => set({ pdfPageOffset: Number(e.target.value) })} disabled={readOnly} />
          </Field>
          <Field label="가상 샘플 데이터">
            <label className="check">
              <input type="checkbox" checked={doc.isSample} onChange={(e) => set({ isSample: e.target.checked })} disabled={readOnly} /> 샘플로 표시
            </label>
          </Field>
        </div>
        <Field label="사용 범위·이용 권한 메모">
          <textarea value={doc.usageNote} onChange={(e) => set({ usageNote: e.target.value })} disabled={readOnly} />
        </Field>
      </div>

      <div className="panel">
        <div className="row between">
          <h2>제외 범위 (정답·해설·부록 등)</h2>
          {!readOnly && (
            <button className="sm" onClick={() => set({ excludedRanges: [...doc.excludedRanges, { id: crypto.randomUUID(), label: '', range: { from: 0, to: 0 } }] })}>
              + 추가
            </button>
          )}
        </div>
        {doc.excludedRanges.length === 0 ? (
          <p className="muted small">없음</p>
        ) : (
          <div className="table-wrap">
            <table className="compact">
              <thead>
                <tr>
                  <th>이름</th>
                  <th>시작</th>
                  <th>끝</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {doc.excludedRanges.map((r, i) => (
                  <tr key={r.id}>
                    <td>
                      <input value={r.label} disabled={readOnly} onChange={(e) => set({ excludedRanges: doc.excludedRanges.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} />
                    </td>
                    <td>
                      <input type="number" value={r.range.from} disabled={readOnly} onChange={(e) => set({ excludedRanges: doc.excludedRanges.map((x, j) => (j === i ? { ...x, range: { ...x.range, from: Number(e.target.value) } } : x)) })} />
                    </td>
                    <td>
                      <input type="number" value={r.range.to} disabled={readOnly} onChange={(e) => set({ excludedRanges: doc.excludedRanges.map((x, j) => (j === i ? { ...x, range: { ...x.range, to: Number(e.target.value) } } : x)) })} />
                    </td>
                    <td>{!readOnly && <button className="sm" onClick={() => set({ excludedRanges: doc.excludedRanges.filter((_, j) => j !== i) })}>삭제</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="panel">
        <div className="row between">
          <h2>
            학습항목 <span className="muted small">{doc.items.length}개 · 예상 {totalMinutes}분 (제외 항목 미포함)</span>
          </h2>
          {!readOnly && (
            <div className="row">
              <button className="sm" onClick={() => set({ items: [...doc.items, blankItem(doc.items.length + 1, doc.defaultUnit)] })}>
                + 행 추가
              </button>
            </div>
          )}
        </div>
        <p className="muted small">쪽·문항 등 범위형 단위는 시작~끝(양 끝 포함)으로 수량을 계산합니다. 12~23쪽 = 12쪽. 예상 소요시간은 직접 입력값과 추정값을 구분해 표시합니다.</p>
        <p className="muted small">보충 연결은 다른 교재의 항목을 제목으로 선택합니다. 보충형 과정에 그 교재를 주교재로 넣으면 선택한 항목 뒤에 붙습니다.</p>
        {attachments.error ? (
          <Alert kind="warn">보충 연결 목록을 불러오지 못했습니다. {attachments.error} <button className="sm" onClick={attachments.reload}>다시 불러오기</button></Alert>
        ) : attachments.loading ? (
          <p className="muted small">보충 연결 목록을 불러오는 중…</p>
        ) : attachmentGroups.length === 0 && <p className="muted small">연결할 다른 교재의 학습항목이 없습니다. 주교재를 등록하고 제외하지 않은 항목을 추가하세요.</p>}
        {doc.items.length === 0 ? (
          <Empty>학습항목이 없습니다. 행을 추가하거나 표를 붙여넣어 가져오세요. 교재명만으로 목차를 자동 생성하지 않습니다.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="compact">
              <thead>
                <tr>
                  <th>순서</th>
                  <th>대단원</th>
                  <th>소단원</th>
                  <th>제목 *</th>
                  <th>학습 목표</th>
                  <th>목표 연결</th>
                  <th>단위</th>
                  <th>시작</th>
                  <th>끝</th>
                  <th>수량</th>
                  <th>분 *</th>
                  <th>출처</th>
                  <th>난이도</th>
                  <th>분할</th>
                  <th>선수 항목</th>
                  <th>용도</th>
                  <th>보충 연결</th>
                  {subjectFields.map((f) => (
                    <th key={f.key}>{f.label}</th>
                  ))}
                  <th>준비물</th>
                  <th>지도 메모</th>
                  <th>제외</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {doc.items.map((it, i) => (
                  <tr key={it.id} style={it.excluded ? { opacity: 0.5 } : undefined}>
                    <td style={{ width: 56 }}>
                      <input type="number" value={it.order} disabled={readOnly} onChange={(e) => setItem(i, { order: Number(e.target.value) })} />
                    </td>
                    <td style={{ minWidth: 110 }}>
                      <input value={it.unit} disabled={readOnly} onChange={(e) => setItem(i, { unit: e.target.value })} />
                    </td>
                    <td style={{ minWidth: 100 }}>
                      <input value={it.subunit} disabled={readOnly} onChange={(e) => setItem(i, { subunit: e.target.value })} />
                    </td>
                    <td style={{ minWidth: 150 }}>
                      <input value={it.title} disabled={readOnly} onChange={(e) => setItem(i, { title: e.target.value })} />
                    </td>
                    <td style={{ minWidth: 150 }}>
                      <input value={it.objective} disabled={readOnly} onChange={(e) => setItem(i, { objective: e.target.value })} />
                    </td>
                    <td style={{ minWidth: 140 }}>
                      <select multiple size={2} value={it.objectiveIds} disabled={readOnly} onChange={(e) => setItem(i, { objectiveIds: [...e.target.selectedOptions].map((o) => o.value) })}>
                        {(objectives ?? []).map((o) => (
                          <option key={o.id} value={o.id}>
                            {o.code} {o.title}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <select value={it.progressUnit} disabled={readOnly} onChange={(e) => setItem(i, { progressUnit: e.target.value as ProgressUnit, range: isRangedUnit(e.target.value as ProgressUnit) ? it.range ?? { from: 1, to: 1 } : undefined })}>
                        {Object.entries(PROGRESS_UNIT_LABEL).map(([k, v]) => (
                          <option key={k} value={k}>
                            {v}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td style={{ width: 70 }}>{isRangedUnit(it.progressUnit) && <input type="number" value={it.range?.from ?? ''} disabled={readOnly} onChange={(e) => setItem(i, { range: { from: Number(e.target.value), to: it.range?.to ?? Number(e.target.value) } })} />}</td>
                    <td style={{ width: 70 }}>{isRangedUnit(it.progressUnit) && <input type="number" value={it.range?.to ?? ''} disabled={readOnly} onChange={(e) => setItem(i, { range: { from: it.range?.from ?? Number(e.target.value), to: Number(e.target.value) } })} />}</td>
                    <td style={{ width: 70 }} className="num">
                      {isRangedUnit(it.progressUnit) ? <span className="muted">{itemQuantity(it)}</span> : <input type="number" value={it.quantity} disabled={readOnly} onChange={(e) => setItem(i, { quantity: Number(e.target.value) })} />}
                    </td>
                    <td style={{ width: 70 }}>
                      <input type="number" value={it.minutes} disabled={readOnly} onChange={(e) => setItem(i, { minutes: Number(e.target.value), minutesSource: 'entered' })} />
                    </td>
                    <td>
                      <Badge kind={it.minutesSource === 'entered' ? 'ok' : 'warn'}>{it.minutesSource === 'entered' ? '입력' : '추정'}</Badge>
                    </td>
                    <td>
                      <select value={it.difficulty ?? ''} disabled={readOnly} onChange={(e) => setItem(i, { difficulty: e.target.value ? (Number(e.target.value) as LearningItem['difficulty']) : undefined })}>
                        <option value="">-</option>
                        {[1, 2, 3, 4, 5].map((d) => (
                          <option key={d} value={d}>
                            {d}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input type="checkbox" checked={it.splittable} disabled={readOnly} onChange={(e) => setItem(i, { splittable: e.target.checked })} />
                    </td>
                    <td style={{ minWidth: 140 }}>
                      <select multiple size={2} value={it.prerequisiteItemIds} disabled={readOnly} onChange={(e) => setItem(i, { prerequisiteItemIds: [...e.target.selectedOptions].map((o) => o.value) })}>
                        {doc.items
                          .filter((o) => o.id !== it.id)
                          .map((o) => (
                            <option key={o.id} value={o.id}>
                              {o.order}. {o.title}
                            </option>
                          ))}
                      </select>
                    </td>
                    <td>
                      <select value={it.usage} disabled={readOnly} onChange={(e) => setItem(i, { usage: e.target.value as LearningItem['usage'] })}>
                        <option value="both">수업·숙제</option>
                        <option value="class">수업만</option>
                        <option value="homework">숙제만</option>
                      </select>
                    </td>
                    <td style={{ minWidth: 180 }}>
                      <select value={it.attachToItemId ?? ''} disabled={readOnly || attachments.loading || !!attachments.error} onChange={(e) => setItem(i, { attachToItemId: e.target.value || undefined })} aria-label={`${it.title || `${i + 1}번 항목`} 보충 연결`}>
                        <option value="">연결 안 함</option>
                        {it.attachToItemId && !attachmentIds.has(it.attachToItemId) && (() => {
                          const targetBook = [doc, ...(attachments.data ?? [])].find((tb) => tb.items.some((item) => item.id === it.attachToItemId));
                          const target = targetBook?.items.find((item) => item.id === it.attachToItemId);
                          const state = targetBook?.id === doc.id ? '같은 교재' : targetBook?.archived ? '보관' : target?.excluded ? '제외' : '목록에 없음';
                          return <option value={it.attachToItemId} disabled>{target ? `${targetBook?.title} · ${target.order}. ${target.title} (${state})` : '기존 연결 · 항목을 찾을 수 없음'}</option>;
                        })()}
                        {attachmentGroups.map((tb) => (
                          <optgroup key={tb.id} label={`${tb.title}${tb.edition ? ` · ${tb.edition}` : ''}`}>
                            {tb.items.map((target) => <option key={target.id} value={target.id}>{target.order}. {target.title}{target.range ? ` (${target.range.from}~${target.range.to}${PROGRESS_UNIT_LABEL[target.progressUnit]})` : ''}</option>)}
                          </optgroup>
                        ))}
                      </select>
                    </td>
                    {subjectFields.map((f) => (
                      <td key={f.key} style={{ minWidth: 100 }}>
                        <input value={it.extra[f.key] ?? ''} disabled={readOnly} onChange={(e) => setItem(i, { extra: { ...it.extra, [f.key]: e.target.value } })} />
                      </td>
                    ))}
                    <td style={{ minWidth: 100 }}>
                      <input value={it.materials ?? ''} disabled={readOnly} onChange={(e) => setItem(i, { materials: e.target.value })} />
                    </td>
                    <td style={{ minWidth: 120 }}>
                      <input value={it.teachingNote ?? ''} disabled={readOnly} onChange={(e) => setItem(i, { teachingNote: e.target.value })} />
                    </td>
                    <td>
                      <input type="checkbox" checked={it.excluded} disabled={readOnly} onChange={(e) => setItem(i, { excluded: e.target.checked })} />
                    </td>
                    <td className="nowrap">
                      {!readOnly && (
                        <>
                          <button className="sm" title="위로" disabled={i === 0} onClick={() => { const items = [...doc.items]; [items[i - 1], items[i]] = [items[i], items[i - 1]]; set({ items: items.map((x, k) => ({ ...x, order: k + 1 })) }); }}>↑</button>
                          <button className="sm" title="삭제" onClick={() => set({ items: doc.items.filter((_, j) => j !== i) })}>×</button>
                        </>
                      )}
                      <div className="muted" style={{ fontSize: 10 }}>{it.id.slice(0, 8)}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {!isNew && (
        <TimingPanel
          textbookId={doc.id}
          version={doc.version}
          readOnly={readOnly}
          onApply={(itemId, minutes) => set({ items: doc.items.map((it) => (it.id === itemId ? { ...it, minutes, minutesSource: 'entered' } : it)) })}
        />
      )}
      {importOpen && (
        <ImportModal
          defaultUnit={doc.defaultUnit}
          onClose={() => setImportOpen(false)}
          onApply={(items, mode) => {
            const base = mode === 'replace' ? [] : doc.items;
            set({ items: [...base, ...items.map((it, i) => ({ ...it, order: base.length + i + 1 }))] });
            setImportOpen(false);
          }}
        />
      )}
    </>
  );
}

function TimingPanel({ textbookId, version, readOnly, onApply }: { textbookId: string; version: number; readOnly: boolean; onApply: (itemId: string, minutes: number) => void }) {
  const { data, loading } = useAsync(() => get<{ suggestions: TimingSuggestion[]; planCount: number; rule: string }>(`/api/textbooks/${textbookId}/time-suggestions`), [textbookId], [version]);
  const [applied, setApplied] = useState<Set<string>>(new Set());
  if (loading || !data) return null;
  return (
    <div className="panel">
      <h2>실제 소요시간 기반 개선 제안</h2>
      <p className="muted small">{data.rule} 이 교재를 쓰는 계획 {data.planCount}개를 집계했습니다.</p>
      {data.suggestions.length === 0 ? (
        <p className="muted small">아직 실제 분이 입력된 완료 기록이 없습니다. 진도 기록에서 '완료' 옆에 실제 분을 적으면 쌓입니다.</p>
      ) : (
        <div className="table-wrap">
          <table className="compact">
            <thead>
              <tr>
                <th>학습항목</th>
                <th className="num">현재(분)</th>
                <th className="num">실제 중앙값</th>
                <th className="num">기록</th>
                <th>판단</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {data.suggestions.map((s) => (
                <tr key={s.itemId}>
                  <td>
                    {s.title} <Badge kind={s.minutesSource === 'entered' ? 'ok' : 'warn'}>{s.minutesSource === 'entered' ? '입력' : '추정'}</Badge>
                  </td>
                  <td className="num">{s.currentMinutes}</td>
                  <td className="num">{s.medianMinutes}</td>
                  <td className="num" title={s.samples.map((x) => `${x.date} ${x.planTitle}: ${x.actualMinutes}분 (비율 ${Math.round(x.share * 100)}% → ${x.scaledMinutes}분)`).join('\n')}>
                    {s.samples.length}
                  </td>
                  <td className="small">{s.reason}</td>
                  <td>
                    {s.suggestedMinutes !== null && !readOnly && (
                      <button
                        className="sm"
                        disabled={applied.has(s.itemId)}
                        onClick={() => {
                          onApply(s.itemId, s.suggestedMinutes!);
                          setApplied(new Set([...applied, s.itemId]));
                        }}
                      >
                        {applied.has(s.itemId) ? '반영됨 (저장 필요)' : `${s.suggestedMinutes}분으로 반영`}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted small mt">교재 원본의 시간을 바꿔도 이미 만든 계획(스냅샷)은 바뀌지 않습니다. 반영 후 과정 새 버전을 발행하고 새 계획부터 적용하세요.</p>
    </div>
  );
}

function ImportModal({ defaultUnit, onClose, onApply }: { defaultUnit: ProgressUnit; onClose: () => void; onApply: (items: LearningItem[], mode: 'append' | 'replace') => void }) {
  const [source, setSource] = useState<'table' | 'toc'>('table');
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [error, setError] = useState('');
  const [mode, setMode] = useState<'append' | 'replace'>('append');
  const [lastPage, setLastPage] = useState('');
  const [perPage, setPerPage] = useState('3');
  const [pdfFrom, setPdfFrom] = useState('1');
  const [pdfTo, setPdfTo] = useState('5');
  const [pdfInfo, setPdfInfo] = useState('');
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [scanPages, setScanPages] = useState<number[]>([]);
  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocrInfo, setOcrInfo] = useState('');
  const run = async () => {
    setError('');
    try {
      if (source === 'toc') {
        setPreview(parseToc(text, { lastPage: Number(lastPage) || undefined, minutesPerPage: Number(perPage) || 3 }));
      } else {
        setPreview(await post<ImportPreview>('/api/textbooks/import-preview', { text, defaultUnit }));
      }
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const loadPdf = async (file: File | undefined) => {
    if (!file) return;
    setPdfFile(file);
    setScanPages([]);
    setPdfBusy(true);
    setError('');
    setPdfInfo('');
    try {
      const r = await extractPdfLines(await file.arrayBuffer(), Number(pdfFrom) || 1, Number(pdfTo) || undefined);
      setText(r.lines.join('\n'));
      setScanPages(r.emptyPages);
      setPreview(null);
      setPdfInfo(
        `${file.name}: 전체 ${r.pageCount}쪽 중 ${pdfFrom}~${Math.min(Number(pdfTo) || r.pageCount, r.pageCount)}쪽에서 ${r.lines.length}줄을 읽었습니다.` +
          (r.emptyPages.length ? ` 텍스트가 없는 페이지 ${r.emptyPages.join(', ')}가 있습니다(스캔본). 아래 '글자 인식'으로 읽을 수 있습니다.` : '') +
          ' 목차가 아닌 줄은 지우고 미리보기를 누르세요.',
      );
    } catch (e) {
      setError(`PDF를 읽지 못했습니다: ${errorMessage(e)}`);
    } finally {
      setPdfBusy(false);
    }
  };
  /** 글자 인식: 스캔 PDF 페이지 또는 사진. 결과는 입력 칸에 넣고 사람이 고친 뒤 미리보기 */
  const runOcr = async (sources: () => Promise<Array<Blob | HTMLCanvasElement>>, label: string) => {
    setOcrBusy(true);
    setError('');
    setOcrInfo('글자 인식 준비 중… (처음에는 인식 데이터를 불러오느라 시간이 걸립니다)');
    try {
      const images = await sources();
      const r = await recognizeImages(images, (pr) => setOcrInfo(`${label} ${pr.page ?? ''}/${pr.pageCount ?? ''} · ${pr.status} ${Math.round(pr.progress * 100)}%`));
      setText((t) => (t.trim() ? t.trimEnd() + '\n' : '') + r.lines.join('\n'));
      setPreview(null);
      setOcrInfo(`${label}: ${r.lines.length}줄을 읽었습니다 (평균 신뢰도 ${r.confidence}%). 글자 인식은 틀릴 수 있으니 제목·쪽번호를 확인하고 고친 뒤 미리보기를 누르세요.`);
    } catch (e) {
      setOcrInfo('');
      setError(`글자 인식에 실패했습니다: ${errorMessage(e)}`);
    } finally {
      setOcrBusy(false);
    }
  };
  const hasErrors = preview?.issues.some((i) => i.level === 'error');
  return (
    <Modal title="학습항목 가져오기" onClose={onClose} wide>
      <div className="row mb">
        <label className="check">
          <input type="radio" checked={source === 'table'} onChange={() => { setSource('table'); setPreview(null); }} /> 표·엑셀 붙여넣기
        </label>
        <label className="check">
          <input type="radio" checked={source === 'toc'} onChange={() => { setSource('toc'); setPreview(null); }} /> 목차 텍스트·PDF
        </label>
      </div>
      {source === 'table' ? (
        <p className="muted small">
          엑셀이나 표에서 복사해 붙여넣으세요. 머리글 예: <code>대단원 소단원 제목 목표 단위 시작 끝 수량 시간 난이도 분할 용도 준비물 메모</code>. 머리글이 없으면 <code>대단원, 소단원, 제목, 단위, 시작, 끝, 시간</code> 순서로 해석합니다.
        </p>
      ) : (
        <>
          <p className="muted small">
            교재 목차를 붙여 넣거나, 텍스트가 들어 있는 교재 PDF에서 목차 페이지를 읽어 옵니다(파일은 이 브라우저 안에서만 읽고 서버로 보내지 않습니다). 각 줄 끝의 쪽번호로 범위를 만들고, 다음 항목 시작 쪽 − 1을 끝 쪽으로 씁니다. 결과는 미리보기에서 확인한 뒤에만 적용됩니다.
          </p>
          <div className="row">
            <span className="small">PDF 목차 페이지</span>
            <input type="number" min={1} style={{ width: 70 }} value={pdfFrom} onChange={(e) => setPdfFrom(e.target.value)} aria-label="PDF 시작 페이지" />~
            <input type="number" min={1} style={{ width: 70 }} value={pdfTo} onChange={(e) => setPdfTo(e.target.value)} aria-label="PDF 끝 페이지" />
            {/* 같은 파일을 다시 골라도(쪽 범위를 바꾼 뒤) 읽히도록 고른 뒤 값을 비운다 */}
            <input type="file" accept="application/pdf,.pdf" disabled={pdfBusy} onChange={(e) => { loadPdf(e.target.files?.[0]); e.target.value = ''; }} aria-label="교재 PDF 선택" />
            {pdfFile && (
              <button className="sm" disabled={pdfBusy} onClick={() => loadPdf(pdfFile)} title="바꾼 쪽 범위로 같은 PDF를 다시 읽습니다">
                이 범위로 다시 읽기
              </button>
            )}
            {pdfBusy && <span className="small muted">읽는 중…</span>}
          </div>
          {pdfInfo && <Alert kind="info">{pdfInfo}</Alert>}
          <div className="row mt">
            {pdfFile && scanPages.length > 0 && (
              <button disabled={ocrBusy} onClick={async () => { const f = pdfFile; await runOcr(async () => renderPdfPages(await f.arrayBuffer(), scanPages), `PDF ${scanPages.join(', ')}쪽 글자 인식`); }}>
                스캔 페이지 {scanPages.join(', ')} 글자 인식
              </button>
            )}
            <span className="small">목차 사진</span>
            <input type="file" accept="image/*" multiple disabled={ocrBusy} aria-label="목차 사진 선택" onChange={(e) => { const fs = [...(e.target.files ?? [])]; if (fs.length) runOcr(async () => fs, `사진 ${fs.length}장 글자 인식`); e.target.value = ''; }} />
            {ocrBusy && <span className="small muted">인식 중…</span>}
          </div>
          {ocrInfo && <Alert kind="info">{ocrInfo}</Alert>}
          <div className="row mt">
            <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <span>본문 마지막 쪽</span>
              <input type="number" min={1} style={{ width: 80 }} value={lastPage} onChange={(e) => setLastPage(e.target.value)} placeholder="예: 107" />
            </label>
            <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <span>쪽당 예상 분</span>
              <input type="number" min={1} style={{ width: 70 }} value={perPage} onChange={(e) => setPerPage(e.target.value)} />
            </label>
          </div>
        </>
      )}
      <textarea
        className="mt"
        rows={8}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={source === 'table' ? '대단원\t소단원\t제목\t단위\t시작\t끝\t시간\n1단원\t1\t중심 문장 찾기\t쪽\t12\t23\t30' : '1단원 중심 생각\n  1. 중심 문장 찾기 ........ 12\n  2. 문단 요약하기 ........ 24\n2단원 설명하는 글\n  1. 설명 방법 파악하기 ... 36'}
      />
      <div className="row mt">
        <button className="primary" onClick={run} disabled={!text.trim()}>
          미리보기
        </button>
        <label className="check">
          <input type="radio" checked={mode === 'append'} onChange={() => setMode('append')} /> 기존 항목 뒤에 추가
        </label>
        <label className="check">
          <input type="radio" checked={mode === 'replace'} onChange={() => setMode('replace')} /> 기존 항목 바꾸기
        </label>
      </div>
      {error && <Alert kind="danger">{error}</Alert>}
      {preview && (
        <div className="mt">
          {preview.issues.length > 0 && (
            <Alert kind={hasErrors ? 'danger' : 'warn'}>
              {preview.issues.map((i, k) => (
                <div key={k}>
                  {i.row ? `${i.row}행: ` : ''}
                  {i.level === 'error' ? '[오류] ' : '[확인] '}
                  {i.message}
                </div>
              ))}
            </Alert>
          )}
          <div className="table-wrap" style={{ maxHeight: 300 }}>
            <table className="compact">
              <thead>
                <tr>
                  <th>#</th>
                  <th>대단원</th>
                  <th>소단원</th>
                  <th>제목</th>
                  <th>단위</th>
                  <th>범위/수량</th>
                  <th>분</th>
                  <th>출처</th>
                  <th>분할</th>
                </tr>
              </thead>
              <tbody>
                {preview.items.map((it, i) => (
                  <tr key={it.id}>
                    <td>{i + 1}</td>
                    <td>{it.unit}</td>
                    <td>{it.subunit}</td>
                    <td>{it.title}</td>
                    <td>{PROGRESS_UNIT_LABEL[it.progressUnit]}</td>
                    <td>{it.range ? `${it.range.from}~${it.range.to} (${itemQuantity(it)})` : it.quantity}</td>
                    <td>{it.minutes}</td>
                    <td>{it.minutesSource === 'entered' ? '입력' : '추정'}</td>
                    <td>{it.splittable ? '가능' : '불가'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="row mt" style={{ justifyContent: 'flex-end' }}>
            <button className="primary" disabled={hasErrors || preview.items.length === 0} onClick={() => onApply(preview.items, mode)}>
              {hasErrors ? '오류를 고친 뒤 적용할 수 있습니다' : `${preview.items.length}개 항목 적용`}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
