import { useEffect, useState, type ReactNode } from 'react';

export function Badge({ kind = '', children }: { kind?: string; children: ReactNode }) {
  return <span className={`badge ${kind}`}>{children}</span>;
}

export function SampleBadge({ show }: { show: boolean }) {
  return show ? <span className="badge sample">가상 샘플</span> : null;
}

export function Alert({ kind = 'info', children }: { kind?: 'info' | 'warn' | 'danger' | 'ok'; children: ReactNode }) {
  return <div className={`alert ${kind}`}>{children}</div>;
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-label={title}>
        <div className="row between mb">
          <h2 style={{ margin: 0 }}>{title}</h2>
          <button className="sm" onClick={onClose} aria-label="닫기">
            닫기
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small className="muted">{hint}</small>}
    </label>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: Array<{ key: T; label: string }>; value: T; onChange: (k: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.key} role="tab" className={value === t.key ? 'active' : ''} onClick={() => onChange(t.key)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): { data: T | null; error: string; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    fn()
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { data, error, loading, reload: () => setTick((t) => t + 1) };
}

export function Loading() {
  return <p className="muted">불러오는 중…</p>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="muted" style={{ padding: 16, textAlign: 'center' }}>{children}</p>;
}

export function Confirm({ message, onYes, onNo }: { message: string; onYes: () => void; onNo: () => void }) {
  return (
    <Modal title="확인" onClose={onNo}>
      <p style={{ whiteSpace: 'pre-line' }}>{message}</p>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button onClick={onNo}>취소</button>
        <button className="primary" onClick={onYes}>
          확인
        </button>
      </div>
    </Modal>
  );
}

export const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

export function WeekdayPicker({ value, onChange }: { value: number[]; onChange: (v: number[]) => void }) {
  return (
    <div className="row">
      {WEEKDAYS.map((w, i) => (
        <label key={i} className="check">
          <input type="checkbox" checked={value.includes(i)} onChange={(e) => onChange(e.target.checked ? [...value, i].sort() : value.filter((x) => x !== i))} />
          {w}
        </label>
      ))}
    </div>
  );
}
