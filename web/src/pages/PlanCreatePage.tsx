import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { AppSettings, Assignment, Curriculum, HolidaySet, LearningApproach, Lesson, PlanSettings, PlanSnapshot, Textbook, UnassignedEntry } from '@wb/shared';
import { COMPOSITION_LABEL, LEARNING_APPROACH_LABEL, UNASSIGNED_REASON_LABEL, fmtMinutes, todayKST, curriculumTotals, curriculumUnassignedMessage } from '@wb/shared';
import { get, post, errorMessage } from '../api.ts';
import { Alert, Badge, Field, Loading, SampleBadge, WeekdayPicker, useAsync } from '../components/ui.tsx';
import { PlanOptions, planDateLabel } from '../components/PlanOptions.tsx';

interface Preview {
  lessons: Lesson[];
  assignments: Assignment[];
  unassigned: UnassignedEntry[];
  endDateComputed: string;
  warnings: string[];
  shortageMinutes: number;
  snapshot: PlanSnapshot;
}

interface Comparison {
  request: { curriculumId: string; settings: PlanSettings; fromSessionOrder: number; toSessionOrder: number };
  sourceVersion: string;
  options: Array<Preview & { learningApproach: LearningApproach; settings: PlanSettings }>;
}

export async function comparePlanOptions(input: Comparison['request']): Promise<Comparison> {
  const request = structuredClone(input);
  const response = await post<Omit<Comparison, 'request'>>('/api/plans/compare', request);
  return { ...response, request };
}

export function comparisonSaveFields(comparison: Comparison, approach: LearningApproach) {
  const option = comparison.options.find((x) => x.learningApproach === approach);
  if (!option) throw new Error('저장할 안을 다시 선택하세요.');
  return { curriculumId: comparison.request.curriculumId, settings: option.settings, fromSessionOrder: comparison.request.fromSessionOrder, toSessionOrder: comparison.request.toSessionOrder, learningApproach: approach, expectedSourceVersion: comparison.sourceVersion };
}

export function defaultSettings(app?: AppSettings | null): PlanSettings {
  return {
    startDate: todayKST(),
    endDate: '',
    targetDate: '',
    weekdays: [1, 4],
    minutesPerLesson: app?.defaultMinutesPerLesson ?? 60,
    reviewMinutes: app?.defaultReviewMinutes ?? 10,
    bufferMinutes: app?.defaultBufferMinutes ?? 5,
    mode: 'pace',
    academicYearStartMonth: app?.academicYearStartMonth ?? 3,
    holidaySetIds: [],
    offDays: [],
    makeupDays: [],
    fixedEvents: [],
    tracks: { review: 0, advance: 0, advanceWeekdays: null, currentMinMinutes: 0 },
    maxDays: 400,
  };
}

export function SettingsForm({ s, onChange, holidaySets, showAdvanced, setShowAdvanced, advanceEntryCount }: { s: PlanSettings; onChange: (s: PlanSettings) => void; holidaySets: HolidaySet[]; showAdvanced: boolean; setShowAdvanced: (v: boolean) => void; advanceEntryCount?: number }) {
  const set = (p: Partial<PlanSettings>) => onChange({ ...s, ...p });
  const newProgress = s.minutesPerLesson - s.reviewMinutes - s.bufferMinutes;
  return (
    <>
      <div className="grid cols-4">
        <Field label="시작일 *">
          <input type="date" value={s.startDate} onChange={(e) => set({ startDate: e.target.value })} />
        </Field>
        <Field label="편성 방식">
          <select value={s.mode} onChange={(e) => set({ mode: e.target.value as PlanSettings['mode'] })}>
            <option value="period">기간 우선 (정해진 기간에 배정, 부족분 표시)</option>
            <option value="pace">속도 우선 (완료 예정일 계산)</option>
          </select>
        </Field>
        <Field label={s.mode === 'period' ? '종료일 *' : '종료일 (선택)'}>
          <input type="date" value={s.endDate} onChange={(e) => set({ endDate: e.target.value })} />
        </Field>
        <Field label="목표 완료일 (선택)" hint="넘으면 경고합니다">
          <input type="date" value={s.targetDate} onChange={(e) => set({ targetDate: e.target.value })} />
        </Field>
      </div>
      <div className="grid cols-4 mt">
        <Field label="수업 요일 *">
          <WeekdayPicker value={s.weekdays} onChange={(weekdays) => set({ weekdays })} />
        </Field>
        <Field label="회당 수업시간(분)">
          <input type="number" value={s.minutesPerLesson} onChange={(e) => set({ minutesPerLesson: Number(e.target.value) })} />
        </Field>
        <Field label="회당 복습(분)">
          <input type="number" value={s.reviewMinutes} onChange={(e) => set({ reviewMinutes: Number(e.target.value) })} />
        </Field>
        <Field label="회당 여유(분)" hint={`새 진도 가능시간 ${newProgress}분`}>
          <input type="number" value={s.bufferMinutes} onChange={(e) => set({ bufferMinutes: Number(e.target.value) })} />
        </Field>
      </div>
      <Field label="적용할 공휴일 세트">
        <div className="row">
          {holidaySets.map((h) => (
            <label key={h.id} className="check">
              <input type="checkbox" checked={s.holidaySetIds.includes(h.id)} onChange={(e) => set({ holidaySetIds: e.target.checked ? [...s.holidaySetIds, h.id] : s.holidaySetIds.filter((x) => x !== h.id) })} /> {h.name}
              <span className="muted small">({h.holidays.filter((x) => x.enabled).length}일{h.holidays.some((x) => !x.verified) ? ', 확인 필요' : ''})</span>
            </label>
          ))}
        </div>
      </Field>
      <button className="link mt" onClick={() => setShowAdvanced(!showAdvanced)}>
        {showAdvanced ? '▾ 상세 설정 접기' : '▸ 상세 설정 (트랙 배분·휴강·보강·고정 일정·학년도)'}
      </button>
      {advanceEntryCount === 0 && (s.tracks.advance > 0 || !!s.tracks.advanceWeekdays?.length) && <Alert kind="warn">선행 시간·요일이 설정되어 있지만 선택 범위에 선행 항목이 없습니다. 과정 조립판에서 항목의 트랙을 지정하세요. 시간 설정만으로 항목의 트랙이 바뀌지는 않습니다.</Alert>}
      {showAdvanced && (
        <div className="mt">
          <h3>트랙별 회당 시간 배분</h3>
          <div className="grid cols-4">
            <Field label="현행 최소 확보(분)">
              <input type="number" value={s.tracks.currentMinMinutes} onChange={(e) => set({ tracks: { ...s.tracks, currentMinMinutes: Number(e.target.value) } })} />
            </Field>
            <Field label="복습·보충 트랙(분)">
              <input type="number" value={s.tracks.review} onChange={(e) => set({ tracks: { ...s.tracks, review: Number(e.target.value) } })} />
            </Field>
            <Field label="선행 트랙(분)">
              <input type="number" value={s.tracks.advance} onChange={(e) => set({ tracks: { ...s.tracks, advance: Number(e.target.value) } })} />
            </Field>
            <Field label="선행 요일 (비우면 모든 수업일)">
              <WeekdayPicker value={s.tracks.advanceWeekdays ?? []} onChange={(v) => set({ tracks: { ...s.tracks, advanceWeekdays: v.length ? v : null } })} />
            </Field>
          </div>
          {s.tracks.currentMinMinutes + s.tracks.review + s.tracks.advance > newProgress && <Alert kind="warn">트랙 배분 합계가 새 진도 가능시간({newProgress}분)을 넘습니다. 모든 트랙의 합은 실제 수업 가능시간을 넘지 않아야 합니다.</Alert>}
          <div className="grid cols-3 mt">
            <DateListEditor title="휴강·방학" rows={s.offDays} fields={[{ key: 'reason', label: '사유' }]} onChange={(rows) => set({ offDays: rows as PlanSettings['offDays'] })} blank={() => ({ id: crypto.randomUUID(), date: s.startDate, reason: '휴강', source: 'manual' as const })} />
            <DateListEditor title="보강" rows={s.makeupDays} fields={[{ key: 'note', label: '메모' }, { key: 'minutes', label: '분(선택)', type: 'number' }]} onChange={(rows) => set({ makeupDays: rows as PlanSettings['makeupDays'] })} blank={() => ({ id: crypto.randomUUID(), date: s.startDate, note: '' })} />
            <DateListEditor title="고정 일정 (시험·행사)" rows={s.fixedEvents} fields={[{ key: 'title', label: '제목' }, { key: 'minutes', label: '차지하는 분', type: 'number' }]} onChange={(rows) => set({ fixedEvents: rows as PlanSettings['fixedEvents'] })} blank={() => ({ id: crypto.randomUUID(), date: s.startDate, title: '', minutes: 0 })} />
          </div>
          <div className="grid cols-4 mt">
            <Field label="학년도 시작월">
              <input type="number" min={1} max={12} value={s.academicYearStartMonth} onChange={(e) => set({ academicYearStartMonth: Number(e.target.value) })} />
            </Field>
            <Field label="속도 우선 최대 탐색 일수">
              <input type="number" value={s.maxDays} onChange={(e) => set({ maxDays: Number(e.target.value) })} />
            </Field>
          </div>
        </div>
      )}
    </>
  );
}

function DateListEditor<T extends { id: string; date: string }>({ title, rows, fields, onChange, blank }: { title: string; rows: T[]; fields: Array<{ key: string; label: string; type?: string }>; onChange: (rows: T[]) => void; blank: () => T }) {
  return (
    <div className="panel tight">
      <div className="row between">
        <strong>{title}</strong>
        <button className="sm" onClick={() => onChange([...rows, blank()])}>
          + 추가
        </button>
      </div>
      {rows.length === 0 && <p className="muted small">없음</p>}
      {rows.map((r, i) => (
        <div className="row" key={r.id} style={{ marginTop: 4 }}>
          <input type="date" value={r.date} onChange={(e) => onChange(rows.map((x, j) => (j === i ? { ...x, date: e.target.value } : x)))} />
          {fields.map((f) => (
            <input key={f.key} type={f.type ?? 'text'} placeholder={f.label} style={{ width: f.type === 'number' ? 80 : 120 }} value={String((r as Record<string, unknown>)[f.key] ?? '')} onChange={(e) => onChange(rows.map((x, j) => (j === i ? { ...x, [f.key]: f.type === 'number' ? (e.target.value === '' ? undefined : Number(e.target.value)) : e.target.value } : x)))} />
          ))}
          <button className="sm" onClick={() => onChange(rows.filter((_, j) => j !== i))}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

export function PlanCreatePage() {
  const nav = useNavigate();
  const [searchParams] = useSearchParams();
  const sampleDemo = searchParams.get('sample') === '1';
  const { data: curricula } = useAsync(() => get<Array<Curriculum & { totals: ReturnType<typeof curriculumTotals> }>>('/api/curricula'), []);
  const { data: textbooks } = useAsync(() => get<Textbook[]>('/api/textbooks?archived=1'), []);
  const { data: holidaySets } = useAsync(() => get<HolidaySet[]>('/api/holiday-sets'), []);
  const { data: app } = useAsync(() => get<AppSettings>('/api/settings'), []);
  const [step, setStep] = useState(1);
  const [curriculumId, setCurriculumId] = useState(searchParams.get('curriculum') ?? '');
  const [fromSession, setFromSession] = useState(0);
  const [toSession, setToSession] = useState(0);
  const [settings, setSettings] = useState<PlanSettings>(defaultSettings());
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [title, setTitle] = useState('');
  const [target, setTarget] = useState('');
  const [classOrStudentRef, setClassOrStudentRef] = useState(sampleDemo ? '[가상] 학생 A' : '');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [selectedApproach, setSelectedApproach] = useState<LearningApproach | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (app) setSettings((s) => ({ ...s, ...(!curriculumId ? { minutesPerLesson: app.defaultMinutesPerLesson, reviewMinutes: app.defaultReviewMinutes, bufferMinutes: app.defaultBufferMinutes } : {}), academicYearStartMonth: app.academicYearStartMonth }));
  }, [app, curriculumId]);
  useEffect(() => {
    if (holidaySets && settings.holidaySetIds.length === 0) {
      const y = Number(settings.startDate.slice(0, 4));
      setSettings((s) => ({ ...s, holidaySetIds: holidaySets.filter((h) => h.year === y || h.year === y + 1).map((h) => h.id) }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [holidaySets]);

  const cur = useMemo(() => curricula?.find((c) => c.id === curriculumId), [curricula, curriculumId]);
  const blocked = cur ? curriculumUnassignedMessage(cur, new Map((textbooks ?? []).map((tb) => [tb.id, tb]))) : null;
  const advanceEntryCount = cur?.sessions.filter((s) => (!fromSession || s.order >= fromSession) && (!toSession || s.order <= toSession)).flatMap((s) => s.entries).filter((e) => e.track === 'advance').length;
  useEffect(() => {
    if (cur) {
      setTitle(`${cur.title} 계획`);
      setTarget(cur.target);
      setSettings((s) => ({ ...s, minutesPerLesson: cur.recommendedMinutesPerSession, reviewMinutes: cur.reviewMinutesPerSession, bufferMinutes: cur.bufferMinutesPerSession, tracks: { ...s.tracks, currentMinMinutes: cur.advance?.currentMinMinutes ?? s.tracks.currentMinMinutes, advance: cur.sessions.some((x) => x.entries.some((e) => e.track === 'advance')) && s.tracks.advance === 0 ? 15 : s.tracks.advance }, targetDate: cur.advance?.targetDate || s.targetDate }));
      setFromSession(0);
      setToSession(0);
    }
  }, [cur]);

  const runPreview = async () => {
    if (blocked) { setError(blocked); return; }
    setBusy(true);
    setError('');
    setComparison(null);
    setSelectedApproach(null);
    try {
      setPreview(await post<Preview>('/api/plans/preview', { curriculumId, settings, fromSessionOrder: fromSession, toSessionOrder: toSession }));
      setStep(4);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const runComparison = async () => {
    if (blocked || busy) return;
    setBusy(true);
    setError('');
    setPreview(null);
    setSelectedApproach(null);
    try {
      setComparison(await comparePlanOptions({ curriculumId, settings, fromSessionOrder: fromSession, toSessionOrder: toSession }));
      setStep(4);
    } catch (e) { setComparison(null); setError(errorMessage(e)); }
    finally { setBusy(false); }
  };
  const create = async () => {
    if (busy) return;
    if (blocked) { setError(blocked); return; }
    if (comparison && !selectedApproach) { setError('저장할 안을 하나 선택하세요.'); return; }
    setBusy(true);
    setError('');
    try {
      const p = await post<{ id: string }>('/api/plans', {
        curriculumId, settings, fromSessionOrder: fromSession, toSessionOrder: toSession,
        title: selectedApproach ? `${title} · ${LEARNING_APPROACH_LABEL[selectedApproach]}` : title, target, classOrStudentRef,
        isSample: sampleDemo || cur?.isSample,
        ...(selectedApproach && comparison ? comparisonSaveFields(comparison, selectedApproach) : {}),
      });
      nav(`/plans/${p.id}`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const steps = ['과정 선택', '학습 범위', '시작일·요일·시간', '편성 결과 확인'];
  return (
    <>
      <div className="topbar">
        <h1>계획 만들기</h1>
        <div className="row small">
          {steps.map((s, i) => (
            <span key={s} className={`badge ${step === i + 1 ? 'primary' : ''}`}>
              {i + 1}. {s}
            </span>
          ))}
        </div>
      </div>
      {error && <Alert kind="danger">{error}</Alert>}
      {blocked && <Alert kind="danger">{blocked} <Link to={`/curricula/${curriculumId}`}>과정 조립판 열기</Link></Alert>}

      {step === 1 && (
        <div className="panel">
          <h2>1. 과정 선택</h2>
          <p className="muted small">
            표준과정을 고르세요. 교재만 있고 과정이 없으면 <Link to="/curricula/new">과정 만들기</Link>에서 교재로 과정을 자동 구성한 뒤 돌아오세요.
          </p>
          {!curricula ? (
            <Loading />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th></th>
                    <th>과정</th>
                    <th>대상</th>
                    <th>구성</th>
                    <th className="num">차시</th>
                    <th className="num">시간</th>
                    <th>버전</th>
                  </tr>
                </thead>
                <tbody>
                  {curricula.map((c) => (
                    <tr key={c.id} onClick={() => setCurriculumId(c.id)} style={{ cursor: 'pointer' }}>
                      <td>
                        <input type="radio" checked={curriculumId === c.id} onChange={() => setCurriculumId(c.id)} />
                      </td>
                      <td>
                        {c.title} <SampleBadge show={c.isSample} />
                        {c.status !== 'verified' && <Badge kind="warn">{c.status === 'draft' ? '초안' : '검토 중'}</Badge>}
                      </td>
                      <td>{c.target}</td>
                      <td>{COMPOSITION_LABEL[c.compositionMode]}</td>
                      <td className="num">{c.totals.sessions}</td>
                      <td className="num">{fmtMinutes(c.totals.minutes)}</td>
                      <td>v{c.curriculumVersion}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="row mt" style={{ justifyContent: 'flex-end' }}>
            <button className="primary" disabled={!curriculumId || !!blocked} onClick={() => setStep(2)}>
              다음
            </button>
          </div>
        </div>
      )}

      {step === 2 && cur && (
        <div className="panel">
          <h2>2. 학습 범위 선택</h2>
          <p className="muted small">전체 과정, 특정 차시 구간, 또는 중간 지점부터 적용할 수 있습니다. 교재 범위는 과정의 포함·제외 설정을 따릅니다.</p>
          <div className="grid cols-3">
            <Field label="시작 차시 (0=처음부터)">
              <input type="number" min={0} max={cur.sessions.length} value={fromSession} onChange={(e) => setFromSession(Number(e.target.value))} />
            </Field>
            <Field label="끝 차시 (0=끝까지)">
              <input type="number" min={0} max={cur.sessions.length} value={toSession} onChange={(e) => setToSession(Number(e.target.value))} />
            </Field>
            <Field label="선택 결과">
              <span>
                {cur.sessions.filter((s) => (!fromSession || s.order >= fromSession) && (!toSession || s.order <= toSession)).length}차시 ·{' '}
                {fmtMinutes(cur.sessions.filter((s) => (!fromSession || s.order >= fromSession) && (!toSession || s.order <= toSession)).reduce((a, s) => a + s.entries.filter((e) => e.activity !== 'homework').reduce((x, e) => x + e.minutes, 0), 0))}
              </span>
            </Field>
          </div>
          <div className="row mt" style={{ justifyContent: 'space-between' }}>
            <button onClick={() => setStep(1)}>이전</button>
            <button className="primary" disabled={!!blocked} onClick={() => setStep(3)}>
              다음
            </button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="panel">
          <h2>3. 시작일·요일·시간 설정</h2>
          <fieldset className="plan-inputs" disabled={busy}>
          <div className="grid cols-3 mb">
            <Field label="계획명">
              <input value={title} onChange={(e) => setTitle(e.target.value)} />
            </Field>
            <Field label="학년·대상 (선택)">
              <input value={target} onChange={(e) => setTarget(e.target.value)} />
            </Field>
            <Field label="학생·반 표시 (선택)">
              <input value={classOrStudentRef} onChange={(e) => setClassOrStudentRef(e.target.value)} />
            </Field>
          </div>
          <SettingsForm s={settings} onChange={setSettings} holidaySets={holidaySets ?? []} showAdvanced={showAdvanced} setShowAdvanced={setShowAdvanced} advanceEntryCount={advanceEntryCount} />
          <div className="row mt" style={{ justifyContent: 'space-between' }}>
            <button onClick={() => setStep(2)}>이전</button>
            <div className="row">
              <button disabled={busy || !!blocked} onClick={runPreview}>직접 설정대로 미리보기</button>
              <button className="primary" disabled={busy || !!blocked} onClick={runComparison}>{busy ? '편성 중…' : '3안 비교하기'}</button>
            </div>
          </div>
          </fieldset>
        </div>
      )}

      {step === 4 && (preview || comparison) && (
        <div className="panel">
          <h2>4. {comparison ? '학생 맞춤 3안 비교·선택' : '편성 결과 확인'}</h2>
          {comparison && <>
            <p>{classOrStudentRef || target || '학생·반 미지정'} · {cur?.title} <SampleBadge show={!!cur?.isSample || sampleDemo} /></p>
            <PlanOptions options={comparison.options} selected={selectedApproach} disabled={busy} onSelect={(approach) => { setSelectedApproach(approach); setPreview(comparison.options.find((option) => option.learningApproach === approach)!); }} />
            <Alert>기간은 등록된 교재의 예상 시간으로 계산합니다. 학원 표준이나 학생의 실제 속도로 확정된 값이 아닙니다. 선택한 안만 초안으로 저장되며, 이후 진도 기록과 일정 수정에서 관리합니다.</Alert>
          </>}
          {preview && <>
          {comparison && <h3 className="mt">선택한 안의 상세 일정</h3>}
          {preview.warnings.map((w, i) => (
            <Alert key={i} kind="warn">
              {w}
            </Alert>
          ))}
          <div className="grid cols-4">
            <div className="panel tight">
              <div className="muted small">수업 횟수</div>
              <strong>{preview.lessons.filter((l) => l.status === 'scheduled' || l.status === 'makeup').length}회</strong> <span className="muted small">(휴강·공휴일 {preview.lessons.filter((l) => l.status === 'cancelled' || l.status === 'holiday').length})</span>
            </div>
            <div className="panel tight">
              <div className="muted small">배정 시간</div>
              <strong>{fmtMinutes(preview.assignments.filter((a) => a.activity !== 'homework').reduce((s, a) => s + a.minutes, 0))}</strong>
            </div>
            <div className="panel tight">
              <div className="muted small">미배정</div>
              <strong className={preview.unassigned.length ? 'badge danger' : ''}>{preview.unassigned.length}건 · {fmtMinutes(preview.unassigned.reduce((s, u) => s + u.minutes, 0))}</strong>
            </div>
            <div className="panel tight">
              <div className="muted small">{planDateLabel(settings.mode, preview.unassigned.length)}</div>
              <strong>{preview.endDateComputed || '-'}</strong>
              {!!preview.unassigned.length && <p className="small">완료 예정일: 미정</p>}
            </div>
          </div>
          {preview.unassigned.length > 0 && (
            <div className="mt">
              <h3>미배정 범위와 사유</h3>
              <ul className="small">
                {preview.unassigned.map((u) => (
                  <li key={u.id}>
                    {preview.snapshot.textbooks.find((t) => t.id === u.textbookId)?.items.find((i) => i.id === u.itemId)?.title} {u.portion ? `${u.portion.from}~${u.portion.to}` : ''} ({u.minutes}분) — <Badge kind="danger">{UNASSIGNED_REASON_LABEL[u.reason]}</Badge> {u.detail}
                  </li>
                ))}
              </ul>
              <p className="muted small">초안으로 저장할 수 있지만 미배정 범위가 남아 있으면 확정할 수 없습니다. 분량을 숨기지 않고 기간·요일·보강을 조정하세요.</p>
            </div>
          )}
          <div className="table-wrap mt" style={{ maxHeight: 360 }}>
            <table className="compact">
              <thead>
                <tr>
                  <th>날짜</th>
                  <th>상태</th>
                  <th className="num">가능</th>
                  <th>배정</th>
                </tr>
              </thead>
              <tbody>
                {preview.lessons.map((l) => (
                  <tr key={l.id} className={`lesson-row ${l.status}`}>
                    <td className="nowrap">{l.date}</td>
                    <td>{l.status === 'scheduled' ? '수업' : l.status === 'makeup' ? '보강' : l.status === 'holiday' ? '공휴일' : '휴강'}{l.note ? ` · ${l.note}` : ''}</td>
                    <td className="num">{l.availableMinutes}</td>
                    <td>
                      {preview.assignments
                        .filter((a) => a.lessonId === l.id)
                        .sort((a, b) => a.order - b.order)
                        .map((a) => {
                          const tb = preview.snapshot.textbooks.find((t) => t.id === a.textbookId);
                          const it = tb?.items.find((i) => i.id === a.itemId);
                          return (
                            <span key={a.id} className={`assign-chip ${a.activity === 'homework' ? 'hw' : ''}`}>
                              {it?.title} {a.portion ? `${a.portion.from}~${a.portion.to}` : ''} {a.minutes}분
                            </span>
                          );
                        })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </>}
          <div className="row mt" style={{ justifyContent: 'space-between' }}>
            <button disabled={busy} onClick={() => setStep(3)}>수정</button>
            <button className="primary" disabled={busy || !!blocked || (!!comparison && !selectedApproach)} onClick={create}>
              {busy ? '저장 중…' : selectedApproach ? `${LEARNING_APPROACH_LABEL[selectedApproach]}만 초안으로 저장` : comparison ? '안을 선택한 뒤 저장' : '초안으로 저장'}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
