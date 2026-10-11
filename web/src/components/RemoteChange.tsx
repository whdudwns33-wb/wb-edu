import { useEffect, useState } from 'react';
import { get } from '../api.ts';
import { useAuth } from '../auth.tsx';

export interface RemoteVersion {
  version: number;
  updatedAt: string;
  updatedBy: string;
  updatedByName: string;
}

/** 서버의 문서 버전을 주기적으로 확인한다. 화면이 보일 때만 묻는다. */
export function useRemoteVersion(kind: 'textbook' | 'curriculum' | 'plan', id: string | undefined, localVersion: number | undefined, intervalMs = 15000) {
  const [remote, setRemote] = useState<RemoteVersion | null>(null);
  useEffect(() => {
    if (!id || !localVersion) return;
    let alive = true;
    const check = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const r = await get<RemoteVersion>(`/api/versions/${kind}/${id}`);
        if (alive) setRemote(r);
      } catch {
        /* 네트워크 오류는 무시 (다음 주기에 다시 시도) */
      }
    };
    check();
    const t = window.setInterval(check, intervalMs);
    const onVis = () => document.visibilityState === 'visible' && check();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      alive = false;
      window.clearInterval(t);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [kind, id, localVersion, intervalMs]);
  return remote && localVersion && remote.version > localVersion ? remote : null;
}

/** 다른 사용자가 먼저 저장했을 때 보여 주는 배너 */
export function RemoteChangeBanner({ remote, localVersion, dirty, onReload }: { remote: RemoteVersion | null; localVersion: number; dirty?: boolean; onReload: () => void }) {
  const { user } = useAuth();
  if (!remote) return null;
  const who = remote.updatedBy === user?.id ? '다른 창이나 기기에서 내가' : `${remote.updatedByName}님이`;
  const at = new Date(remote.updatedAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
  return (
    <div className="alert warn remote-change" role="status">
      {who} {at}에 이 문서를 수정했습니다 (서버 v{remote.version}, 지금 화면 v{localVersion}).{' '}
      {dirty ? '지금 저장하면 충돌합니다. 내 변경을 따로 적어 둔 뒤 최신 버전을 불러오세요.' : '최신 버전을 불러오세요.'}{' '}
      <button className="sm" onClick={onReload}>
        최신 버전 불러오기
      </button>
    </div>
  );
}
