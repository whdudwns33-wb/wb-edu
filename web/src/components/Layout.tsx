import { AccountTab } from '../pages/SettingsPage.tsx';
import { isManager, roleLabel } from '@wb/shared';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth.tsx';

const NAV = [
  { to: '/plans', label: '계획 목록', mobile: '계획' },
  { to: '/today', label: '오늘 수업 (휴대폰)', mobile: '오늘' },
  { to: '/textbooks', label: '교재 보관함', mobile: '교재' },
  { to: '/curricula', label: '표준과정·조립판', mobile: '과정' },
  { to: '/plans/new', label: '계획 만들기', mobile: '만들기' },
  { to: '/objectives', label: '학습목표 지도', mobile: '목표' },
  { to: '/settings', label: '양식·운영 설정', mobile: '설정' },
];

export function Layout() {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  async function signOut() {
    await logout();
    nav('/login');
  }
  if (user?.mustChangePassword) return <main className="main"><h1>첫 로그인 비밀번호 변경</h1><AccountTab /><button onClick={signOut}>로그아웃</button></main>;
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          WB 커리큘럼 플래너
          <small>교재 → 표준과정 → 실행계획 → 진도</small>
        </div>
        <nav aria-label="기본 메뉴">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === '/plans' || n.to === '/plans/new'}>
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="user">
          {user?.displayName} ({roleLabel(user?.role)})
          <div className="mt">
            <button
              className="sm"
              onClick={signOut}
            >
              로그아웃
            </button>
          </div>
        </div>
      </aside>
      <main className="main">
        <Outlet />
      </main>
      <nav
        className="bottom-nav"
        aria-label="모바일 기본 메뉴"
        onClick={(e) => {
          if ((e.target as HTMLElement).closest('a')) e.currentTarget.querySelector('details')?.removeAttribute('open');
        }}
      >
        {NAV.filter((n) => ['/plans', '/today', '/textbooks', '/curricula', '/settings'].includes(n.to)).map((n) => (
          <NavLink key={n.to} to={n.to} end={n.to === '/plans'}>
            {n.mobile}
          </NavLink>
        ))}
        <details className="mobile-more">
          <summary>더보기</summary>
          <div className="mobile-more-menu">
            <nav aria-label="추가 메뉴">
              {NAV.filter((n) => ['/plans/new', '/objectives'].includes(n.to)).map((n) => (
                <NavLink key={n.to} to={n.to} end>{n.label}</NavLink>
              ))}
            </nav>
            <div className="mobile-account">
              <span>{user?.displayName} ({roleLabel(user?.role)})</span>
              <button onClick={signOut}>로그아웃</button>
            </div>
          </div>
        </details>
      </nav>
    </div>
  );
}
