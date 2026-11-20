// The ZATCA monitor's judgement, kept free of any server or database code so the same rules run in the server, in the
// tests and in the browser-only demo. From plain facts about a company's e-invoicing it says whether everything is
// fine, what needs attention, and what to do about it.
export const CERT_WARN_DAYS = 30;

export type Severity = 'critical' | 'warning' | 'info';
export type MonitorState = 'off' | 'ok' | 'test' | 'attention' | 'critical';
/** What the screen offers for a finding. */
export type FindingAction = 'connect' | 'renew' | 'send_now' | 'review_rejected' | 'none';
export interface Finding { code: string; severity: Severity; params: Record<string, unknown>; action: FindingAction }

export interface Facts {
  country: string;
  enabled: boolean;
  productionAllowed: boolean;
  devices: Array<{ id: string; environment: string; status: string; certDaysLeft: number | null }>;
  waiting: Record<'simplified' | 'standard', { count: number; oldestAt: string | null }>;
  rejected: number;        // rejected and not yet sent again
  loginRefused: number;    // waiting invoices whose last answer was ZATCA refusing the login (401 / 403)
  sender: { lastFinishedAt: string | null; lastOk: boolean | null; lastError: string | null };
  now: Date;
}

/** The automatic sender runs every 2 minutes; ten minutes without a run is a real gap, not a slow tick. */
export const SENDER_GAP_MINUTES = 10;
const ORDER: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };
const hoursSince = (iso: string, now: Date) => (now.getTime() - new Date(iso).getTime()) / 3_600_000;

export function assess(f: Facts): { state: MonitorState; findings: Finding[] } {
  if (f.country !== 'SA') return { state: 'off', findings: [] };
  const out: Finding[] = [];
  const add = (code: string, severity: Severity, params: Record<string, unknown> = {}, action: FindingAction = 'none') => out.push({ code, severity, params, action });
  const active = f.devices.filter((d) => d.status === 'active');
  // A device that was started and never finished (its checks failed, or ZATCA's certificate did not match its key).
  // It is not "not in use": someone began connecting and it is stuck, and only this screen can say so.
  const unfinished = f.devices.find((d) => ['compliance', 'checks_failed', 'checks_passed'].includes(d.status));
  const stuck = () => { if (unfinished && !active.length) add('setup_unfinished', 'warning', { status: unfinished.status }, 'connect'); };

  if (!f.enabled) {
    add('not_enabled', 'info', {}, 'connect'); stuck();
    out.sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
    return { state: out.some((x) => x.severity === 'warning') ? 'attention' : 'off', findings: out };
  }

  if (!active.length) { if (unfinished) stuck(); else add('no_device', 'warning', {}, 'connect'); }
  else {
    const test = active.find((d) => d.environment !== 'production');
    if (test) add('test_mode', 'info', { environment: test.environment });
    if (!f.productionAllowed && active.some((d) => d.environment === 'production')) add('production_blocked', 'critical');
    const days = active.map((d) => d.certDaysLeft).filter((d): d is number => d !== null);
    if (days.length) {
      const left = Math.min(...days);
      if (left <= 0) add('cert_ended', 'critical', {}, 'renew');
      else if (left <= CERT_WARN_DAYS) add('cert_expiring', 'warning', { days: left }, 'renew');
    }
  }

  const sim = f.waiting.simplified, std = f.waiting.standard;
  if (sim.count && sim.oldestAt) {
    const h = hoursSince(sim.oldestAt, f.now);
    if (h >= 12) add('late_simplified', h >= 24 ? 'critical' : 'warning', { count: sim.count, hours: Math.floor(h) }, 'send_now');
  }
  if (std.count && std.oldestAt) {
    const h = hoursSince(std.oldestAt, f.now);
    if (h >= 1) add('late_standard', h >= 24 ? 'critical' : 'warning', { count: std.count, hours: Math.floor(h) }, 'send_now');
  }
  if (f.rejected) add('rejected', 'critical', { count: f.rejected }, 'review_rejected');
  if (f.loginRefused) add('login_refused', 'critical', { count: f.loginRefused }, 'renew');

  const waiting = sim.count + std.count;
  const s = f.sender;
  if (s.lastOk === false) add('sender_failed', 'warning', { error: s.lastError ?? '' });
  if (waiting) {
    const minutes = s.lastFinishedAt ? (f.now.getTime() - new Date(s.lastFinishedAt).getTime()) / 60_000 : Infinity;
    if (minutes > SENDER_GAP_MINUTES) {
      add('sender_stalled', 'warning', s.lastFinishedAt ? { hours: Math.floor(minutes / 60), minutes: Math.floor(minutes) } : { never: true });
    }
  }

  out.sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
  const worst = out[0]?.severity;
  const state: MonitorState = worst === 'critical' ? 'critical' : worst === 'warning' ? 'attention' : out.some((x) => x.code === 'test_mode') ? 'test' : 'ok';
  return { state, findings: out };
}

