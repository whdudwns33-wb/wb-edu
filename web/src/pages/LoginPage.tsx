import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth.tsx';
import { errorMessage } from '../api.ts';
import { Alert } from '../components/ui.tsx';

export function LoginPage() {
  const { user, login, loading } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (!loading && user) return <Navigate to={(loc.state as { from?: string })?.from ?? '/plans'} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await login(username, password);
      nav((loc.state as { from?: string })?.from ?? '/plans', { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <form className="panel login-box" onSubmit={submit}>
        <h1>WB 커리큘럼 플래너</h1>
        <p className="muted small">교재 보관함 · 표준과정 · 실행 계획 · 진도 기록</p>
        {error && <Alert kind="danger">{error}</Alert>}
        <div className="stack">
          <label className="field">
            <span>아이디</span>
            <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus />
          </label>
          <label className="field">
            <span>비밀번호</span>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          </label>
          <button className="primary" disabled={busy || !username || !password}>
            로그인
          </button>
        </div>
        <p className="muted small mt">계정은 관리자가 만듭니다. 데모 환경 기본 계정: admin / admin1234 (샘플 시드 시 teacher / teacher1234)</p>
      </form>
    </div>
  );
}
