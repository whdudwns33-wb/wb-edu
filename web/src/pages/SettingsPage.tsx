import { ApiConnections } from '../components/ApiConnections.tsx';
import { isManager, roleLabel } from '@wb/shared';
import { useEffect, useState } from 'react';
import type { AppSettings, Holiday, HolidaySet, OutputTemplate, User } from '@wb/shared';
import { DEFAULT_SUMMARY_COLUMNS, MONTH_COLUMNS, OUTPUT_COLUMNS, QUARTER_COLUMNS, YEAR_COLUMNS, HALFYEAR_COLUMNS, resolveColumns } from '@wb/shared';
import { get, post, put, del, errorMessage } from '../api.ts';
import { useAuth } from '../auth.tsx';
import { Alert, Badge, Field, Loading, Tabs, useAsync, usePrompt } from '../components/ui.tsx';

type Tab = 'general' | 'holidays' | 'templates' | 'users' | 'samples' | 'account' | 'api';

export function SettingsPage() {
  const { user } = useAuth();
  const isAdmin = isManager(user?.role);
  const [tab, setTab] = useState<Tab>('general');
  return (
    <>
      <div className="topbar">
        <h1>양식·운영 설정</h1>
      </div>
      <Tabs<Tab>
        tabs={[
          { key: 'general', label: '기본·과목별 항목' },
          { key: 'holidays', label: '휴일' },
          { key: 'templates', label: '출력 양식' },
          ...(isAdmin ? [{ key: 'users' as Tab, label: '사용자·권한' }] : []),
          { key: 'samples', label: '샘플 데이터' },
          { key: 'account', label: '내 계정' },
          { key: 'api', label: 'API·MCP 연결' },
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === 'general' && <GeneralTab readOnly={!isAdmin} />}
      {tab === 'holidays' && <HolidaysTab readOnly={!isAdmin} />}
      {tab === 'templates' && <TemplatesTab readOnly={!isAdmin} />}
      {tab === 'users' && isAdmin && <UsersTab />}
      {tab === 'samples' && <SamplesTab isAdmin={isAdmin} />}
      {tab === 'account' && <AccountTab />}
      {tab === 'api' && <ApiConnections />}
    </>
  );
}

function GeneralTab({ readOnly }: { readOnly: boolean }) {
  const { data, loading, reload } = useAsync(() => get<AppSettings>('/api/settings'), []);
  const [s, setS] = useState<AppSettings | null>(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => setS(data), [data]);
  if (loading || !s) return <Loading />;
  return (
    <div className="panel">
      {err && <Alert kind="danger">{err}</Alert>}
      {msg && <Alert kind="ok">{msg}</Alert>}
      <div className="grid cols-4">
        <Field label="기관명">
          <input value={s.organizationName} disabled={readOnly} onChange={(e) => setS({ ...s, organizationName: e.target.value })} />
        </Field>
        <Field label="학년도 시작월" hint="달력 분기와 학년도 분기를 구분합니다">
          <input type="number" min={1} max={12} value={s.academicYearStartMonth} disabled={readOnly} onChange={(e) => setS({ ...s, academicYearStartMonth: Number(e.target.value) })} />
        </Field>
        <Field label="기본 회당 수업시간(분)">
          <input type="number" value={s.defaultMinutesPerLesson} disabled={readOnly} onChange={(e) => setS({ ...s, defaultMinutesPerLesson: Number(e.target.value) })} />
        </Field>
        <Field label="기본 복습 / 여유(분)">
          <div className="row">
            <input type="number" value={s.defaultReviewMinutes} disabled={readOnly} onChange={(e) => setS({ ...s, defaultReviewMinutes: Number(e.target.value) })} />
            <input type="number" value={s.defaultBufferMinutes} disabled={readOnly} onChange={(e) => setS({ ...s, defaultBufferMinutes: Number(e.target.value) })} />
          </div>
        </Field>
      </div>
      <h3 className="mt">과목별 선택 항목 (학습항목 추가 열)</h3>
      <p className="muted small">공통 필수 항목은 유지하고, 과목별로 추가 열을 정의합니다. 예: 독해는 지문·독해 기능, 수학은 개념·유형·오답, 영어는 본문·어휘·문법·듣기, 자체교재는 활동·준비물·제작 버전.</p>
      {s.subjectFields.map((sf, i) => (
        <div key={i} className="row mb">
          <input style={{ width: 90 }} value={sf.subject} disabled={readOnly} onChange={(e) => setS({ ...s, subjectFields: s.subjectFields.map((x, j) => (j === i ? { ...x, subject: e.target.value } : x)) })} />
          <FieldListInput fields={sf.fields} disabled={readOnly} onChange={(fields) => setS({ ...s, subjectFields: s.subjectFields.map((x, j) => (j === i ? { ...x, fields } : x)) })} />
          {!readOnly && <button className="sm" onClick={() => setS({ ...s, subjectFields: s.subjectFields.filter((_, j) => j !== i) })}>×</button>}
        </div>
      ))}
      {!readOnly && (
        <div className="row">
          <button className="sm" onClick={() => setS({ ...s, subjectFields: [...s.subjectFields, { subject: '', fields: [] }] })}>
            + 과목 추가
          </button>
          <button className="primary" onClick={() => put<AppSettings>('/api/settings', s).then((d) => { setS(d); setMsg('저장했습니다.'); reload(); }).catch((e) => setErr(errorMessage(e)))}>
            저장
          </button>
        </div>
      )}
    </div>
  );
}

function HolidaysTab({ readOnly }: { readOnly: boolean }) {
  const { data, loading, reload } = useAsync(() => get<HolidaySet[]>('/api/holiday-sets'), []);
  const [sets, setSets] = useState<HolidaySet[]>([]);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const { ask, element: promptEl } = usePrompt();
  useEffect(() => setSets(data ?? []), [data]);
  if (loading) return <Loading />;
  const upd = (id: string, patch: Partial<HolidaySet>) => setSets(sets.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  const updH = (sid: string, hid: string, patch: Partial<Holiday>) => upd(sid, { holidays: sets.find((s) => s.id === sid)!.holidays.map((h) => (h.id === hid ? { ...h, ...patch } : h)) });
  return (
    <div className="panel">
      {err && <Alert kind="danger">{err}</Alert>}
      {msg && <Alert kind="ok">{msg}</Alert>}
      {promptEl}
      <p className="muted small">휴일 정보는 출처와 적용 연도를 표시하며 수정할 수 있습니다. 기본 제공 공휴일은 규정에 따른 산출값이므로 정부 고시를 확인한 뒤 '확인' 표시를 하세요. 학원 자체 휴무(방학 등)도 여기에 추가하거나 계획별 휴강으로 넣을 수 있습니다.</p>
      {!readOnly && (
        <button className="sm mb" onClick={async () => { const y = await ask({ title: '연도 세트 추가', label: '연도 (예: 2028)' }); if (y) post('/api/holiday-sets', { year: Number(y), name: `휴일 ${y}` }).then(reload).catch((e) => setErr(errorMessage(e))); }}>
          + 연도 세트 추가
        </button>
      )}
      {sets.map((hs) => (
        <details key={hs.id} className="panel tight" open={hs.year === new Date().getFullYear()}>
          <summary>
            <strong>{hs.name}</strong> <span className="muted small">출처: {hs.source} · {hs.holidays.length}일 · 미확인 {hs.holidays.filter((h) => !h.verified).length}</span>
          </summary>
          <div className="table-wrap mt">
            <table className="compact">
              <thead>
                <tr>
                  <th>날짜</th>
                  <th>이름</th>
                  <th>출처</th>
                  <th>적용</th>
                  <th>확인</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {[...hs.holidays].sort((a, b) => (a.date < b.date ? -1 : 1)).map((h) => (
                  <tr key={h.id}>
                    <td>
                      <input type="date" value={h.date} disabled={readOnly} onChange={(e) => updH(hs.id, h.id, { date: e.target.value })} />
                    </td>
                    <td>
                      <input value={h.name} disabled={readOnly} onChange={(e) => updH(hs.id, h.id, { name: e.target.value })} />
                    </td>
                    <td className="small muted">{h.source}</td>
                    <td>
                      <input type="checkbox" checked={h.enabled} disabled={readOnly} onChange={(e) => updH(hs.id, h.id, { enabled: e.target.checked })} />
                    </td>
                    <td>
                      <input type="checkbox" checked={h.verified} disabled={readOnly} onChange={(e) => updH(hs.id, h.id, { verified: e.target.checked })} /> {h.verified ? <Badge kind="ok">확인</Badge> : <Badge kind="warn">확인 필요</Badge>}
                    </td>
                    <td>{!readOnly && <button className="sm" onClick={() => upd(hs.id, { holidays: hs.holidays.filter((x) => x.id !== h.id) })}>×</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!readOnly && (
            <div className="row mt">
              <button className="sm" onClick={() => upd(hs.id, { holidays: [...hs.holidays, { id: crypto.randomUUID(), date: `${hs.year}-01-01`, name: '', year: hs.year, source: '직접 입력', verified: true, enabled: true }] })}>
                + 휴일 추가
              </button>
              <button className="sm primary" onClick={() => put<HolidaySet>(`/api/holiday-sets/${hs.id}`, hs).then((d) => { upd(hs.id, d); setMsg(`${d.name} 저장`); }).catch((e) => setErr(errorMessage(e)))}>
                이 세트 저장
              </button>
            </div>
          )}
        </details>
      ))}
    </div>
  );
}

function TemplatesTab({ readOnly }: { readOnly: boolean }) {
  const { data, loading, reload } = useAsync(() => get<OutputTemplate[]>('/api/templates'), []);
  const [err, setErr] = useState('');
  if (loading) return <Loading />;
  return (
    <div className="panel">
      {err && <Alert kind="danger">{err}</Alert>}
      <p className="muted small">공통 양식: 과정명·대상·과목·기간·사용 교재와 판본·계획 버전·목표·범위·차시·시간·활동·총분량·미배정 범위·변경 사항·작성자·검토자. 강사용은 지도 메모와 시간 배분을 포함하고, 학생·학부모용은 학습목표·범위·과제 중심으로 내부 메모를 제외합니다.</p>
      {(data ?? []).map((t) => (
        <TemplateRow key={t.id} t={t} readOnly={readOnly} onSaved={reload} onError={setErr} />
      ))}
      {!readOnly && (
        <button className="sm" onClick={() => post('/api/templates', { name: '새 양식', audience: 'teacher', columns: ['date', 'textbook', 'range', 'objective', 'activity', 'minutes'] }).then(reload).catch((e) => setErr(errorMessage(e)))}>
          + 양식 추가
        </button>
      )}
    </div>
  );
}

function TemplateRow({ t, readOnly, onSaved, onError }: { t: OutputTemplate; readOnly: boolean; onSaved: () => void; onError: (m: string) => void }) {
  const [f, setF] = useState(t);
  const effective = resolveColumns(f, f.audience).map((c) => c.label).join(', ');
  return (
    <div className="panel tight">
      <div className="grid cols-4">
        <Field label="양식 이름">
          <input value={f.name} disabled={readOnly} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
        <Field label="대상">
          <select value={f.audience} disabled={readOnly} onChange={(e) => setF({ ...f, audience: e.target.value as OutputTemplate['audience'] })}>
            <option value="teacher">강사용</option>
            <option value="student">학생·학부모용</option>
          </select>
        </Field>
        <Field label="머리말">
          <input value={f.headerNote} disabled={readOnly} onChange={(e) => setF({ ...f, headerNote: e.target.value })} />
        </Field>
        <Field label="꼬리말">
          <input value={f.footerNote} disabled={readOnly} onChange={(e) => setF({ ...f, footerNote: e.target.value })} />
        </Field>
      </div>
      <div className="row mt">
        {OUTPUT_COLUMNS.map((c) => (
          <label key={c.key} className="check" title={c.internal ? '내부용 열: 학생·학부모용 양식에서는 출력되지 않습니다' : ''} style={c.internal && f.audience === 'student' ? { opacity: 0.45 } : undefined}>
            <input type="checkbox" disabled={readOnly} checked={f.columns.includes(c.key)} onChange={(e) => setF({ ...f, columns: e.target.checked ? [...f.columns, c.key] : f.columns.filter((x) => x !== c.key) })} /> {c.label}
            {c.internal && <span className="muted small">(내부)</span>}
          </label>
        ))}
        {!readOnly && (
          <button className="sm primary" onClick={() => put(`/api/templates/${t.id}`, f).then(onSaved).catch((e) => onError(errorMessage(e)))}>
            저장
          </button>
        )}
      </div>
      <div className="muted small mt">실제 출력 열 (선택 순서대로): {effective}</div>
      <details className="mt">
        <summary className="small">연간·반년·분기·월간 표 열</summary>
        {(
          [
            ['year', '연간', YEAR_COLUMNS],
            ['halfyear', '반년', HALFYEAR_COLUMNS],
            ['quarter', '분기', QUARTER_COLUMNS],
            ['month', '월간 (주별 행)', MONTH_COLUMNS],
          ] as const
        ).map(([level, label, defs]) => {
          const current = f.summaryColumns?.[level]?.length ? f.summaryColumns[level]! : DEFAULT_SUMMARY_COLUMNS[f.audience][level];
          return (
            <div key={level} className="row mt" aria-label={`${label} 표 열`}>
              <strong className="small" style={{ minWidth: 90 }}>{label}</strong>
              {defs.map((c) => (
                <label key={c.key} className="check" title={c.internal ? '내부용 열: 학생·학부모용 양식에서는 출력되지 않습니다' : ''} style={c.internal && f.audience === 'student' ? { opacity: 0.45 } : undefined}>
                  <input
                    type="checkbox"
                    disabled={readOnly}
                    checked={current.includes(c.key)}
                    onChange={(e) => {
                      const next = e.target.checked ? [...current, c.key] : current.filter((k) => k !== c.key);
                      setF({ ...f, summaryColumns: { ...(f.summaryColumns ?? {}), [level]: next } });
                    }}
                  />{' '}
                  {c.label}
                  {c.internal && <span className="muted small">(내부)</span>}
                </label>
              ))}
            </div>
          );
        })}
      </details>
    </div>
  );
}

function UsersTab() {
  const { user: me } = useAuth();
  const { data: policy } = useAsync(() => get<{ initialPasswordConfigured: boolean }>('/api/users/password-policy'), []);
  const { data, loading, reload } = useAsync(() => get<User[]>('/api/users'), []);
  const [f, setF] = useState({ username: '', displayName: '', password: '', role: 'teacher', useInitialPassword: true });
  const [err, setErr] = useState('');
  const { ask, element: promptEl } = usePrompt();
  if (loading) return <Loading />;
  return (
    <div className="panel">
      {promptEl}
      {err && <Alert kind="danger">{err}</Alert>}
      <p className="muted small">원장과 관리자는 공통 교재·양식·표준과정을 관리하고, 강사는 허용된 과정과 자기 실행 계획을 다룹니다. 권한은 서버에서 확인합니다.</p>
      <div className="table-wrap">
        <table className="compact">
          <thead>
            <tr>
              <th>아이디</th>
              <th>이름</th>
              <th>역할</th>
              <th>상태</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {(data ?? []).map((u) => (
              <tr key={u.id}>
                <td>{u.username}</td>
                <td>{u.displayName}</td>
                <td>{roleLabel(u.role)}</td>
                <td>{u.active ? <Badge kind="ok">활성</Badge> : <Badge>비활성</Badge>}{u.mustChangePassword && <Badge>비밀번호 변경 필요</Badge>}</td>
                <td className="row">
                  <button className="sm" disabled={u.role === 'owner' && me?.role !== 'owner'} onClick={async () => { const name = await ask({ title: '이름 변경', label: '표시할 이름', defaultValue: u.displayName }); if (name) put(`/api/users/${u.id}`, { displayName: name }).then(reload).catch(e => setErr(errorMessage(e))); }}>이름 변경</button>
                  {policy?.initialPasswordConfigured && <button className="sm" disabled={u.role === 'owner'} onClick={async () => { if (await ask({ title: '초기 비밀번호로 재설정', label: u.displayName + '의 기존 로그인과 외부 연결 키를 끊고 다음 로그인에서 변경하도록 합니다.', type: 'confirm', okLabel: '재설정' })) put(`/api/users/${u.id}`, { useInitialPassword: true }).then(reload).catch(e => setErr(errorMessage(e))); }}>초기값으로 재설정</button>}
                  <button className="sm" disabled={u.role === 'owner'} onClick={() => put(`/api/users/${u.id}`, { active: !u.active }).then(reload).catch((e) => setErr(errorMessage(e)))}>
                    {u.active ? '비활성화' : '활성화'}
                  </button>
                  <button className="sm" disabled={u.role === 'owner'} onClick={() => put(`/api/users/${u.id}`, { role: isManager(u.role) ? 'teacher' : 'admin' }).then(reload).catch((e) => setErr(errorMessage(e)))}>
                    {isManager(u.role) ? '강사로' : '관리자로'}
                  </button>
                  <button className="sm" disabled={u.role === 'owner'} onClick={async () => { const p = await ask({ title: `${u.username} 비밀번호 재설정`, label: '새 비밀번호 (8자 이상)', type: 'password' }); if (p) put(`/api/users/${u.id}`, { password: p }).then(reload).catch((e) => setErr(errorMessage(e))); }}>
                    비밀번호 재설정
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3 className="mt">사용자 추가</h3>
      <div className="row">
        <input aria-label="아이디" placeholder="wb홍길동" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} />
        <input placeholder="이름" value={f.displayName} onChange={(e) => setF({ ...f, displayName: e.target.value, username: !f.username || f.username === 'wb' + f.displayName ? 'wb' + e.target.value.trim().normalize('NFC') : f.username })} />
        <input aria-label="직접 지정할 비밀번호" placeholder="직접 지정 (8자 이상)" type="password" disabled={f.useInitialPassword && !!policy?.initialPasswordConfigured} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
        <label className="check"><input type="checkbox" disabled={!policy?.initialPasswordConfigured} checked={f.useInitialPassword && !!policy?.initialPasswordConfigured} onChange={e => setF({ ...f, useInitialPassword: e.target.checked })} />지정 초기값 사용 (첫 로그인 후 변경)</label>
        <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
          <option value="teacher">강사</option>
          <option value="admin">관리자</option>
        </select>
        <button className="primary" onClick={() => post('/api/users', { ...f, useInitialPassword: f.useInitialPassword && !!policy?.initialPasswordConfigured }).then(() => { setF({ username: '', displayName: '', password: '', role: 'teacher', useInitialPassword: true }); reload(); }).catch((e) => setErr(errorMessage(e)))}>
          추가
        </button>
      </div>
    </div>
  );
}

function SamplesTab({ isAdmin }: { isAdmin: boolean }) {
  const { data, reload } = useAsync(() => get<{ count: number }>('/api/samples'), []);
  const [err, setErr] = useState('');
  const { ask, element: promptEl } = usePrompt();
  return (
    <div className="panel">
      {promptEl}
      {err && <Alert kind="danger">{err}</Alert>}
      <p>가상 샘플 데이터 {data?.count ?? 0}건이 저장되어 있습니다. 모든 샘플은 '가상 샘플' 표시가 붙으며, 실제 교재·학생 자료가 아닙니다.</p>
      <p className="muted small">데모 DB(server/data/wb-edu.demo.sqlite)와 운영 DB(WB_MODE=prod → wb-edu.sqlite)는 파일이 분리됩니다. 운영 DB에는 샘플을 넣지 않는 것을 권장합니다. 샘플 추가는 <code>npm run seed:sample</code> 명령으로 합니다.</p>
      {isAdmin && (
        <button className="danger" disabled={!data?.count} onClick={async () => { const ok = await ask({ title: '샘플 데이터 전체 삭제', label: '샘플로 표시된 교재·과정·계획·학습목표를 모두 삭제합니다. 계속할까요?', type: 'confirm', okLabel: '삭제' }); if (ok) del('/api/samples').then(reload).catch((e) => setErr(errorMessage(e))); }}>
          샘플 데이터 전체 삭제
        </button>
      )}
    </div>
  );
}

export function AccountTab() {
  const { user, refresh } = useAuth();
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  return (
    <div className="panel">
      {user?.mustChangePassword && <Alert kind="info">업무를 시작하려면 초기 비밀번호를 변경하세요.</Alert>}
      <p>
        {user?.displayName} ({user?.username}) · {roleLabel(user?.role)}
      </p>
      {err && <Alert kind="danger">{err}</Alert>}
      {msg && <Alert kind="ok">{msg}</Alert>}
      <div className="row">
        <input type="password" aria-label="현재 비밀번호" autoComplete="current-password" placeholder="현재 비밀번호" value={cur} onChange={(e) => setCur(e.target.value)} />
        <input type="password" aria-label="새 비밀번호 (8자 이상)" autoComplete="new-password" placeholder="새 비밀번호 (8자 이상)" value={next} onChange={(e) => setNext(e.target.value)} />
        <button className="primary" onClick={() => post('/api/auth/password', { currentPassword: cur, newPassword: next }).then(async () => { await refresh(); setMsg('비밀번호를 바꿨습니다.'); setCur(''); setNext(''); }).catch((e) => setErr(errorMessage(e)))}>
          비밀번호 변경
        </button>
      </div>
    </div>
  );
}

/**
 * 과목별 추가 열 입력 ('key:라벨, key2:라벨2').
 * 글자를 칠 때마다 해석해 다시 쓰면 쉼표·띄어쓰기가 바로 지워져 입력할 수 없으므로,
 * 입력 중에는 친 글자를 그대로 두고 칸을 벗어날 때 해석한다.
 */
function FieldListInput({ fields, disabled, onChange }: { fields: Array<{ key: string; label: string }>; disabled: boolean; onChange: (f: Array<{ key: string; label: string }>) => void }) {
  const text = fields.map((f) => `${f.key}:${f.label}`).join(', ');
  const [raw, setRaw] = useState(text);
  const [editing, setEditing] = useState(false);
  const parse = (v: string) =>
    v
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
      .map((t) => {
        const [key, label] = t.split(':');
        return { key: key.trim(), label: (label ?? key).trim() || key.trim() };
      })
      .filter((f) => f.key);
  return (
    <input
      style={{ flex: 1 }}
      value={editing ? raw : text}
      disabled={disabled}
      onFocus={() => {
        setRaw(text);
        setEditing(true);
      }}
      onChange={(e) => setRaw(e.target.value)}
      onBlur={() => {
        setEditing(false);
        onChange(parse(raw));
      }}
      placeholder="key:라벨, key2:라벨2"
    />
  );
}
