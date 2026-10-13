import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

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
  const ref = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`modal ${wide ? 'wide' : ''}`}
      aria-label={title}
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      onMouseDown={(e) => {
        if (e.target !== e.currentTarget) return;
        const rect = e.currentTarget.getBoundingClientRect();
        if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) onClose();
      }}
    >
      <div className="row between mb">
        <h2 style={{ margin: 0 }}>{title}</h2>
        <button className="sm" onClick={onClose} aria-label="닫기">
          닫기
        </button>
      </div>
      {children}
    </dialog>
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
      {tabs.map((t, i) => (
        <button
          key={t.key}
          role="tab"
          aria-selected={value === t.key}
          tabIndex={value === t.key ? 0 : -1}
          className={value === t.key ? 'active' : ''}
          onClick={() => onChange(t.key)}
          onKeyDown={(e) => {
            let next = i;
            if (e.key === 'ArrowRight') next = (i + 1) % tabs.length;
            else if (e.key === 'ArrowLeft') next = (i + tabs.length - 1) % tabs.length;
            else if (e.key === 'Home') next = 0;
            else if (e.key === 'End') next = tabs.length - 1;
            else return;
            e.preventDefault();
            onChange(tabs[next].key);
            (e.currentTarget.parentElement?.children[next] as HTMLElement)?.focus();
          }}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/**
 * deps: 무엇을 불러오는지 정하는 값 (바뀌면 내용을 비우고 새로 불러온다)
 * refresh: 같은 대상을 다시 불러오게만 하는 값 (예: 문서 버전. 바뀌어도 지금 내용을 보여 주며 새로 고친다)
 */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[], refresh: unknown[] = []): { data: T | null; error: string; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const depsKey = useRef<string | null>(null);
  useEffect(() => {
    let alive = true;
    // 같은 대상을 다시 불러올 때(reload)는 지금 내용을 그대로 보여 준다.
    // 비우면 목록이 '불러오는 중'으로 바뀌어 스크롤 위치와 다른 카드에 입력 중인 값이 사라진다.
    // 대상이 바뀌었을 때(deps 변경)만 비워 다른 대상의 내용으로 작업하지 않게 한다.
    const key = JSON.stringify(deps);
    if (depsKey.current !== key) {
      depsKey.current = key;
      setData(null);
      setLoading(true);
    }
    setError('');
    fn()
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, ...refresh, tick]);
  return { data, error, loading, reload: () => setTick((t) => t + 1) };
}

/**
 * 저장하지 않은 변경이 있을 때 화면을 떠나면 확인한다.
 *  - 새로 고침·창 닫기: 브라우저 기본 확인 (beforeunload)
 *  - 앱 안의 링크(목록·메뉴): 누르기 전에 확인 (BrowserRouter 라 라우터 차단 기능 대신 클릭을 먼저 받는다)
 */
export function useUnsavedWarning(dirty: boolean, message = '저장하지 않은 변경이 있습니다. 이 화면을 떠나면 변경이 사라집니다. 떠날까요?') {
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    const onClick = (e: MouseEvent) => {
      const a = (e.target as HTMLElement | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!a || a.target === '_blank' || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
      if (a.origin !== window.location.origin || a.pathname === window.location.pathname) return;
      if (!window.confirm(message)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('click', onClick, true);
    };
  }, [dirty, message]);
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

export interface PromptOptions {
  title: string;
  label?: string;
  defaultValue?: string;
  type?: 'text' | 'date' | 'password' | 'confirm';
  okLabel?: string;
}

/**
 * window.prompt / window.confirm 대체. 브라우저 대화상자 대신 앱 모달을 띄우고 Promise 로 값을 돌려준다.
 * confirm 유형은 '확인' 시 'ok', 취소 시 null.
 */
export function usePrompt() {
  const [state, setState] = useState<(PromptOptions & { resolve: (v: string | null) => void }) | null>(null);
  const ask = (opts: PromptOptions) => new Promise<string | null>((resolve) => setState({ ...opts, resolve }));
  const element = state ? (
    <PromptModal
      opts={state}
      onDone={(v) => {
        state.resolve(v);
        setState(null);
      }}
    />
  ) : null;
  return { ask, element };
}

function PromptModal({ opts, onDone }: { opts: PromptOptions; onDone: (v: string | null) => void }) {
  const [value, setValue] = useState(opts.defaultValue ?? '');
  const type = opts.type ?? 'text';
  return (
    <Modal title={opts.title} onClose={() => onDone(null)}>
      {type === 'confirm' ? (
        <p style={{ whiteSpace: 'pre-line' }}>{opts.label}</p>
      ) : (
        <label className="field">
          {opts.label && <span>{opts.label}</span>}
          <input type={type} value={value} autoFocus onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && onDone(value)} />
        </label>
      )}
      <div className="row mt" style={{ justifyContent: 'flex-end' }}>
        <button onClick={() => onDone(null)}>취소</button>
        <button className="primary" onClick={() => onDone(type === 'confirm' ? 'ok' : value)}>
          {opts.okLabel ?? '확인'}
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
