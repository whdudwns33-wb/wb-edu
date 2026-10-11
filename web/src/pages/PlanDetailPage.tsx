import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { DayView, HolidaySet, LearningObjective, MonthView, OutputTemplate, Plan, PlanSettings, PlanViews, QuarterView, TextbookProgress, User, WeekView, YearView } from '@wb/shared';
import { OBJECTIVE_STATE_LABEL, UNASSIGNED_REASON_LABEL, assignmentViews, fmtMinutes, latestUndoableId, resolveColumns, todayKST, type ObjectiveStatus, type ScheduleDiff } from '@wb/shared';
import { get, post, put, errorMessage } from '../api.ts';
import { useAuth } from '../auth.tsx';
import { Alert, Badge, Empty, Field, Loading, Modal, SampleBadge, Tabs, useAsync, usePrompt } from '../components/ui.tsx';
import { RecordControls } from '../components/RecordControls.tsx';
import { RemoteChangeBanner, useRemoteVersion } from '../components/RemoteChange.tsx';
import { SettingsForm } from './PlanCreatePage.tsx';

type PlanDoc = Plan & { blockers: string[]; overbooked: Array<{ date: string; used: number; available: number }> };
type Tab = 'views' | 'unassigned' | 'edit' | 'records' | 'objectives' | 'history' | 'output';
type Level = 'year' | 'quarter' | 'month' | 'week' | 'day';

interface OpPreview {
  diff: ScheduleDiff;
  warnings: string[];
  description: string;
}

export function PlanDetailPage() {
  const { id } = useParams();
  const { user } = useAuth();
  const [plan, setPlan] = useState<PlanDoc | null>(null);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [tab, setTab] = useState<Tab>('views');
  const [opPreview, setOpPreview] = useState<(OpPreview & { op: string; params: Record<string, unknown> }) | null>(null);
  const [metaOpen, setMetaOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      setPlan(await get<PlanDoc>(`/api/plans/${id}`));
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [id]);
  useEffect(() => {
    load();
  }, [load]);
  const remote = useRemoteVersion('plan', id, plan?.version);

  const runOp = async (op: string, params: Record<string, unknown>, direct = false) => {
    if (!plan) return;
    setError('');
    setMsg('');
    try {
      if (!direct) {
        const dry = await post<OpPreview>(`/api/plans/${plan.id}/ops`, { op, params, dryRun: true });
        setOpPreview({ ...dry, op, params });
        return;
      }
      const res = await post<PlanDoc & { description: string; warnings: string[] }>(`/api/plans/${plan.id}/ops`, { op, params, version: plan.version });
      setPlan(res);
      setMsg(`${res.description}${res.warnings.length ? ' ' + res.warnings.join(' ') : ''}`);
      setOpPreview(null);
    } catch (e) {
      setError(errorMessage(e));
      setOpPreview(null);
      if ((e as { status?: number }).status === 409) load();
    }
  };

  if (error && !plan) return <Alert kind="danger">{error}</Alert>;
  if (!plan) return <Loading />;
  const pending = plan.unassigned.filter((u) => u.reason !== 'excluded');
  const confirmed = plan.status === 'confirmed';

  return (
    <>
      <div className="topbar">
        <div>
          <h1>
            {plan.title} <SampleBadge show={plan.isSample} /> <Badge kind={confirmed ? 'ok' : 'warn'}>{confirmed ? '확정' : '초안'}</Badge> {plan.archived && <Badge>보관</Badge>}
          </h1>
          <div className="muted small">
            {plan.subject} · {plan.target || '대상 미지정'} · 계획 v{plan.planVersion} · 과정 {plan.snapshot.curriculumTitle} v{plan.snapshot.curriculumVersion} · 교재 {plan.snapshot.textbooks.map((t) => `${t.title} (${t.edition})`).join(', ')}
          </div>
        </div>
        <div className="row">
          <Link to="/plans" className="btn">
            목록
          </Link>
          <button onClick={() => setMetaOpen(true)}>기본 정보</button>
          <button onClick={async () => { const c = await post<PlanDoc>(`/api/plans/${plan.id}/clone`); window.location.href = `/plans/${c.id}`; }} title="학생정보·완료 기록은 복제하지 않습니다">
            복제
          </button>
          {confirmed ? (
            <button onClick={() => post<PlanDoc>(`/api/plans/${plan.id}/unconfirm`, { version: plan.version }).then(setPlan).catch((e) => setError(errorMessage(e)))}>확정 해제</button>
          ) : (
            <button className="primary" disabled={plan.blockers.length > 0} title={plan.blockers.join('\n')} onClick={() => post<PlanDoc>(`/api/plans/${plan.id}/confirm`, { version: plan.version }).then((p) => { setPlan(p); setMsg('계획을 확정했습니다. 사용한 교재 판본과 과정 버전이 보존됩니다.'); }).catch((e) => setError(errorMessage(e)))}>
              확정
            </button>
          )}
        </div>
      </div>
      {error && <Alert kind="danger">{error}</Alert>}
      <RemoteChangeBanner
        remote={remote}
        localVersion={plan.version}
        onReload={() => {
          setMsg('');
          load();
        }}
      />
      {msg && <Alert kind="ok">{msg}</Alert>}
      {plan.blockers.map((b, i) => (
        <Alert key={i} kind="warn">
          확정 불가: {b}
        </Alert>
      ))}
      {plan.overbooked.length > 0 && <Alert kind="warn">가능시간을 초과한 수업: {plan.overbooked.map((o) => `${o.date} (${o.used}/${o.available}분)`).join(', ')}</Alert>}

      <Tabs<Tab>
        tabs={[
          { key: 'views', label: '통합 진도표' },
          { key: 'unassigned', label: `미배정 (${pending.length})` },
          { key: 'edit', label: '일정 수정' },
          { key: 'records', label: '진도 기록' },
          { key: 'objectives', label: '학습목표' },
          { key: 'history', label: '이력·버전' },
          { key: 'output', label: '출력' },
        ]}
        value={tab}
        onChange={setTab}
      />

      {tab === 'views' && <ViewsTab plan={plan} reload={load} />}
      {tab === 'unassigned' && <UnassignedTab plan={plan} runOp={runOp} />}
      {tab === 'edit' && <EditTab plan={plan} runOp={runOp} openSettings={() => setSettingsOpen(true)} />}
      {tab === 'records' && <RecordsTab plan={plan} reload={load} />}
      {tab === 'objectives' && <ObjectivesTab plan={plan} onPlan={setPlan} />}
      {tab === 'history' && <HistoryTab plan={plan} runOp={runOp} />}
      {tab === 'output' && <OutputTab plan={plan} onPlan={setPlan} />}

      {opPreview && (
        <Modal title="변경 전 비교" onClose={() => setOpPreview(null)}>
          <p>
            <strong>{opPreview.description}</strong>
          </p>
          <table className="compact">
            <tbody>
              <tr>
                <th>영향받는 수업</th>
                <td>
                  {opPreview.diff.affectedLessonDates.length}회 {opPreview.diff.affectedLessonDates.length > 0 && <span className="muted small">({opPreview.diff.affectedLessonDates.slice(0, 8).join(', ')}{opPreview.diff.affectedLessonDates.length > 8 ? ' …' : ''})</span>}
                </td>
              </tr>
              <tr>
                <th>미배정 범위</th>
                <td>
                  {opPreview.diff.unassignedCountBefore}건 {opPreview.diff.unassignedMinutesBefore}분 → <strong>{opPreview.diff.unassignedCountAfter}건 {opPreview.diff.unassignedMinutesAfter}분</strong>
                </td>
              </tr>
              <tr>
                <th>마지막 배정일</th>
                <td>
                  {opPreview.diff.endDateBefore || '-'} → <strong>{opPreview.diff.endDateAfter || '-'}</strong>
                </td>
              </tr>
            </tbody>
          </table>
          {opPreview.warnings.map((w, i) => (
            <Alert key={i} kind="warn">
              {w}
            </Alert>
          ))}
          <p className="muted small mt">완료 기록과 고정 일정은 변경되지 않습니다. 적용 후 이력에서 되돌릴 수 있습니다.</p>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button onClick={() => setOpPreview(null)}>취소</button>
            <button className="primary" onClick={() => runOp(opPreview.op, opPreview.params, true)}>
              적용
            </button>
          </div>
        </Modal>
      )}
      {metaOpen && <MetaModal plan={plan} isAdmin={user?.role === 'admin'} onClose={() => setMetaOpen(false)} onSaved={(p) => { setPlan(p); setMetaOpen(false); }} />}
      {settingsOpen && <SettingsModal plan={plan} onClose={() => setSettingsOpen(false)} onPreview={(settings) => { setSettingsOpen(false); runOp('settings', { settings }); }} />}
    </>
  );
}

// ──────────────────────────────────────────────
// 통합 진도표 (연간→분기→월간→주간→일간)
// ──────────────────────────────────────────────

function ViewsTab({ plan, reload }: { plan: PlanDoc; reload: () => void }) {
  const { data, loading, error } = useAsync(() => get<{ views: PlanViews; textbookProgress: TextbookProgress[] }>(`/api/plans/${plan.id}/views`), [plan.version]);
  const [level, setLevel] = useState<Level>('month');
  const [sel, setSel] = useState<{ year?: number; quarter?: string; month?: string; week?: string; day?: string }>({});
  const today = todayKST();

  const years = data?.views.years ?? [];
  const quarters = useMemo(() => years.filter((y) => !sel.year || y.academicYear === sel.year).flatMap((y) => y.quarters), [years, sel.year]);
  const months = useMemo(() => quarters.filter((q) => !sel.quarter || q.key === sel.quarter).flatMap((q) => q.months), [quarters, sel.quarter]);
  const weeks = useMemo(() => months.filter((m) => !sel.month || m.key === sel.month).flatMap((m) => m.weeks), [months, sel.month]);
  const days = useMemo(() => weeks.filter((w) => !sel.week || w.key === sel.week).flatMap((w) => w.days), [weeks, sel.week]);

  useEffect(() => {
    // 기본 선택: 오늘이 속한 월
    if (data && !sel.month) {
      const m = months.find((x) => x.from <= today && today <= x.to) ?? months[0];
      if (m) setSel((s) => ({ ...s, month: m.key }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  if (loading) return <Loading />;
  if (error || !data) return <Alert kind="danger">{error}</Alert>;
  const v = data.views;

  const Summary = ({ s }: { s: YearView['summary'] }) => (
    <span className="small muted">
      수업 {s.lessonCount}회{s.cancelledCount + s.holidayCount ? ` · 휴강 ${s.cancelledCount + s.holidayCount}` : ''}{s.makeupCount ? ` · 보강 ${s.makeupCount}` : ''} · 새 진도 {fmtMinutes(s.assignedMinutes)} / 가능 {fmtMinutes(s.availableMinutes)} · 현행 {s.byTrack.current} · 복습보충 {s.byTrack.review} · 선행 {s.byTrack.advance}분
    </span>
  );

  return (
    <>
      <div className="row between mb">
        <Tabs<Level>
          tabs={[
            { key: 'year', label: '연간' },
            { key: 'quarter', label: '분기' },
            { key: 'month', label: '월간' },
            { key: 'week', label: '주간' },
            { key: 'day', label: '일간' },
          ]}
          value={level}
          onChange={setLevel}
        />
        <div className="small muted">
          <Summary s={v.summary} /> · 기간 {v.header.period} · {v.header.mode}
        </div>
      </div>
      <div className="row small mb">
        <span className="muted">경로:</span>
        {sel.year && <button className="sm" onClick={() => { setSel({}); setLevel('year'); }}>{sel.year}학년도 ×</button>}
        {sel.quarter && <button className="sm" onClick={() => { setSel({ year: sel.year }); setLevel('quarter'); }}>{quarters.find((q) => q.key === sel.quarter)?.label} ×</button>}
        {sel.month && <button className="sm" onClick={() => { setSel({ year: sel.year, quarter: sel.quarter }); setLevel('month'); }}>{months.find((m) => m.key === sel.month)?.label ?? sel.month} ×</button>}
        {sel.week && <button className="sm" onClick={() => { setSel({ ...sel, week: undefined, day: undefined }); setLevel('week'); }}>{weeks.find((w) => w.key === sel.week)?.label} ×</button>}
      </div>

      {level === 'year' && (
        <div className="panel">
          <h2>연간 계획</h2>
          <p className="small">
            <strong>교육 목표:</strong> {plan.snapshot.curriculumTitle} · 학년도 시작월 {plan.settings.academicYearStartMonth}월
          </p>
          {years.map((y) => (
            <div key={y.academicYear} className="panel tight">
              <div className="row between">
                <strong>
                  <button className="link" onClick={() => { setSel({ year: y.academicYear }); setLevel('quarter'); }}>
                    {y.label}
                  </button>
                </strong>
                <Summary s={y.summary} />
              </div>
              <div className="grid cols-2 mt">
                <div>
                  <div className="muted small">교재 흐름</div>
                  {y.textbookFlow.map((f) => (
                    <div key={f.textbookId} className="small">
                      {f.title} <span className="muted">({f.edition})</span> {f.firstDate} ~ {f.lastDate} · {fmtMinutes(f.minutes)}
                    </div>
                  ))}
                </div>
                <div>
                  <div className="muted small">현행·선행 도달 목표</div>
                  {y.trackTargets.filter((t) => t.minutes > 0).map((t) => (
                    <div key={t.track} className="small">
                      {t.label}: {t.itemCount}항목 · {fmtMinutes(t.minutes)}
                    </div>
                  ))}
                  {plan.snapshot.advance && <div className="small muted">선행: {plan.snapshot.advance.targetDescription} (목표일 {plan.snapshot.advance.targetDate || '미정'})</div>}
                </div>
              </div>
              <div className="row mt small">
                {y.quarters.map((q) => (
                  <button key={q.key} className="sm" onClick={() => { setSel({ year: y.academicYear, quarter: q.key }); setLevel('month'); }}>
                    {q.label}: {q.summary.lessonCount}회
                  </button>
                ))}
              </div>
            </div>
          ))}
          {years.length === 0 && <Empty>수업일이 없습니다.</Empty>}
        </div>
      )}

      {level === 'quarter' && (
        <div className="panel">
          <h2>분기 계획 (학년도 기준)</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>분기</th>
                  <th>기간</th>
                  <th className="num">수업</th>
                  <th className="num">휴강·보강</th>
                  <th className="num">새 진도</th>
                  <th>영역·교재별 배치</th>
                  <th>복습·평가 시점</th>
                  <th>단계·교재 전환</th>
                </tr>
              </thead>
              <tbody>
                {quarters.map((q: QuarterView) => (
                  <tr key={q.key}>
                    <td>
                      <button className="link" onClick={() => { setSel({ ...sel, quarter: q.key, month: undefined }); setLevel('month'); }}>
                        {q.label}
                      </button>
                    </td>
                    <td className="nowrap small">
                      {q.from} ~ {q.to}
                    </td>
                    <td className="num">{q.summary.lessonCount}</td>
                    <td className="num">
                      {q.summary.cancelledCount + q.summary.holidayCount} / {q.summary.makeupCount}
                    </td>
                    <td className="num">{fmtMinutes(q.summary.assignedMinutes)}</td>
                    <td className="small">
                      {q.summary.textbooks.map((t) => (
                        <div key={t.textbookId}>
                          {t.title}: {t.rangeText} ({fmtMinutes(t.minutes)})
                        </div>
                      ))}
                    </td>
                    <td className="small">
                      {q.summary.reviewDates.map((d) => `복습 ${d.slice(5)}`).join(', ')} {q.summary.assessmentDates.map((d) => `평가 ${d.slice(5)}`).join(', ')}
                      {!q.summary.reviewDates.length && !q.summary.assessmentDates.length && <span className="muted">회당 복습 {plan.settings.reviewMinutes}분</span>}
                    </td>
                    <td className="small">{q.transitions.join(', ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {level === 'month' && (
        <div className="panel">
          <div className="row between">
            <h2>월간 계획</h2>
            <select value={sel.month ?? ''} onChange={(e) => setSel({ ...sel, month: e.target.value || undefined, week: undefined })}>
              <option value="">전체 월</option>
              {months.map((m) => (
                <option key={m.key} value={m.key}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
          {months
            .filter((m) => !sel.month || m.key === sel.month)
            .map((m: MonthView) => (
              <div key={m.key} className="mb">
                <div className="row between">
                  <h3>{m.label}</h3>
                  <Summary s={m.summary} />
                </div>
                <div className="table-wrap">
                  <table className="compact">
                    <thead>
                      <tr>
                        <th>주</th>
                        <th>실제 수업일</th>
                        <th className="num">가능 분량</th>
                        <th className="num">배정</th>
                        <th>휴강·보강</th>
                        <th>트랙별 시간</th>
                        <th>주별 진도 (교재별 범위)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {m.weeks.map((w: WeekView) => (
                        <tr key={w.key}>
                          <td className="nowrap">
                            <button className="link" onClick={() => { setSel({ ...sel, month: m.key, week: w.key }); setLevel('week'); }}>
                              {w.label}
                            </button>
                            {w.spansMonths && <div className="muted" style={{ fontSize: 10 }}>월 걸침 (이 달 수업일만)</div>}
                          </td>
                          <td className="small">{w.days.filter((d) => d.lesson.status === 'scheduled' || d.lesson.status === 'makeup').map((d) => d.lesson.date.slice(5)).join(', ')}</td>
                          <td className="num">{w.summary.availableMinutes}분</td>
                          <td className="num">{w.summary.assignedMinutes}분</td>
                          <td className="small">
                            {w.days.filter((d) => d.lesson.status === 'cancelled' || d.lesson.status === 'holiday').map((d) => `${d.lesson.date.slice(5)} ${d.lesson.note}`).join(', ')}
                            {w.summary.makeupCount ? ` 보강 ${w.summary.makeupCount}` : ''}
                          </td>
                          <td className="small">
                            현행 {w.summary.byTrack.current} · 복습보충 {w.summary.byTrack.review} · 선행 {w.summary.byTrack.advance}
                          </td>
                          <td className="small">
                            {w.summary.textbooks.map((t) => (
                              <div key={t.textbookId}>
                                {t.title}: {t.rangeText}
                              </div>
                            ))}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          {months.length === 0 && <Empty>해당 기간에 수업이 없습니다.</Empty>}
        </div>
      )}

      {level === 'week' && (
        <div className="panel">
          <div className="row between">
            <h2>주간 계획</h2>
            <select value={sel.week ?? ''} onChange={(e) => setSel({ ...sel, week: e.target.value || undefined })}>
              <option value="">선택한 월의 모든 주</option>
              {weeks.map((w) => (
                <option key={w.key} value={w.key}>
                  {w.label}
                </option>
              ))}
            </select>
          </div>
          {weeks
            .filter((w) => !sel.week || w.key === sel.week)
            .map((w) => (
              <div key={w.key} className="mb">
                <div className="row between">
                  <h3>{w.label}</h3>
                  <Summary s={w.summary} />
                </div>
                <div className="table-wrap">
                  <table className="compact">
                    <thead>
                      <tr>
                        <th>날짜</th>
                        <th>차시 교재 범위</th>
                        <th>활동·트랙</th>
                        <th>과제</th>
                        <th>준비물</th>
                        <th>점검 사항</th>
                        <th>기록</th>
                      </tr>
                    </thead>
                    <tbody>
                      {w.days.map((d) => (
                        <tr key={d.lesson.id} className={`lesson-row ${d.lesson.status}`}>
                          <td className="nowrap">
                            <button className="link" onClick={() => { setSel({ ...sel, week: w.key, day: d.lesson.id }); setLevel('day'); }}>
                              {d.lesson.date.slice(5)}
                            </button>
                            <div className="muted" style={{ fontSize: 10 }}>{d.lesson.status === 'scheduled' ? `${d.lesson.availableMinutes}분` : d.lesson.status === 'makeup' ? '보강' : d.lesson.status === 'holiday' ? '공휴일' : '휴강'}</div>
                          </td>
                          <td>
                            {d.assignments.filter((a) => a.assignment.activity !== 'homework').map((a) => (
                              <div key={a.assignment.id}>
                                {a.textbookTitle.replace(/^\[가상\]\s*/, '')} <strong>{a.rangeText}</strong> <span className="muted">{a.itemTitle} · {a.assignment.minutes}분</span>
                                {a.assignment.locked && <Badge kind="warn">고정</Badge>}
                              </div>
                            ))}
                            {d.lesson.note && d.lesson.status !== 'scheduled' && <span className="muted">{d.lesson.note}</span>}
                          </td>
                          <td className="small">{[...new Set(d.assignments.filter((a) => a.assignment.activity !== 'homework').map((a) => `${a.activityLabel}/${a.trackLabel}`))].join(', ')}</td>
                          <td className="small">{d.assignments.filter((a) => a.assignment.activity === 'homework').map((a) => `${a.textbookTitle.replace(/^\[가상\]\s*/, '')} ${a.rangeText}`).join(', ')}</td>
                          <td className="small">{[...new Set(d.assignments.map((a) => a.materials).filter(Boolean))].join(', ')}</td>
                          <td className="small">{d.lesson.checklist}</td>
                          <td className="small">
                            {d.summary.recorded.done ? <Badge kind="ok">완료 {d.summary.recorded.done}</Badge> : null} {d.summary.recorded.partial ? <Badge kind="warn">부분 {d.summary.recorded.partial}</Badge> : null} {d.summary.recorded.not_done ? <Badge kind="danger">미진행 {d.summary.recorded.not_done}</Badge> : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
        </div>
      )}

      {level === 'day' && (
        <div className="panel">
          <div className="row between">
            <h2>일간 계획</h2>
            <select value={sel.day ?? ''} onChange={(e) => setSel({ ...sel, day: e.target.value || undefined })}>
              <option value="">선택한 주의 모든 날</option>
              {days.map((d) => (
                <option key={d.lesson.id} value={d.lesson.id}>
                  {d.dateLabel}
                </option>
              ))}
            </select>
          </div>
          {days
            .filter((d) => !sel.day || d.lesson.id === sel.day)
            .map((d) => (
              <DayCard key={d.lesson.id} d={d} plan={plan} reload={reload} />
            ))}
        </div>
      )}

      <div className="panel">
        <h3>교재별 진행 현황</h3>
        <p className="muted small">{v.completionBasis}</p>
        <div className="grid cols-2">
          {data.textbookProgress.map((tp) => (
            <div key={tp.textbookId} className="panel tight">
              <strong>{tp.title}</strong> <span className="muted small">{tp.edition}</span>
              {tp.byUnit.map((u) => (
                <div key={u.unit} className="mt small">
                  {u.unitLabel} 기준: 완료 {u.completed} / 전체 {u.total}
                  {u.excluded ? ` (제외 ${u.excluded})` : ''} · 계획 배정 {u.planned} → <strong>{Math.round(u.rate * 100)}%</strong>
                  <div className="bar mt" style={{ marginTop: 4 }}>
                    <div style={{ width: `${Math.round(u.rate * 100)}%` }} />
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function DayCard({ d, plan, reload }: { d: DayView; plan: PlanDoc; reload: () => void }) {
  const active = d.lesson.status === 'scheduled' || d.lesson.status === 'makeup';
  return (
    <div className="panel tight mb">
      <div className="row between">
        <strong>{d.dateLabel}</strong>
        {!active && <Badge>{d.lesson.status === 'holiday' ? '공휴일' : '휴강'}: {d.lesson.note}</Badge>}
      </div>
      {active && (
        <>
          <div className="small muted">시간 배분: {d.timeAllocation.filter((t) => t.minutes > 0).map((t) => `${t.label} ${t.minutes}분`).join(' · ')}</div>
          {d.objectives.length > 0 && <div className="small">학습 목표: {d.objectives.join(' / ')}</div>}
          <div className="table-wrap mt">
            <table className="compact">
              <thead>
                <tr>
                  <th>교재 범위</th>
                  <th>활동</th>
                  <th className="num">분</th>
                  <th>실제 완료</th>
                  <th>남은 범위</th>
                  <th>입력</th>
                </tr>
              </thead>
              <tbody>
                {d.assignments.map((a) => (
                  <tr key={a.assignment.id}>
                    <td>
                      {a.textbookTitle.replace(/^\[가상\]\s*/, '')} <strong>{a.rangeText}</strong> {a.pdfRangeText && <span className="muted small">({a.pdfRangeText})</span>}
                      <div className="muted small">
                        {a.itemTitle}
                        {a.teachingNote ? ` · 메모: ${a.teachingNote}` : ''}
                        {a.materials ? ` · 준비물: ${a.materials}` : ''}
                      </div>
                      {a.continuedFrom && <Badge kind="info">이어서 진행</Badge>} {a.assignment.locked && <Badge kind="warn">고정</Badge>}
                    </td>
                    <td className="small">
                      {a.activityLabel}
                      <br />
                      <span className="muted">{a.trackLabel}</span>
                    </td>
                    <td className="num">{a.assignment.minutes}</td>
                    <td>
                      <Badge kind={a.record?.status === 'done' ? 'ok' : a.record?.status === 'partial' ? 'warn' : a.record ? 'danger' : ''}>{a.recordLabel}</Badge>
                      {a.record?.note && <div className="muted small">{a.record.note}</div>}
                    </td>
                    <td className="small">{a.remainingText}</td>
                    <td>
                      <RecordControls planId={plan.id} version={plan.version} view={a} onSaved={reload} compact />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────
// 미배정
// ──────────────────────────────────────────────

function UnassignedTab({ plan, runOp }: { plan: PlanDoc; runOp: (op: string, params: Record<string, unknown>, direct?: boolean) => void }) {
  const { ask, element: promptEl } = usePrompt();
  const itemTitle = (tbId: string, itemId: string) => plan.snapshot.textbooks.find((t) => t.id === tbId)?.items.find((i) => i.id === itemId)?.title ?? itemId;
  const pending = plan.unassigned.filter((u) => u.reason !== 'excluded');
  const excluded = plan.unassigned.filter((u) => u.reason === 'excluded');
  return (
    <div className="panel">
      {promptEl}
      <h2>미배정 범위</h2>
      <p className="muted small">배치 실패가 곧 '어떤 방법으로도 불가능'은 아닙니다. 사유별로 기간 연장·보강·분할 허용·선수 항목 배치·고정 일정 조정을 검토하세요. 분량을 지우거나 자동으로 숙제로 돌리지 않습니다.</p>
      {pending.length === 0 ? (
        <Alert kind="ok">미배정 범위가 없습니다.</Alert>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>항목</th>
                <th>범위</th>
                <th className="num">분</th>
                <th>트랙·활동</th>
                <th>사유</th>
                <th>설명</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {pending.map((u) => (
                <tr key={u.id}>
                  <td>
                    {itemTitle(u.textbookId, u.itemId)} <span className="muted small">{u.sessionOrder}차시</span>
                  </td>
                  <td>{u.portion ? `${u.portion.from}~${u.portion.to}` : u.fraction !== undefined ? `${Math.round(u.fraction * 100)}%` : '전체'}</td>
                  <td className="num">{u.minutes}</td>
                  <td className="small">
                    {u.track} / {u.activity}
                  </td>
                  <td>
                    <Badge kind="danger">{UNASSIGNED_REASON_LABEL[u.reason]}</Badge>
                  </td>
                  <td className="small">{u.detail}</td>
                  <td>
                    <button className="sm" onClick={async () => { const reason = await ask({ title: '이 계획에서 제외', label: '제외 사유 (교재 원본은 삭제되지 않습니다)' }); if (reason !== null) runOp('exclude', { unassignedId: u.id, reason }, true); }}>
                      이 계획에서 제외
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="row mt">
        <button onClick={() => runOp('reschedule', { fromDate: todayKST() })}>남은 일정 재편성 (오늘부터)</button>
        <button onClick={async () => { const d = await ask({ title: '보강일 추가', label: '보강일', type: 'date', defaultValue: todayKST() }); if (d) runOp('add_makeup', { date: d, note: '보강' }); }}>보강일 추가</button>
      </div>
      {excluded.length > 0 && (
        <>
          <h3 className="mt">제외 처리됨</h3>
          <ul className="small">
            {excluded.map((u) => (
              <li key={u.id}>
                {itemTitle(u.textbookId, u.itemId)} {u.portion ? `${u.portion.from}~${u.portion.to}` : ''} ({u.minutes}분) — {u.detail}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────
// 일정 수정
// ──────────────────────────────────────────────

function EditTab({ plan, runOp, openSettings }: { plan: PlanDoc; runOp: (op: string, params: Record<string, unknown>, direct?: boolean) => void; openSettings: () => void }) {
  const [swapA, setSwapA] = useState('');
  const [pin, setPin] = useState<{ assignmentId: string; date: string } | null>(null);
  const [from, setFrom] = useState(todayKST());
  const { ask, element: promptEl } = usePrompt();
  const recorded = useMemo(() => new Set(plan.records.map((r) => r.assignmentId)), [plan.records]);
  const lessonDates = plan.lessons.filter((l) => l.status === 'scheduled' || l.status === 'makeup').map((l) => l.date);
  return (
    <div className="panel">
      {promptEl}
      <h2>안전한 일정 수정</h2>
      <p className="muted small">모든 변경은 적용 전 영향받는 수업·미배정 범위·종료일 변화를 비교해 보여주고, 적용 후 되돌릴 수 있습니다. 완료 기록이 있는 배정과 고정 배정은 재편성으로 바뀌지 않습니다.</p>
      <div className="row mb">
        <label className="check">
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <button onClick={() => runOp('reschedule', { fromDate: from })}>이 날짜부터 남은 일정 전체 재편성</button>
        <button onClick={async () => { const d = await ask({ title: '보강일 추가', label: '보강일', type: 'date', defaultValue: from }); if (d) runOp('add_makeup', { date: d, note: '보강' }); }}>보강일 추가</button>
        <button onClick={openSettings}>편성 설정 변경 (요일·시간·휴일·트랙)</button>
      </div>
      {swapA && <Alert kind="info">맞바꿀 두 번째 수업의 '맞바꾸기' 버튼을 누르세요. (첫 번째: {plan.lessons.find((l) => l.id === swapA)?.date}) <button className="sm" onClick={() => setSwapA('')}>취소</button></Alert>}
      <div className="table-wrap">
        <table className="compact">
          <thead>
            <tr>
              <th>날짜</th>
              <th>상태</th>
              <th className="num">가능/배정</th>
              <th>배정 항목 (클릭: 고정·이동)</th>
              <th>수업 동작</th>
            </tr>
          </thead>
          <tbody>
            {plan.lessons.map((l) => {
              const views = assignmentViews(plan, l);
              const used = views.filter((v) => v.assignment.activity !== 'homework').reduce((s, v) => s + v.assignment.minutes, 0);
              const active = l.status === 'scheduled' || l.status === 'makeup';
              const hasRecord = views.some((v) => recorded.has(v.assignment.id));
              return (
                <tr key={l.id} className={`lesson-row ${l.status}`}>
                  <td className="nowrap">{l.date}</td>
                  <td>{l.status === 'scheduled' ? '수업' : l.status === 'makeup' ? '보강' : l.status === 'holiday' ? '공휴일' : '휴강'}{l.note && l.status !== 'scheduled' ? ` · ${l.note}` : ''}</td>
                  <td className={`num ${used > l.availableMinutes ? 'badge danger' : ''}`}>
                    {l.availableMinutes}/{used}
                  </td>
                  <td>
                    {views.map((v) => (
                      <span key={v.assignment.id} className={`assign-chip ${v.assignment.locked ? 'locked' : ''} ${v.record?.status ?? ''} ${v.assignment.activity === 'homework' ? 'hw' : ''}`} title={`${v.itemTitle} · ${v.activityLabel} · ${v.trackLabel}`}>
                      {v.textbookTitle.replace(/^\[가상\]\s*/, '').slice(0, 10)} {v.rangeText} {v.assignment.minutes}분{v.assignment.locked ? ' 📌' : ''}
                      {!recorded.has(v.assignment.id) && (
                        <>
                          {' '}
                          <button className="link" style={{ fontSize: 11 }} onClick={() => setPin({ assignmentId: v.assignment.id, date: l.date })}>
                            고정/이동
                          </button>
                          {v.assignment.locked && (
                            <button className="link" style={{ fontSize: 11 }} onClick={() => runOp('unpin', { assignmentId: v.assignment.id }, true)}>
                              해제
                            </button>
                          )}
                        </>
                      )}
                    </span>
                  ))}
                  </td>
                  <td className="nowrap">
                    {active && !hasRecord && (
                      <>
                        <button className="sm" onClick={() => runOp('postpone', { lessonId: l.id })} title="이 수업의 새 진도를 다음 수업 가능일로 미루고 뒤를 밀어냅니다">
                          미루기
                        </button>{' '}
                        <button className="sm" onClick={async () => { const r = await ask({ title: `${l.date} 휴강 처리`, label: '휴강 사유', defaultValue: '휴강' }); if (r !== null) runOp('cancel_lesson', { lessonId: l.id, reason: r }); }}>
                          휴강
                        </button>{' '}
                        <button className="sm" onClick={() => (swapA && swapA !== l.id ? (runOp('swap', { lessonIdA: swapA, lessonIdB: l.id }), setSwapA('')) : setSwapA(l.id))}>
                          맞바꾸기
                        </button>
                      </>
                    )}
                    {hasRecord && <span className="muted small">기록 있음 (보호)</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {pin && (
        <Modal title="특정 날짜에 고정 / 이동" onClose={() => setPin(null)}>
          <p className="small">선택한 날짜의 수업에 이 배정을 추가하고 고정합니다. 이전 날짜로 당겨도 그 수업의 기존 배정은 삭제하거나 덮어쓰지 않으며, 가능시간 초과는 경고로 알립니다.</p>
          <select value={pin.date} onChange={(e) => setPin({ ...pin, date: e.target.value })}>
            {lessonDates.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
          <div className="row mt" style={{ justifyContent: 'flex-end' }}>
            <button onClick={() => setPin(null)}>취소</button>
            <button className="primary" onClick={() => { runOp('pin', { assignmentId: pin.assignmentId, date: pin.date }); setPin(null); }}>
              비교 보기
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────
// 진도 기록
// ──────────────────────────────────────────────

function RecordsTab({ plan, reload }: { plan: PlanDoc; reload: () => void }) {
  const today = todayKST();
  const [showFuture, setShowFuture] = useState(false);
  const lessons = plan.lessons.filter((l) => (l.status === 'scheduled' || l.status === 'makeup') && (showFuture || l.date <= today));
  return (
    <div className="panel">
      <div className="row between">
        <h2>실제 진도 기록</h2>
        <label className="check">
          <input type="checkbox" checked={showFuture} onChange={(e) => setShowFuture(e.target.checked)} /> 미래 수업도 표시
        </label>
      </div>
      <p className="muted small">완료 / 부분 완료 / 미진행 / 제외(사유)를 기록합니다. 배정한 숙제를 완료로 자동 처리하지 않으며, 복습으로 같은 범위를 다시 진행해도 새 진도 완료량은 늘지 않습니다.</p>
      {lessons.length === 0 && <Empty>기록할 수업이 없습니다.</Empty>}
      {lessons.map((l) => {
        const views = assignmentViews(plan, l);
        return (
          <div key={l.id} className="panel tight mb">
            <strong>{l.date}</strong> <span className="muted small">{l.status === 'makeup' ? '보강' : ''} {l.note}</span>
            {views.length === 0 && <div className="muted small">배정 없음</div>}
            {views.map((v) => (
              <div key={v.assignment.id} className="row between" style={{ borderTop: '1px solid var(--line)', paddingTop: 4, marginTop: 4 }}>
                <div className="small">
                  {v.textbookTitle.replace(/^\[가상\]\s*/, '')} <strong>{v.rangeText}</strong> {v.itemTitle} · {v.activityLabel} · {v.assignment.minutes}분 <Badge kind={v.record?.status === 'done' ? 'ok' : v.record?.status === 'partial' ? 'warn' : v.record ? 'danger' : ''}>{v.recordLabel}</Badge>
                  {v.remainingText && <span className="muted"> 남은 {v.remainingText}</span>}
                </div>
                <RecordControls planId={plan.id} version={plan.version} view={v} onSaved={reload} compact />
              </div>
            ))}
            <UnderstandingCheckForm plan={plan} lessonId={l.id} reload={reload} />
          </div>
        );
      })}
    </div>
  );
}

function UnderstandingCheckForm({ plan, lessonId, reload }: { plan: PlanDoc; lessonId: string; reload: () => void }) {
  const [open, setOpen] = useState(false);
  const [itemId, setItemId] = useState('');
  const [result, setResult] = useState<'confirmed' | 'needs_review' | 'not_confirmed'>('confirmed');
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const items = plan.assignments.filter((a) => a.lessonId === lessonId).map((a) => ({ a, item: plan.snapshot.textbooks.find((t) => t.id === a.textbookId)?.items.find((i) => i.id === a.itemId) }));
  const checks = plan.understandingChecks.filter((c) => c.lessonId === lessonId);
  return (
    <div className="mt small">
      {checks.map((c) => (
        <div key={c.id} className="muted">
          이해 확인: {plan.snapshot.textbooks.flatMap((t) => t.items).find((i) => i.id === c.itemId)?.title} — {c.result === 'confirmed' ? '확인됨' : c.result === 'needs_review' ? '보충 필요' : '미확인'} {c.note}
        </div>
      ))}
      {!open ? (
        <button className="link" onClick={() => setOpen(true)}>
          + 이해 확인 기록
        </button>
      ) : (
        <div className="row">
          <select value={itemId} onChange={(e) => setItemId(e.target.value)}>
            <option value="">항목 선택</option>
            {items.map(({ a, item }) => (
              <option key={a.id} value={a.itemId}>
                {item?.title}
              </option>
            ))}
          </select>
          <select value={result} onChange={(e) => setResult(e.target.value as typeof result)}>
            <option value="confirmed">이해 확인됨</option>
            <option value="needs_review">보충 필요</option>
            <option value="not_confirmed">미확인</option>
          </select>
          <input placeholder="메모" value={note} onChange={(e) => setNote(e.target.value)} />
          <button
            className="sm primary"
            disabled={!itemId}
            onClick={async () => {
              const it = items.find((x) => x.a.itemId === itemId);
              try {
                await post(`/api/plans/${plan.id}/checks`, { lessonId, itemId, textbookId: it?.a.textbookId, objectiveIds: it?.item?.objectiveIds ?? [], result, note, version: plan.version });
                setOpen(false);
                reload();
              } catch (e) {
                setErr(errorMessage(e));
              }
            }}
          >
            저장
          </button>
          {err && <span className="badge danger">{err}</span>}
        </div>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────
// 학습목표
// ──────────────────────────────────────────────

function ObjectivesTab({ plan, onPlan }: { plan: PlanDoc; onPlan: (p: PlanDoc) => void }) {
  const { data, loading } = useAsync(() => get<{ statuses: ObjectiveStatus[]; advanceGaps: Array<{ objective: LearningObjective; reason: string }> }>(`/api/plans/${plan.id}/objectives`), [plan.version]);
  if (loading || !data) return <Loading />;
  const kind: Record<string, string> = { planned: 'info', progressed: 'primary', confirmed: 'ok', unassigned: 'danger' };
  const missing = data.statuses.filter((s) => s.required && s.state === 'unassigned');
  return (
    <div className="panel">
      <h2>학습목표 지도</h2>
      <p className="muted small">계획에 들어 있다는 이유로 습득으로 표시하지 않습니다. 필수 목표는 기본 정보에서 지정합니다.</p>
      {missing.length > 0 && <Alert kind="warn">필수 목표 누락: {missing.map((m) => `${m.code} ${m.title}`).join(', ')}</Alert>}
      {data.advanceGaps.length > 0 && (
        <Alert kind="warn">
          선행 전 기초 확인이 부족합니다. 보충 과정을 먼저 제안합니다 (담당자 확정 필요):
          {data.advanceGaps.map((g) => (
            <div key={g.objective.id}>
              · {g.objective.code} {g.objective.title} — {g.reason}
            </div>
          ))}
        </Alert>
      )}
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
              <th>반복 (목적)</th>
            </tr>
          </thead>
          <tbody>
            {data.statuses.map((s) => (
              <tr key={s.objectiveId}>
                <td>
                  <strong>{s.code}</strong> {s.title}
                </td>
                <td>{s.required ? <Badge kind="primary">필수</Badge> : ''}</td>
                <td>
                  <Badge kind={kind[s.state]}>{OBJECTIVE_STATE_LABEL[s.state]}</Badge>
                </td>
                <td className="small">{s.plannedDates.map((d) => d.slice(5)).join(', ')}</td>
                <td className="small">{s.progressedDates.map((d) => d.slice(5)).join(', ')}</td>
                <td className="small">{s.confirmedDates.map((d) => d.slice(5)).join(', ')}</td>
                <td className="small">
                  {s.occurrences.length > 1 ? s.occurrences.map((o) => `${o.date.slice(5)} ${o.purpose || o.activity}`).join(', ') : ''}
                  {s.repeatWithoutPurpose.length > 0 && (
                    <div title="서로 다른 항목이 새 학습으로 같은 목표를 다시 다룹니다. 의도한 반복이면 과정 조립판에서 반복 목적(복습·심화·평가)을 지정하세요. 자동으로 지우지 않습니다.">
                      <Badge kind="warn">목적 확인</Badge> {s.repeatWithoutPurpose.join(', ')}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {plan.snapshot.advance && <SupplementPanel plan={plan} onPlan={onPlan} />}
    </div>
  );
}

interface SupplementData {
  advance: NonNullable<PlanDoc['snapshot']['advance']> | null;
  objectives: Array<{ objective: LearningObjective; reason: string; viaPrerequisiteOf?: string }>;
  items: Array<{ objectiveId: string; textbookId: string; textbookTitle: string; edition: string; itemId: string; itemTitle: string; range?: { from: number; to: number }; minutes: number }>;
  objectivesWithoutMaterial: string[];
}

/** 선수 학습 부족 시 보충 제안과 담당자 확인 절차 */
function SupplementPanel({ plan, onPlan }: { plan: PlanDoc; onPlan: (p: PlanDoc) => void }) {
  const { user } = useAuth();
  const nav = useNavigate();
  const { data, loading, reload } = useAsync(() => get<SupplementData>(`/api/plans/${plan.id}/supplement`), [plan.version]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (data) setPicked(new Set(data.items.map((i) => `${i.textbookId}|${i.itemId}`)));
  }, [data]);
  if (loading || !data) return null;
  const adv = data.advance!;
  const key = (i: SupplementData['items'][number]) => `${i.textbookId}|${i.itemId}`;
  const objName = (id: string) => {
    const o = data.objectives.find((x) => x.objective.id === id)?.objective;
    return o ? `${o.code} ${o.title}` : id;
  };
  const pickedItems = data.items.filter((i) => picked.has(key(i)));
  const uniquePicked = pickedItems.filter((i, idx) => pickedItems.findIndex((x) => key(x) === key(i)) === idx);
  const createDraft = async () => {
    setBusy(true);
    setErr('');
    try {
      const c = await post<{ id: string }>(`/api/plans/${plan.id}/supplement-curriculum`, { items: uniquePicked.map((i) => ({ textbookId: i.textbookId, itemId: i.itemId })) });
      nav(`/curricula/${c.id}`);
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const confirm = async (confirmed: boolean) => {
    setBusy(true);
    setErr('');
    try {
      onPlan(await post<PlanDoc>(`/api/plans/${plan.id}/advance-confirm`, { confirmed, note, version: plan.version }));
      setNote('');
      reload();
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="panel tight mt supplement-panel">
      <h3>선행 기초 확인과 보충 제안</h3>
      <p className="small">
        선행 목표: {adv.targetDescription || '-'} · 현재 학년 {adv.currentGrade || '-'} · 실제 단계 {adv.actualStage || '-'} · 현행 확보 {adv.currentMinMinutes}분
      </p>
      <p className="small">
        기초 확인 상태:{' '}
        {adv.prerequisitesConfirmed ? (
          <Badge kind="ok">
            확인됨 ({adv.prerequisitesConfirmedBy} · {adv.prerequisitesConfirmedAt?.slice(0, 10)})
          </Badge>
        ) : (
          <Badge kind="warn">미확인 · 확인 전에는 계획을 확정할 수 없습니다</Badge>
        )}
      </p>
      {err && <Alert kind="danger">{err}</Alert>}
      {data.objectives.length === 0 ? (
        <Alert kind="ok">기초 확인 항목이 모두 이해 확인 기록을 가지고 있습니다. 담당자가 확인하면 선행을 진행할 수 있습니다.</Alert>
      ) : (
        <>
          <p className="small muted">아래 목표는 이해 확인 기록이 없습니다. 선수 목표는 담당자가 확인한 관계만 따라갔습니다. 제안일 뿐이며, 보충을 먼저 할지·선행을 그대로 진행할지는 담당자가 정합니다.</p>
          <ul className="small">
            {data.objectives.map((o) => (
              <li key={o.objective.id}>
                <strong>{o.objective.code}</strong> {o.objective.title} — {o.reason}
                {data.objectivesWithoutMaterial.includes(o.objective.id) && <Badge kind="danger">연결된 교재 항목 없음 · 자료 준비 필요</Badge>}
              </li>
            ))}
          </ul>
          {data.items.length > 0 && (
            <div className="table-wrap">
              <table className="compact">
                <thead>
                  <tr>
                    <th></th>
                    <th>목표</th>
                    <th>교재 (판본)</th>
                    <th>학습항목</th>
                    <th>범위</th>
                    <th className="num">분</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((i, idx) => (
                    <tr key={`${key(i)}-${i.objectiveId}-${idx}`}>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`${i.itemTitle} 보충에 포함`}
                          checked={picked.has(key(i))}
                          onChange={(e) => {
                            const n = new Set(picked);
                            if (e.target.checked) n.add(key(i));
                            else n.delete(key(i));
                            setPicked(n);
                          }}
                        />
                      </td>
                      <td className="small">{objName(i.objectiveId)}</td>
                      <td className="small">
                        {i.textbookTitle} <span className="muted">({i.edition})</span>
                      </td>
                      <td>{i.itemTitle}</td>
                      <td className="small">{i.range ? `${i.range.from}~${i.range.to}쪽` : ''}</td>
                      <td className="num">{i.minutes}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {user?.role === 'admin' ? (
            <div className="row mt">
              <button className="primary" disabled={busy || uniquePicked.length === 0} onClick={createDraft}>
                고른 {uniquePicked.length}개 항목으로 보충 과정 초안 만들기
              </button>
              <span className="small muted">복습·보충 트랙의 초안 과정이 만들어지며, 검토 후 계획 만들기에서 사용합니다.</span>
            </div>
          ) : (
            <p className="small muted mt">보충 과정 초안은 관리자가 만듭니다. 이 목록을 관리자에게 전달하세요.</p>
          )}
        </>
      )}
      <div className="row mt">
        <input style={{ flex: 1, minWidth: 220 }} placeholder="확인 근거 (예: 10/12 진단평가 85점, 1~3단원 이해 확인 기록)" value={note} onChange={(e) => setNote(e.target.value)} aria-label="기초 확인 근거" />
        {adv.prerequisitesConfirmed ? (
          <button disabled={busy} onClick={() => confirm(false)}>
            기초 확인 해제
          </button>
        ) : (
          <button className="accent" disabled={busy || !note.trim()} onClick={() => confirm(true)}>
            담당자 기초 확인
          </button>
        )}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────
// 이력
// ──────────────────────────────────────────────

function HistoryTab({ plan, runOp }: { plan: PlanDoc; runOp: (op: string, params: Record<string, unknown>, direct?: boolean) => void }) {
  const undoableId = latestUndoableId(plan);
  const { data: audit } = useAsync(() => get<Array<{ at: string; userId: string; action: string; detail: string }>>(`/api/plans/${plan.id}/audit`), [plan.version]);
  const { data: users } = useAsync(() => get<User[]>('/api/users').catch(() => [] as User[]), []);
  const name = (id: string) => users?.find((u) => u.id === id)?.displayName ?? id.slice(0, 8);
  return (
    <div className="panel">
      <h2>변경 이력 · 버전</h2>
      <p className="muted small">계획 v{plan.planVersion} · 과정 {plan.snapshot.curriculumTitle} v{plan.snapshot.curriculumVersion} (스냅샷 {plan.snapshot.takenAt.slice(0, 10)}) · 교재 {plan.snapshot.textbooks.map((t) => `${t.title} ${t.edition} (v${t.textbookVersion})`).join(', ')}{plan.confirmedAt ? ` · 확정 ${plan.confirmedAt.slice(0, 10)}` : ''}</p>
      <div className="table-wrap">
        <table className="compact">
          <thead>
            <tr>
              <th>시각</th>
              <th>누가</th>
              <th>무엇을</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {[...plan.history].reverse().map((h) => (
              <tr key={h.id} style={h.undone ? { opacity: 0.5, textDecoration: 'line-through' } : undefined}>
                <td className="nowrap">{h.at.slice(0, 16).replace('T', ' ')}</td>
                <td>{name(h.by)}</td>
                <td>
                  <Badge>{h.action}</Badge> {h.description}
                </td>
                <td>
                  {h.id === undoableId && (
                    <button className="sm" onClick={() => runOp('undo', { historyId: h.id })} title="이 변경 이후 입력된 실제 기록이 있으면 되돌릴 수 없습니다">
                      되돌리기
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {audit && audit.length > 0 && (
        <details className="mt">
          <summary className="small muted">서버 감사 로그 ({audit.length})</summary>
          <ul className="small">
            {audit.map((a, i) => (
              <li key={i}>
                {a.at.slice(0, 16).replace('T', ' ')} {name(a.userId)} {a.action} {a.detail}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────
// 출력
// ──────────────────────────────────────────────

function OutputTab({ plan, onPlan }: { plan: PlanDoc; onPlan: (p: PlanDoc) => void }) {
  const [audience, setAudience] = useState<'teacher' | 'student'>('teacher');
  const [templateId, setTemplateId] = useState('');
  const [levels, setLevels] = useState<Level[]>(['year', 'quarter', 'month', 'week', 'day']);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const { data: templates } = useAsync(() => get<OutputTemplate[]>('/api/templates'), []);
  const template = templates?.find((t) => t.id === templateId);
  const effectiveAudience = template ? template.audience : audience;
  const q = `audience=${effectiveAudience}&levels=${levels.join(',')}${from && to ? `&from=${from}&to=${to}` : ''}${templateId ? `&template=${templateId}` : ''}`;
  const toggle = (l: Level) => setLevels(levels.includes(l) ? levels.filter((x) => x !== l) : [...levels, l]);
  return (
    <div className="panel">
      <h2>출력</h2>
      <div className="grid cols-3">
        <Field label="출력 양식" hint="열 구성은 설정 → 출력 양식에서 바꿉니다. 학생·학부모용 양식은 내부 메모 열을 출력하지 않습니다.">
          <select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
            <option value="">기본 양식 (대상별 기본 열)</option>
            {(templates ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({t.audience === 'teacher' ? '강사용' : '학생·학부모용'})
              </option>
            ))}
          </select>
          {template && <small className="muted">열: {resolveColumns(template, template.audience).map((c) => c.label).join(', ')}</small>}
        </Field>
        <Field label="대상">
          <select value={effectiveAudience} disabled={!!template} onChange={(e) => setAudience(e.target.value as typeof audience)}>
            <option value="teacher">강사용 (지도 메모·시간 배분 포함)</option>
            <option value="student">학생·학부모용 (학습목표·범위·과제 중심, 내부 메모 제외)</option>
          </select>
        </Field>
        <Field label="포함할 계획표">
          <div className="row">
            {(['year', 'quarter', 'month', 'week', 'day'] as Level[]).map((l) => (
              <label key={l} className="check">
                <input type="checkbox" checked={levels.includes(l)} onChange={() => toggle(l)} /> {{ year: '연간', quarter: '분기', month: '월간', week: '주간', day: '일간' }[l]}
              </label>
            ))}
            <button className="sm" onClick={() => setLevels(['year', 'quarter', 'month', 'week', 'day'])}>
              5종 일괄
            </button>
          </div>
        </Field>
        <Field label="선택 기간 (비우면 전체)">
          <div className="row">
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /> ~ <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
        </Field>
      </div>
      <div className="row mt">
        <a className="btn primary" href={`/print/plans/${plan.id}?${q}`} target="_blank" rel="noreferrer">
          A4 인쇄 보기 / PDF 저장
        </a>
        <a className="btn" href={`/api/plans/${plan.id}/export.xlsx?${q}`}>
          엑셀 다운로드
        </a>
        <a className="btn" href={`/api/plans/${plan.id}/calendar.ics?audience=${effectiveAudience}`} title="구글·애플·아웃룩 캘린더의 '가져오기'로 수업일을 넣습니다. 다시 내보내 가져오면 같은 일정이 갱신됩니다.">
          캘린더 파일(.ics)
        </a>
      </div>
      <p className="muted small mt">PDF는 인쇄 보기에서 브라우저의 'PDF로 저장'을 사용합니다. 화면·엑셀·인쇄 모두 같은 집계 함수를 사용하므로 범위·시간·버전이 일치합니다 (계획 v{plan.planVersion}). 캘린더 파일은 수업마다 종일 일정 하나이며, 학생·학부모용은 지도 메모를 넣지 않습니다.</p>
      <CalendarFeeds plan={plan} onPlan={onPlan} />
    </div>
  );
}

/** 캘린더 구독 주소: 캘린더 앱의 'URL로 구독'에 넣으면 일정 변경이 자동으로 반영된다 */
function CalendarFeeds({ plan, onPlan }: { plan: PlanDoc; onPlan: (p: PlanDoc) => void }) {
  const [audience, setAudience] = useState<'teacher' | 'student'>('student');
  const [label, setLabel] = useState('');
  const [err, setErr] = useState('');
  const [copied, setCopied] = useState('');
  const feeds = plan.calendarFeeds ?? [];
  const urlOf = (token: string) => `${window.location.origin}/api/feeds/${token}.ics`;
  const create = async () => {
    setErr('');
    try {
      onPlan(await post<PlanDoc>(`/api/plans/${plan.id}/calendar-feeds`, { audience, label, version: plan.version }));
      setLabel('');
    } catch (e) {
      setErr(errorMessage(e));
    }
  };
  const revoke = async (token: string) => {
    setErr('');
    try {
      onPlan(await post<PlanDoc>(`/api/plans/${plan.id}/calendar-feeds/revoke`, { token, version: plan.version }));
    } catch (e) {
      setErr(errorMessage(e));
    }
  };
  return (
    <div className="panel tight mt calendar-feeds">
      <h3>캘린더 구독 주소</h3>
      <p className="muted small">
        캘린더 앱의 'URL로 구독(구독 캘린더 추가)'에 넣으면 일정이 바뀔 때마다 앱이 자동으로 다시 받아 갑니다. 이 주소는 로그인 없이 열리므로 필요한 사람에게만 알려 주고, 더 이상 쓰지 않으면 폐기하세요. 구글 캘린더 등 인터넷 서비스에서 구독하려면 이 서버가 인터넷에서 열려 있어야 합니다(배포 가이드 참고). 같은 와이파이의 기기에서는 바로 쓸 수 있습니다.
      </p>
      {err && <Alert kind="danger">{err}</Alert>}
      {feeds.length === 0 ? (
        <p className="small muted">아직 만든 구독 주소가 없습니다.</p>
      ) : (
        <div className="table-wrap">
          <table className="compact">
            <thead>
              <tr>
                <th>이름</th>
                <th>대상</th>
                <th>주소</th>
                <th>만든 날</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {feeds.map((f) => (
                <tr key={f.token}>
                  <td>{f.label}</td>
                  <td>{f.audience === 'student' ? '학생·학부모용' : '강사용'}</td>
                  <td className="small" style={{ wordBreak: 'break-all' }}>
                    <code>{urlOf(f.token)}</code>
                  </td>
                  <td className="small nowrap">{f.createdAt.slice(0, 10)}</td>
                  <td className="nowrap">
                    <button
                      className="sm"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(urlOf(f.token));
                          setCopied(f.token);
                        } catch {
                          setErr('복사하지 못했습니다. 주소를 직접 선택해 복사하세요.');
                        }
                      }}
                    >
                      {copied === f.token ? '복사됨' : '복사'}
                    </button>{' '}
                    <button className="sm danger" onClick={() => revoke(f.token)}>
                      폐기
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="row mt">
        <select value={audience} onChange={(e) => setAudience(e.target.value as typeof audience)} aria-label="구독 대상">
          <option value="student">학생·학부모용 (지도 메모 제외)</option>
          <option value="teacher">강사용</option>
        </select>
        <input placeholder="이름 (예: 초5 A반 학부모)" value={label} onChange={(e) => setLabel(e.target.value)} aria-label="구독 주소 이름" />
        <button onClick={create}>구독 주소 만들기</button>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────
// 기본 정보·설정 모달
// ──────────────────────────────────────────────

function MetaModal({ plan, isAdmin, onClose, onSaved }: { plan: PlanDoc; isAdmin: boolean; onClose: () => void; onSaved: (p: PlanDoc) => void }) {
  const [f, setF] = useState({ title: plan.title, target: plan.target, classOrStudentRef: plan.classOrStudentRef, author: plan.author, reviewer: plan.reviewer, requiredObjectiveIds: plan.requiredObjectiveIds, allowedUserIds: plan.allowedUserIds, archived: plan.archived });
  const { data: objectives } = useAsync(() => get<LearningObjective[]>('/api/objectives'), []);
  const { data: users } = useAsync(() => (isAdmin ? get<User[]>('/api/users') : Promise.resolve([] as User[])), []);
  const [err, setErr] = useState('');
  return (
    <Modal title="계획 기본 정보" onClose={onClose}>
      {err && <Alert kind="danger">{err}</Alert>}
      <div className="grid cols-2">
        <Field label="계획명">
          <input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
        </Field>
        <Field label="대상">
          <input value={f.target} onChange={(e) => setF({ ...f, target: e.target.value })} />
        </Field>
        <Field label="반·학생 식별 (선택, 복제 시 제외)">
          <input value={f.classOrStudentRef} onChange={(e) => setF({ ...f, classOrStudentRef: e.target.value })} />
        </Field>
        <Field label="작성자">
          <input value={f.author} onChange={(e) => setF({ ...f, author: e.target.value })} />
        </Field>
        <Field label="검토자">
          <input value={f.reviewer} onChange={(e) => setF({ ...f, reviewer: e.target.value })} />
        </Field>
        <Field label="보관">
          <label className="check">
            <input type="checkbox" checked={f.archived} onChange={(e) => setF({ ...f, archived: e.target.checked })} /> 보관 처리
          </label>
        </Field>
        <Field label="이 과정에 필수인 학습목표">
          <select multiple size={5} value={f.requiredObjectiveIds} onChange={(e) => setF({ ...f, requiredObjectiveIds: [...e.target.selectedOptions].map((o) => o.value) })}>
            {(objectives ?? []).map((o) => (
              <option key={o.id} value={o.id}>
                {o.code} {o.title}
              </option>
            ))}
          </select>
        </Field>
        {isAdmin && (
          <Field label="허용 강사">
            <select multiple size={5} value={f.allowedUserIds} onChange={(e) => setF({ ...f, allowedUserIds: [...e.target.selectedOptions].map((o) => o.value) })}>
              {(users ?? []).filter((u) => u.role === 'teacher').map((u) => (
                <option key={u.id} value={u.id}>
                  {u.displayName} ({u.username})
                </option>
              ))}
            </select>
          </Field>
        )}
      </div>
      <div className="row mt" style={{ justifyContent: 'flex-end' }}>
        <button onClick={onClose}>취소</button>
        <button className="primary" onClick={() => put<PlanDoc>(`/api/plans/${plan.id}`, { ...f, version: plan.version }).then(onSaved).catch((e) => setErr(errorMessage(e)))}>
          저장
        </button>
      </div>
    </Modal>
  );
}

function SettingsModal({ plan, onClose, onPreview }: { plan: PlanDoc; onClose: () => void; onPreview: (s: PlanSettings) => void }) {
  const [s, setS] = useState<PlanSettings>(structuredClone(plan.settings));
  const [adv, setAdv] = useState(true);
  const { data: holidaySets } = useAsync(() => get<HolidaySet[]>('/api/holiday-sets'), []);
  return (
    <Modal title="편성 설정 변경" onClose={onClose} wide>
      <p className="muted small">변경 후 완료 기록·고정 배정을 제외한 남은 일정을 다시 편성합니다. 적용 전 비교를 보여줍니다.</p>
      <SettingsForm s={s} onChange={setS} holidaySets={holidaySets ?? []} showAdvanced={adv} setShowAdvanced={setAdv} />
      <div className="row mt" style={{ justifyContent: 'flex-end' }}>
        <button onClick={onClose}>취소</button>
        <button className="primary" onClick={() => onPreview(s)}>
          비교 보기
        </button>
      </div>
    </Modal>
  );
}
