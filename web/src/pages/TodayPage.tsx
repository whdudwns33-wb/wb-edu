import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { DayView } from '@wb/shared';
import { todayKST, fmtMinutes } from '@wb/shared';
import { get, post, errorMessage } from '../api.ts';
import { Alert, Badge, Empty, Loading, useAsync, Confirm } from '../components/ui.tsx';
import { RecordControls } from '../components/RecordControls.tsx';

interface TodayRes {
  date: string;
  lessons: Array<{ planId: string; planTitle: string; target: string; version: number; status: string; day: DayView }>;
}

export function TodayPage() {
  const [date, setDate] = useState(todayKST());
  const { data, loading, error, reload } = useAsync(() => get<TodayRes>(`/api/today?date=${date}`), [date]);
  const [msg, setMsg] = useState('');
  const [confirm, setConfirm] = useState<{ text: string; run: () => Promise<void> } | null>(null);

  const quickOp = async (planId: string, _listVersion: number, op: string, params: Record<string, unknown>, label: string) => {
    try {
      // 목록을 불러온 뒤 다른 기기의 기록 등으로 버전이 올랐을 수 있으므로, 미리보기 직전의 최신 버전으로 적용한다
      const { version } = await get<{ version: number }>(`/api/versions/plan/${planId}`);
      const dry = await post<{ diff: { affectedLessonDates: string[]; unassignedMinutesAfter: number; unassignedMinutesBefore: number; endDateBefore: string; endDateAfter: string }; warnings: string[] }>(`/api/plans/${planId}/ops`, { op, params, dryRun: true });
      const d = dry.diff;
      const text = `${label}\n영향받는 수업 ${d.affectedLessonDates.length}회\n미배정 ${d.unassignedMinutesBefore}분 → ${d.unassignedMinutesAfter}분\n마지막 배정일 ${d.endDateBefore || '-'} → ${d.endDateAfter || '-'}${dry.warnings.length ? '\n' + dry.warnings.join('\n') : ''}`;
      setConfirm({
        text,
        run: async () => {
          try {
            await post(`/api/plans/${planId}/ops`, { op, params, version });
            setMsg(`${label} 완료`);
          } catch (e) {
            // 미리보기 뒤 다른 사람이 계획을 바꿨으면(409) 창을 닫고 새로 불러와 다시 시도하게 한다
            setMsg(`${errorMessage(e)} 목록을 새로 불러왔습니다. 다시 시도하세요.`);
          } finally {
            setConfirm(null);
            reload();
          }
        },
      });
    } catch (e) {
      setMsg(errorMessage(e));
    }
  };

  return (
    <>
      <div className="topbar">
        <h1>오늘 수업</h1>
        <div className="row">
          <button className="sm" onClick={() => setDate(todayKST())}>
            오늘
          </button>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
      </div>
      {msg && <Alert kind="info">{msg}</Alert>}
      {error && <Alert kind="danger">{error}</Alert>}
      {loading ? (
        <Loading />
      ) : !data || data.lessons.length === 0 ? (
        <Empty>{date}에 예정된 수업이 없습니다.</Empty>
      ) : (
        data.lessons.map(({ planId, planTitle, target, version, status, day }) => (
          <div className="panel" key={`${planId}-${day.lesson.id}`}>
            <div className="row between">
              <div>
                <Link to={`/plans/${planId}`}>
                  <strong>{planTitle}</strong>
                </Link>{' '}
                <span className="muted small">{target}</span> <Badge kind={status === 'confirmed' ? 'ok' : 'warn'}>{status === 'confirmed' ? '확정' : '초안'}</Badge>
              </div>
              <div className="muted small">{day.dateLabel}</div>
            </div>
            {day.lesson.status !== 'scheduled' && day.lesson.status !== 'makeup' ? (
              <Alert kind="warn">{day.lesson.status === 'holiday' ? '공휴일' : '휴강'}: {day.lesson.note}</Alert>
            ) : (
              <>
                <div className="muted small mb">{day.timeAllocation.filter((t) => t.minutes > 0).map((t) => `${t.label} ${t.minutes}분`).join(' · ')}</div>
                {day.assignments.length === 0 && <Empty>배정된 항목이 없습니다.</Empty>}
                {day.assignments.map((v) => (
                  <div key={v.assignment.id} className="panel tight" style={{ marginBottom: 8 }}>
                    <div className="row between">
                      <div>
                        <strong>{v.textbookTitle}</strong> {v.rangeText} <Badge kind={v.assignment.track === 'advance' ? 'info' : 'primary'}>{v.trackLabel}</Badge> <Badge>{v.activityLabel}</Badge> <span className="muted small">{fmtMinutes(v.assignment.minutes)}</span>
                        {v.assignment.locked && <Badge kind="warn">고정</Badge>}
                        {v.continuedFrom && <Badge kind="info">이어서</Badge>}
                      </div>
                      <Badge kind={v.record?.status === 'done' ? 'ok' : v.record?.status === 'partial' ? 'warn' : v.record ? 'danger' : ''}>{v.recordLabel}</Badge>
                    </div>
                    <div className="small">
                      {v.itemTitle}
                      {v.objective && <span className="muted"> · 목표: {v.objective}</span>}
                      {v.materials && <span className="muted"> · 준비물: {v.materials}</span>}
                    </div>
                    {v.remainingText && <div className="small warn">남은 범위: {v.remainingText}</div>}
                    <div className="mt">
                      <RecordControls planId={planId} version={version} view={v} onSaved={reload} compact />
                    </div>
                  </div>
                ))}
                <div className="row mt">
                  <button className="sm" onClick={() => quickOp(planId, version, 'postpone', { lessonId: day.lesson.id }, '이 수업의 진도를 다음 수업으로 미루기')}>
                    다음 수업으로 미루기
                  </button>
                  <button className="sm" onClick={() => quickOp(planId, version, 'cancel_lesson', { lessonId: day.lesson.id, reason: '휴강' }, '휴강 처리 후 남은 일정 재편성')}>
                    휴강 처리
                  </button>
                </div>
              </>
            )}
          </div>
        ))
      )}
      {confirm && <Confirm message={confirm.text} onYes={() => confirm.run().catch((e) => setMsg(errorMessage(e)))} onNo={() => setConfirm(null)} />}
    </>
  );
}
