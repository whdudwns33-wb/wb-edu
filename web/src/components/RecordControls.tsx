import { useState } from 'react';
import type { AssignmentView } from '@wb/shared';
import { post, errorMessage } from '../api.ts';
import { Alert } from './ui.tsx';

interface Props {
  planId: string;
  version: number;
  view: AssignmentView;
  /** 저장 뒤 최신 계획을 다시 불러오기 위한 콜백 */
  onSaved: () => void;
  compact?: boolean;
}

/** 완료 / 부분 완료 / 미진행 / 제외 입력 + 이어서 진행 */
export function RecordControls({ planId, version, view, onSaved, compact }: Props) {
  const a = view.assignment;
  const [mode, setMode] = useState<'' | 'partial' | 'excluded' | 'not_done'>('');
  const range = view.range;
  const [from, setFrom] = useState(range?.from ?? 0);
  const [to, setTo] = useState(range?.from ?? 0);
  const [fraction, setFraction] = useState(50);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [actual, setActual] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async (status: string, extra: Record<string, unknown> = {}) => {
    setBusy(true);
    setError('');
    try {
      await post(`/api/plans/${planId}/records`, { assignmentId: a.id, status, version, reason, note, ...extra });
      setMode('');
      onSaved();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const cont = async () => {
    setBusy(true);
    setError('');
    try {
      await post(`/api/plans/${planId}/ops`, { op: 'continue', params: { assignmentId: a.id }, version });
      onSaved();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const isHw = a.activity === 'homework';
  return (
    <div className="stack" style={{ gap: 4 }}>
      {error && <Alert kind="danger">{error}</Alert>}
      <div className="row">
        {!isHw && (
          <input
            type="number"
            min={1}
            max={600}
            inputMode="numeric"
            placeholder={`실제 분(예상 ${a.minutes})`}
            title="실제로 걸린 시간(선택). 쌓이면 교재 예상 시간 개선 제안에 쓰입니다."
            style={{ width: 120 }}
            value={actual}
            onChange={(e) => setActual(e.target.value)}
          />
        )}
        <button className="sm accent" disabled={busy} onClick={() => save('done', actual && Number(actual) > 0 ? { actualMinutes: Number(actual) } : {})}>
          완료
        </button>
        {!isHw && (
          <button className="sm" disabled={busy} onClick={() => setMode(mode === 'partial' ? '' : 'partial')}>
            부분 완료
          </button>
        )}
        <button className="sm" disabled={busy} onClick={() => setMode(mode === 'not_done' ? '' : 'not_done')}>
          미진행
        </button>
        <button className="sm" disabled={busy} onClick={() => setMode(mode === 'excluded' ? '' : 'excluded')}>
          제외
        </button>
        {view.record?.status === 'partial' && view.remainingText && !isHw && !view.continuedTo && (
          <button className="sm primary" disabled={busy} onClick={cont} title="남은 범위를 다음 수업 맨 앞에 이어서 배정">
            남은 {view.remainingText} 이어서 진행
          </button>
        )}
      </div>
      {mode === 'partial' && (
        <div className="row">
          {range ? (
            <>
              <span className="small">완료 범위</span>
              <input type="number" style={{ width: 80 }} value={from} onChange={(e) => setFrom(Number(e.target.value))} />
              <span>~</span>
              <input type="number" style={{ width: 80 }} value={to} onChange={(e) => setTo(Number(e.target.value))} />
            </>
          ) : (
            <>
              <span className="small">이번 분량 중 완료(%)</span>
              <input type="number" style={{ width: 80 }} value={fraction} min={1} max={99} onChange={(e) => setFraction(Number(e.target.value))} />
            </>
          )}
          {!compact && <input placeholder="메모" value={note} onChange={(e) => setNote(e.target.value)} />}
          <button className="sm primary" disabled={busy} onClick={() => save('partial', range ? { completedPortion: { from, to } } : { completedFraction: fraction / 100 })}>
            저장
          </button>
        </div>
      )}
      {(mode === 'excluded' || mode === 'not_done') && (
        <div className="row">
          <input placeholder={mode === 'excluded' ? '제외 사유 (필수)' : '미진행 사유'} value={reason} onChange={(e) => setReason(e.target.value)} />
          <button className="sm primary" disabled={busy || (mode === 'excluded' && !reason)} onClick={() => save(mode)}>
            저장
          </button>
        </div>
      )}
    </div>
  );
}
