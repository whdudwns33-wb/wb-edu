import { useMemo } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import type { OutputTemplate, Plan, PlanViews } from '@wb/shared';
import { dayRows, fmtMinutes, resolveColumns } from '@wb/shared';
import { get } from '../api.ts';
import { Loading, useAsync } from '../components/ui.tsx';

type Level = 'year' | 'quarter' | 'month' | 'week' | 'day';
const LEVEL_LABEL: Record<Level, string> = { year: '연간', quarter: '분기', month: '월간', week: '주간', day: '일간' };

/**
 * A4 인쇄 보기. PDF 는 브라우저 인쇄 → 'PDF로 저장' 을 사용한다.
 * 화면·엑셀과 같은 집계(buildPlanViews)와 같은 열 정의(shared/output.ts)를 사용한다.
 */
export function PrintPage() {
  const { id } = useParams();
  const [sp, setSp] = useSearchParams();
  const templateId = sp.get('template') ?? '';
  const levels = (sp.get('levels') ?? 'year,quarter,month,week,day').split(',').filter((l): l is Level => l in LEVEL_LABEL);
  const from = sp.get('from') ?? '';
  const to = sp.get('to') ?? '';
  const { data: plan } = useAsync(() => get<Plan>(`/api/plans/${id}`), [id]);
  const { data: templates } = useAsync(() => get<OutputTemplate[]>('/api/templates'), []);
  const { data } = useAsync(() => get<{ views: PlanViews }>(`/api/plans/${id}/views${from && to ? `?from=${from}&to=${to}` : ''}`), [id, from, to]);
  const template = templates?.find((t) => t.id === templateId) ?? null;
  // 양식이 지정되면 양식의 대상을 따르고, 아니면 audience 파라미터
  const audience: 'teacher' | 'student' = template ? template.audience : sp.get('audience') === 'student' ? 'student' : 'teacher';
  const teacher = audience === 'teacher';
  const columns = useMemo(() => resolveColumns(template, audience), [template, audience]);
  const v = data?.views;
  const days = useMemo(() => (v ? v.years.flatMap((y) => y.quarters).flatMap((q) => q.months).flatMap((m) => m.weeks).flatMap((w) => w.days) : []), [v]);
  if (!plan || !v) return <Loading />;
  const h = v.header;
  const clean = (s: string) => s.replace(/^\[가상\]\s*/, '');
  const setParam = (k: string, val: string) => setSp({ ...Object.fromEntries(sp), [k]: val });
  const query = `audience=${audience}&levels=${levels.join(',')}${from && to ? `&from=${from}&to=${to}` : ''}${templateId ? `&template=${templateId}` : ''}`;

  return (
    <div>
      <div className="print-toolbar no-print">
        <button className="primary" onClick={() => window.print()}>
          인쇄 / PDF로 저장
        </button>
        <select value={templateId} onChange={(e) => setParam('template', e.target.value)} title="출력 양식 (설정 → 출력 양식에서 열을 고릅니다)">
          <option value="">기본 양식</option>
          {(templates ?? []).map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} ({t.audience === 'teacher' ? '강사용' : '학생·학부모용'})
            </option>
          ))}
        </select>
        {!template && (
          <select value={audience} onChange={(e) => setParam('audience', e.target.value)}>
            <option value="teacher">강사용</option>
            <option value="student">학생·학부모용</option>
          </select>
        )}
        {(Object.keys(LEVEL_LABEL) as Level[]).map((l) => (
          <label key={l} className="check">
            <input type="checkbox" checked={levels.includes(l)} onChange={(e) => setParam('levels', (e.target.checked ? [...levels, l] : levels.filter((x) => x !== l)).join(','))} /> {LEVEL_LABEL[l]}
          </label>
        ))}
        <input type="date" value={from} onChange={(e) => setParam('from', e.target.value)} /> ~ <input type="date" value={to} onChange={(e) => setParam('to', e.target.value)} />
        <a className="btn" href={`/api/plans/${id}/export.xlsx?${query}`}>
          엑셀
        </a>
      </div>
      <div className="print-page">
        <h1>
          {clean(h.title)} {teacher ? '(강사용)' : '(학생·학부모용)'}
        </h1>
        {plan.isSample && <p><strong>※ 가상 샘플 데이터입니다.</strong></p>}
        {template?.headerNote && <p>{template.headerNote}</p>}
        <table>
          <tbody>
            <tr>
              <th style={{ width: '18%' }}>대상</th>
              <td>{h.target || '-'}</td>
              <th style={{ width: '18%' }}>과목</th>
              <td>{h.subject}</td>
            </tr>
            <tr>
              <th>기간</th>
              <td>{h.period}{from && to ? ` (출력 범위 ${from}~${to})` : ''}</td>
              <th>계획 버전</th>
              <td>
                v{h.planVersion} · 과정 {clean(h.curriculumTitle)} v{h.curriculumVersion} · {h.status}
              </td>
            </tr>
            <tr>
              <th>사용 교재·판본</th>
              <td colSpan={3}>{h.textbooks.map(clean).join(' / ')}</td>
            </tr>
            <tr>
              <th>총분량</th>
              <td>{fmtMinutes(h.totalMinutes)} (수업 {v.summary.lessonCount}회)</td>
              <th>미배정 범위</th>
              <td>{h.unassignedCount ? `${h.unassignedCount}건 (${fmtMinutes(h.unassignedMinutes)})` : '없음'}</td>
            </tr>
            {teacher && (
              <tr>
                <th>작성자 / 검토자</th>
                <td>
                  {h.author || '-'} / {h.reviewer || '-'}
                </td>
                <th>변경 사항</th>
                <td>{h.lastChange || '-'}</td>
              </tr>
            )}
            <tr>
              <th>출력 양식</th>
              <td colSpan={3}>{template ? template.name : '기본'} · 열: {columns.map((c) => c.label).join(', ')}</td>
            </tr>
          </tbody>
        </table>

        {levels.includes('year') && (
          <section>
            <h2>연간 계획</h2>
            <p>교육 목표: {clean(h.curriculumTitle)} · 학년도 시작월 {h.academicYearStartMonth}월</p>
            <table>
              <thead>
                <tr>
                  <th>학년도</th>
                  <th>수업</th>
                  <th>새 진도</th>
                  <th>교재 흐름</th>
                  <th>현행·복습·선행 도달 목표</th>
                </tr>
              </thead>
              <tbody>
                {v.years.map((y) => (
                  <tr key={y.academicYear}>
                    <td>{y.label}</td>
                    <td>{y.summary.lessonCount}회</td>
                    <td>{fmtMinutes(y.summary.assignedMinutes)}</td>
                    <td>{y.textbookFlow.map((f) => `${clean(f.title)} ${f.firstDate}~${f.lastDate}`).join(' → ')}</td>
                    <td>{y.trackTargets.filter((t) => t.minutes > 0).map((t) => `${t.label} ${t.itemCount}항목 ${fmtMinutes(t.minutes)}`).join(', ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        {levels.includes('quarter') && (
          <section className="page-break">
            <h2>분기 계획 (학년도 기준)</h2>
            <table>
              <thead>
                <tr>
                  <th>분기</th>
                  <th>기간</th>
                  <th>수업</th>
                  <th>교재별 배치</th>
                  <th>복습·평가 시점</th>
                  <th>전환</th>
                </tr>
              </thead>
              <tbody>
                {v.years.flatMap((y) => y.quarters).map((q) => (
                  <tr key={q.key}>
                    <td>{q.label}</td>
                    <td>
                      {q.from}~{q.to}
                    </td>
                    <td>
                      {q.summary.lessonCount}회{q.summary.cancelledCount + q.summary.holidayCount ? ` (휴강 ${q.summary.cancelledCount + q.summary.holidayCount})` : ''}
                    </td>
                    <td>{q.summary.textbooks.map((t) => `${clean(t.title)}: ${t.rangeText}`).join(' / ')}</td>
                    <td>{[...q.summary.reviewDates.map((d) => `복습 ${d}`), ...q.summary.assessmentDates.map((d) => `평가 ${d}`)].join(', ') || `회당 복습 ${plan.settings.reviewMinutes}분`}</td>
                    <td>{q.transitions.map(clean).join(', ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        {levels.includes('month') && (
          <section className="page-break">
            <h2>월간 계획</h2>
            {v.years.flatMap((y) => y.quarters).flatMap((q) => q.months).map((m) => (
              <div key={m.key}>
                <h3>
                  {m.label} <small>(수업 {m.summary.lessonCount}회 · 새 진도 {fmtMinutes(m.summary.assignedMinutes)} / 가능 {fmtMinutes(m.summary.availableMinutes)})</small>
                </h3>
                <table>
                  <thead>
                    <tr>
                      <th>주</th>
                      <th>실제 수업일</th>
                      <th>가능/배정</th>
                      <th>휴강·보강</th>
                      {teacher && <th>트랙별</th>}
                      <th>주별 진도</th>
                    </tr>
                  </thead>
                  <tbody>
                    {m.weeks.map((w) => (
                      <tr key={w.key}>
                        <td>{w.label}</td>
                        <td>{w.days.filter((d) => d.lesson.status === 'scheduled' || d.lesson.status === 'makeup').map((d) => d.lesson.date.slice(5)).join(', ')}</td>
                        <td>
                          {w.summary.availableMinutes}/{w.summary.assignedMinutes}분
                        </td>
                        <td>{w.days.filter((d) => d.lesson.status === 'cancelled' || d.lesson.status === 'holiday').map((d) => `${d.lesson.date.slice(5)} ${d.lesson.note}`).join(', ')}{w.summary.makeupCount ? ` 보강 ${w.summary.makeupCount}` : ''}</td>
                        {teacher && (
                          <td>
                            현행 {w.summary.byTrack.current} / 복습보충 {w.summary.byTrack.review} / 선행 {w.summary.byTrack.advance}
                          </td>
                        )}
                        <td>{w.summary.textbooks.map((t) => `${clean(t.title)}: ${t.rangeText}`).join(' / ')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </section>
        )}

        {levels.includes('week') && (
          <section className="page-break">
            <h2>주간 계획</h2>
            {v.years.flatMap((y) => y.quarters).flatMap((q) => q.months).flatMap((m) => m.weeks).map((w) => (
              <div key={`${w.key}-${w.from}`}>
                <h3>{w.label}</h3>
                <table>
                  <thead>
                    <tr>
                      {columns.map((c) => (
                        <th key={c.key}>{c.label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {w.days.flatMap((d) =>
                      dayRows(d, columns).map((row, i) => (
                        <tr key={`${d.lesson.id}-${i}`}>
                          {row.map((cell, j) => (
                            <td key={j}>{columns[j].key === 'textbook' ? clean(cell) : cell}</td>
                          ))}
                        </tr>
                      )),
                    )}
                  </tbody>
                </table>
              </div>
            ))}
          </section>
        )}

        {levels.includes('day') && (
          <section className="page-break">
            <h2>일간 계획</h2>
            {days.filter((d) => d.lesson.status === 'scheduled' || d.lesson.status === 'makeup').map((d) => (
              <div key={d.lesson.id} style={{ marginBottom: 10 }}>
                <h3>{d.dateLabel}</h3>
                {d.objectives.length > 0 && <p>학습 목표: {d.objectives.join(' / ')}</p>}
                <table>
                  <thead>
                    <tr>
                      {columns.filter((c) => c.key !== 'date').map((c) => (
                        <th key={c.key}>{c.label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {dayRows(d, columns.filter((c) => c.key !== 'date')).map((row, i) => (
                      <tr key={i}>
                        {row.map((cell, j) => (
                          <td key={j}>{columns.filter((c) => c.key !== 'date')[j].key === 'textbook' ? clean(cell) : cell}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </section>
        )}
        {template?.footerNote && <p>{template.footerNote}</p>}
        <p style={{ marginTop: 16, fontSize: '9pt' }}>{v.completionBasis}</p>
      </div>
    </div>
  );
}
