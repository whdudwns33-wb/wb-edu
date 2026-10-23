import { useState } from 'react';
import { get, post, del, errorMessage } from '../api.ts';
import { Alert, Field, Loading, useAsync, usePrompt } from './ui.tsx';
import { formatKST } from '@wb/shared';

type ApiToken = { id: string; name: string; scope: string; expiresAt: string };
export function ApiConnections() {
  const { data, loading, reload } = useAsync(() => get<ApiToken[]>('/api/api-tokens'), []);
  const [name, setName] = useState(''), [scope, setScope] = useState('read');
  const [days, setDays] = useState(90), [token, setToken] = useState('');
  const [err, setErr] = useState(''), [busy, setBusy] = useState(false);
  const { ask, element } = usePrompt();
  async function create() {
    setBusy(true); setErr(''); setToken('');
    try { const result = await post<{ token: string }>('/api/api-tokens', { name, scope, days }); setToken(result.token); setName(''); reload(); }
    catch (e) { setErr(errorMessage(e)); }
    finally { setBusy(false); }
  }
  return <section className="panel">
    {element}<h2>API·MCP 연결</h2>
    <p>이 계정의 권한으로 외부 앱을 연결합니다. 연결마다 키를 발급하고 사용이 끝나면 폐기하세요.</p>
    <p className="small">API: <code>{location.origin}/api</code><br />MCP: <code>{location.origin}/mcp</code><br />Bearer 인증 헤더를 지원하는 클라이언트에서 사용합니다. OAuth 전용 클라이언트는 지원하지 않습니다.</p>
    {err && <Alert kind="danger">{err}</Alert>}
    {token && <div role="status"><Alert kind="ok">키는 지금 한 번만 표시됩니다. 안전한 비밀 저장소에 보관하세요.</Alert><Field label="발급한 API 키"><input readOnly type="password" value={token} aria-label="발급한 API 키" /></Field><button onClick={async () => { try { await navigator.clipboard.writeText(token); } catch { setErr('키 복사에 실패했습니다. 입력란에서 직접 복사하세요.'); } }}>키 복사</button><button onClick={() => setToken('')}>키 표시 닫기</button></div>}
    <div className="row">
      <Field label="연결 이름"><input value={name} maxLength={80} onChange={e => setName(e.target.value)} placeholder="예: 김정현 PC" /></Field>
      <Field label="허용 작업"><select value={scope} onChange={e => setScope(e.target.value)}><option value="read">조회 전용</option><option value="write">조회·등록·수정·진도 기록</option></select></Field>
      <Field label="유효기간 (일)"><input type="number" min={1} max={365} value={days} onChange={e => setDays(Number(e.target.value))} /></Field>
      <button className="primary" disabled={busy || !name.trim()} onClick={create}>{busy ? '발급 중…' : '키 발급'}</button>
    </div>
    {loading ? <Loading /> : data?.length ? <div className="table-wrap"><table><thead><tr><th>연결 이름</th><th>허용 작업</th><th>만료</th><th>관리</th></tr></thead><tbody>{data.map(item => <tr key={item.id}><td>{item.name}</td><td>{item.scope === 'write' ? '조회·등록·수정' : '조회 전용'}</td><td>{formatKST(item.expiresAt)}</td><td><button className="danger sm" onClick={async () => { if (!await ask({ title: '연결 키 폐기', label: item.name + ' 연결은 즉시 사용할 수 없게 됩니다.', type: 'confirm', okLabel: '폐기' })) return; try { await del('/api/api-tokens/' + item.id); setToken(''); reload(); } catch (e) { setErr(errorMessage(e)); } }}>폐기</button></td></tr>)}</tbody></table></div> : <p className="muted">등록된 외부 연결이 없습니다.</p>}
  </section>;
}
