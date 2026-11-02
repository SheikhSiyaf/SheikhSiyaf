import { useEffect } from 'react';
import { api, useApi, type Me } from './api.ts';
import { DEMO, navigate, usePath } from './router.ts';
import { useI18n } from './i18n.tsx';
import { Login } from './pages/Login.tsx';
import { MyClients } from './pages/MyClients.tsx';
import { Workspace } from './books/Workspace.tsx';
import { AdminConsole } from './admin/AdminConsole.tsx';
import { AcceptInvite } from './pages/AcceptInvite.tsx';
import { Security } from './pages/Security.tsx';
import { ErrorNote, Loading } from './ui.tsx';

export function App() {
  return (
    <>
      {DEMO && <DemoBanner />}
      <Screens />
    </>
  );
}

function DemoBanner() {
  const { t } = useI18n();
  return <div className="demo-banner" role="note">{t('demo.banner')}</div>;
}

function Screens() {
  const me = useApi<Me>('/api/me');
  const path = usePath();

  const signOut = async () => {
    await api('/api/logout', { method: 'POST', body: {} }).catch(() => undefined);
    navigate('/');
    me.reload();
  };

  // Login decides everything: send each kind of user to their own starting screen.
  const user = me.data?.user;
  useEffect(() => {
    if (!user) return;
    if (path.startsWith('/invite/') || path === '/security') return;
    if (user.kind === 'admin' && !path.startsWith('/admin')) navigate('/admin/clients');
    if (user.kind !== 'admin' && path.startsWith('/admin')) navigate('/');
    if (user.kind === 'client' && !path.startsWith('/c/') && me.data!.companies[0]) navigate(`/c/${me.data!.companies[0].id}/Home`);
  }, [user, path, me.data]);

  // A sign-in link works whether or not someone is signed in on this device.
  const invite = /^\/invite\/([\w-]+)$/.exec(path);
  if (invite) return <AcceptInvite token={invite[1]!} onDone={me.reload} />;

  // Keep the sign-in form mounted while the session is re-checked, so typed text is not lost.
  if (me.loading && !me.data && !me.error) return <main><Loading /></main>;
  if (me.error?.status === 401 || (!me.data && me.error)) {
    if (me.error.status !== 401) return <main><ErrorNote error={me.error} onRetry={me.reload} /></main>;
    return <Login onSignedIn={() => { navigate('/'); me.reload(); }} />;
  }
  if (!me.data) return null;

  if (path === '/security') {
    return <Security me={me.data} onSignOut={signOut} onChanged={me.reload} onBack={() => window.history.length > 1 && !DEMO ? window.history.back() : navigate('/')} />;
  }
  if (me.data.user.kind === 'admin') return <AdminConsole me={me.data} path={path} onSignOut={signOut} />;

  const m = /^\/c\/([0-9a-f-]{36})(?:\/(\w+))?/.exec(path);
  if (m) {
    const company = me.data.companies.find((c) => c.id === m[1]);
    if (company) return <Workspace me={me.data} companyId={company.id} module={m[2] ?? 'Home'} onSignOut={signOut} />;
  }
  return <MyClients me={me.data} onSignOut={signOut} />;
}
