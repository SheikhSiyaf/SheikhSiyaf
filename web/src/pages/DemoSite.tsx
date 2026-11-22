// The demo site (a separate deployment with fictional companies, src/api/demo.ts). The platform owner arrives from the live
// app's Demo mode button with a signed link, picks a client type here, and enters that demo company, where everything can
// be tried: nothing is sent to ZATCA or anyone's email, and none of it is real.
import { useEffect, useState } from 'react';
import { api, useApi } from '../api.ts';
import { useI18n } from '../i18n.tsx';
import { Loading, errorText } from '../ui.tsx';

interface Entry { key: string; title: string; titleAr: string | null; industry: string | null; blurb: string | null; blurbAr: string | null }

/** True on the demo site. */
export function useDemoSite(): boolean {
  const cfg = useApi<{ demoSite?: boolean }>('/api/config');
  return Boolean(cfg.data?.demoSite);
}

export function DemoPicker() {
  const { t, has, lang } = useI18n();
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState<string>();

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const token = new URLSearchParams(window.location.search).get('t');
        if (token) {
          await api('/api/demo/open', { body: { token } });
          window.history.replaceState(null, '', '/demo');   // the link is used once; do not leave it in the address bar
        }
        const list = await api<Entry[]>('/api/demo/entries');
        if (live) setEntries(list);
      } catch (e) { if (live) setProblem(errorText(t, has, e)); }
    })();
    return () => { live = false; };
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  const enter = async (key: string) => {
    setBusy(key);
    try {
      const r = await api<{ path: string }>('/api/demo/enter', { body: { key } });
      window.location.assign(r.path);   // a full load: the new sign-in starts clean
    } catch (e) { setProblem(errorText(t, has, e)); setBusy(undefined); }
  };

  return (
    <main className="demo-picker">
      <div className="demo-hero">
        <h1>{t('demoSite.title')}</h1>
        <p className="mut">{t('demoSite.intro')}</p>
        <div className="notice small" role="note">{t('demoSite.safe')}</div>
      </div>
      {problem && <div className="notice bad" role="alert" id="demo-problem">{problem}</div>}
      {!entries && !problem && <Loading />}
      {entries && (
        <div className="demo-grid" id="demo-types">
          {entries.map((e) => (
            <button key={e.key} className="card demo-card" id={`demo-${e.key}`} disabled={busy !== undefined} onClick={() => void enter(e.key)}>
              <b>{lang === 'ar' && e.titleAr ? e.titleAr : e.title}</b>
              <span className="mut small">{lang === 'ar' && e.blurbAr ? e.blurbAr : e.blurb}</span>
              <span className="b p small">{busy === e.key ? t('demoSite.opening') : t('demoSite.open')}</span>
            </button>
          ))}
        </div>
      )}
    </main>
  );
}
