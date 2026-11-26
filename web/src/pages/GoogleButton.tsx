// "Continue with Google". Google draws the button itself (its rules), inside its own frame; we only get back a signed proof of who the person is
// and send it to the server, which checks it (src/auth/googleToken.ts). Nothing of Google's loads unless the server says a Client ID is set.
import { useEffect, useRef, useState } from 'react';
import { api } from '../api.ts';
import { useI18n } from '../i18n.tsx';

interface GoogleId {
  initialize(o: { client_id: string; callback: (r: { credential?: string }) => void; nonce: string; ux_mode: 'popup'; auto_select: boolean; cancel_on_tap_outside: boolean }): void;
  renderButton(el: HTMLElement, o: Record<string, unknown>): void;
}
declare global { interface Window { google?: { accounts?: { id?: GoogleId } } } }

const SRC = 'https://accounts.google.com/gsi/client';
let loading: Promise<GoogleId> | undefined;
function loadGoogle(): Promise<GoogleId> {
  loading ??= new Promise<GoogleId>((resolve, reject) => {
    const done = () => { const id = window.google?.accounts?.id; if (id) resolve(id); else { loading = undefined; reject(new Error('google')); } };
    const s = document.createElement('script');
    s.src = SRC; s.async = true; s.defer = true;
    s.onload = done; s.onerror = () => { loading = undefined; s.remove(); reject(new Error('google')); };
    document.head.appendChild(s);
  });
  return loading;
}

/** What to do after a Google answer that is not a sign-in: a new person's company step, or the two-step code of an existing one. */
export type GoogleNext = { needsCompany: true; ticket: string; email: string; name: string } | { twoFactor: true; ticket: string };
export const pendingGoogle: { current?: GoogleNext } = {};

export function GoogleButton({ clientId, onCredential, text = 'continue_with' }: {
  clientId: string;
  /** Receives Google's proof and the one-time value the server gave out. Throw to show a problem; the button is made ready again either way. */
  onCredential: (credential: string, nonce: string) => Promise<void>;
  text?: 'continue_with' | 'signin_with' | 'signup_with';
}) {
  const { t, lang } = useI18n();
  const box = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [round, setRound] = useState(0);   // each use needs a fresh one-time value, so the button is set up again after every answer
  const handler = useRef(onCredential);
  handler.current = onCredential;

  useEffect(() => {
    let dead = false;
    void (async () => {
      try {
        const [id, { nonce }] = await Promise.all([loadGoogle(), api<{ nonce: string }>('/api/google/nonce')]);
        if (dead || !box.current) return;
        id.initialize({
          client_id: clientId, nonce, ux_mode: 'popup', auto_select: false, cancel_on_tap_outside: true,
          callback: (r) => { if (r.credential) void handler.current(r.credential, nonce).finally(() => { if (!dead) setRound((n) => n + 1); }); },
        });
        box.current.innerHTML = '';
        id.renderButton(box.current, { type: 'standard', theme: 'outline', size: 'large', text, shape: 'rectangular', logo_alignment: 'left', locale: lang, width: Math.min(400, Math.max(200, Math.round(box.current.clientWidth || 320))) });
        setState('ready');
      } catch { if (!dead) setState('failed'); }
    })();
    return () => { dead = true; };
  }, [clientId, lang, text, round]);

  return (
    <div className="google-wrap">
      <div id="google-button" ref={box} className="google-btn" dir="ltr" data-state={state} />
      {state === 'loading' && <p className="small mut auth-soon" role="status">{t('google.loading')}</p>}
      {state === 'failed' && <p className="small bad auth-soon" role="alert" id="google-failed">{t('google.failed')}</p>}
    </div>
  );
}
