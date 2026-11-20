// The ZATCA monitor's judgement (src/books/einvoiceMonitor.ts): from plain facts about a company's e-invoicing it
// says whether everything is fine, what needs attention, and what to do about it. Pure rules, no database.
import { describe, it, expect } from 'vitest';
import { assess, type Facts } from '../src/books/einvoiceMonitor.js';

const NOW = new Date('2026-11-20T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const base = (over: Partial<Facts> = {}): Facts => ({
  country: 'SA', enabled: true, productionAllowed: false,
  devices: [{ id: 'd1', environment: 'production', status: 'active', certDaysLeft: 200 }],
  waiting: { simplified: { count: 0, oldestAt: null }, standard: { count: 0, oldestAt: null } },
  rejected: 0, loginRefused: 0,
  sender: { lastFinishedAt: hoursAgo(0.02), lastOk: true, lastError: null }, now: NOW, ...over,
});
const codes = (f: Facts) => assess(f).findings.map((x) => x.code);

describe('assess: the overall state', () => {
  it('is ok when connected in production, nothing waiting, certificate far away and the sender running', () => {
    const r = assess(base({ productionAllowed: true }));
    expect(r.state).toBe('ok');
    expect(r.findings).toEqual([]);
  });
  it('is off, with one plain reason, for a company outside Saudi Arabia or one that has not turned e-invoicing on', () => {
    expect(assess(base({ country: 'AE' })).state).toBe('off');
    expect(codes(base({ enabled: false }))).toEqual(['not_enabled']);
    expect(assess(base({ enabled: false })).state).toBe('off');
  });
  it('is attention for a warning and critical for anything urgent, critical first', () => {
    expect(assess(base({ productionAllowed: true, devices: [{ id: 'd', environment: 'production', status: 'active', certDaysLeft: 20 }] })).state).toBe('attention');
    const r = assess(base({ productionAllowed: true, rejected: 2, devices: [{ id: 'd', environment: 'production', status: 'active', certDaysLeft: 20 }] }));
    expect(r.state).toBe('critical');
    expect(r.findings[0]!.severity).toBe('critical');
  });
});

describe('assess: a half-finished connection', () => {
  const unfinished = (status: string, enabled = false) => base({ enabled, devices: [{ id: 'd', environment: 'sandbox', status, certDaysLeft: null }] });
  it('is told apart from "not in use": the device was started and never finished', () => {
    for (const status of ['compliance', 'checks_failed', 'checks_passed']) {
      const r = assess(unfinished(status));
      expect(r.findings.map((x) => x.code)).toEqual(expect.arrayContaining(['not_enabled', 'setup_unfinished']));
      expect(r.findings.find((x) => x.code === 'setup_unfinished')).toMatchObject({ severity: 'warning', params: { status }, action: 'connect' });
      expect(r.state).toBe('attention');
    }
  });
  it('replaces the generic "no device" message when a device exists but is unfinished', () => {
    const r = assess(unfinished('checks_passed', true));
    expect(r.findings.map((x) => x.code)).toContain('setup_unfinished');
    expect(r.findings.map((x) => x.code)).not.toContain('no_device');
  });
  it('is not raised for a replaced device or once another device is active', () => {
    expect(codes(unfinished('retired'))).toEqual(['not_enabled']);
    expect(codes(base({ productionAllowed: true, devices: [
      { id: 'a', environment: 'production', status: 'active', certDaysLeft: 200 }, { id: 'b', environment: 'production', status: 'checks_failed', certDaysLeft: null }] }))).not.toContain('setup_unfinished');
  });
});

describe('assess: connection and test mode', () => {
  it('asks to connect when enabled but no device is active', () => {
    expect(codes(base({ devices: [] }))).toContain('no_device');
    expect(codes(base({ devices: [{ id: 'd', environment: 'sandbox', status: 'pending', certDaysLeft: null }] }))).toContain('no_device');
  });
  it('says plainly that sandbox and simulation invoices are not reported to the real ZATCA', () => {
    for (const environment of ['sandbox', 'simulation']) {
      const r = assess(base({ devices: [{ id: 'd', environment, status: 'active', certDaysLeft: 200 }] }));
      const t = r.findings.find((x) => x.code === 'test_mode');
      expect(t?.severity).toBe('info');
      expect(t?.params.environment).toBe(environment);
    }
  });
  it('flags a production device on a server that does not allow production', () => {
    expect(codes(base({ productionAllowed: false }))).toContain('production_blocked');
    expect(codes(base({ productionAllowed: true }))).not.toContain('production_blocked');
  });
});

describe('assess: the certificate', () => {
  const dev = (days: number | null) => base({ productionAllowed: true, devices: [{ id: 'd', environment: 'production', status: 'active', certDaysLeft: days }] });
  it('warns inside 30 days, is critical when it has ended, and is quiet otherwise', () => {
    expect(codes(dev(31))).not.toContain('cert_expiring');
    expect(assess(dev(30)).findings.find((x) => x.code === 'cert_expiring')).toMatchObject({ severity: 'warning', params: { days: 30 }, action: 'renew' });
    expect(assess(dev(0)).findings.find((x) => x.code === 'cert_ended')).toMatchObject({ severity: 'critical', action: 'renew' });
    expect(assess(dev(-3)).findings.find((x) => x.code === 'cert_ended')).toBeTruthy();
  });
});

describe('assess: invoices waiting for ZATCA', () => {
  const wait = (kind: 'simplified' | 'standard', count: number, hours: number) => base({
    productionAllowed: true,
    waiting: { simplified: { count: 0, oldestAt: null }, standard: { count: 0, oldestAt: null }, [kind]: { count, oldestAt: hoursAgo(hours) } },
  });
  it('simplified invoices must be reported within 24 hours: warning from 12, critical from 24', () => {
    expect(codes(wait('simplified', 2, 11))).not.toContain('late_simplified');
    expect(assess(wait('simplified', 2, 12)).findings.find((x) => x.code === 'late_simplified')).toMatchObject({ severity: 'warning', params: { count: 2, hours: 12 }, action: 'send_now' });
    expect(assess(wait('simplified', 2, 24)).findings.find((x) => x.code === 'late_simplified')?.severity).toBe('critical');
  });
  it('standard invoices wait for clearance: warning from 1 hour, critical from 24', () => {
    expect(codes(wait('standard', 1, 0.5))).not.toContain('late_standard');
    expect(assess(wait('standard', 1, 1)).findings.find((x) => x.code === 'late_standard')?.severity).toBe('warning');
    expect(assess(wait('standard', 1, 25)).findings.find((x) => x.code === 'late_standard')?.severity).toBe('critical');
  });
  it('a rejection is critical and points at the rejected list; a refused login points at renewal', () => {
    expect(assess(base({ productionAllowed: true, rejected: 3 })).findings.find((x) => x.code === 'rejected')).toMatchObject({ severity: 'critical', params: { count: 3 }, action: 'review_rejected' });
    expect(assess(base({ productionAllowed: true, loginRefused: 1 })).findings.find((x) => x.code === 'login_refused')).toMatchObject({ severity: 'critical', action: 'renew' });
  });
});

describe('assess: the automatic sender', () => {
  const withWaiting = (sender: Facts['sender']) => base({ productionAllowed: true, sender, waiting: { simplified: { count: 1, oldestAt: hoursAgo(0.2) }, standard: { count: 0, oldestAt: null } } });
  it('is not a finding while it ran in the last 10 minutes', () => {
    expect(codes(withWaiting({ lastFinishedAt: hoursAgo(0.1), lastOk: true, lastError: null }))).not.toContain('sender_stalled');
  });
  it('is a warning when invoices are waiting and it has not run for over 10 minutes, with the time since', () => {
    const r = assess(withWaiting({ lastFinishedAt: hoursAgo(3), lastOk: true, lastError: null })).findings.find((x) => x.code === 'sender_stalled');
    expect(r).toMatchObject({ severity: 'warning', params: { hours: 3 } });
  });
  it('has its own wording when it has never run, and when its last run failed (with the error)', () => {
    expect(assess(withWaiting({ lastFinishedAt: null, lastOk: null, lastError: null })).findings.find((x) => x.code === 'sender_stalled')?.params.never).toBe(true);
    expect(assess(withWaiting({ lastFinishedAt: hoursAgo(0.05), lastOk: false, lastError: 'connect ETIMEDOUT' })).findings.find((x) => x.code === 'sender_failed')?.params.error).toBe('connect ETIMEDOUT');
  });
  it('says nothing about the sender when nothing is waiting: an idle, sleeping server has nothing to miss', () => {
    expect(codes(base({ productionAllowed: true, sender: { lastFinishedAt: hoursAgo(30), lastOk: true, lastError: null } }))).not.toContain('sender_stalled');
  });
});
