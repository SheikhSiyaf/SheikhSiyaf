// Every page guide, business type, goal and step of the guided setup has its text, in English and Arabic.
import { describe, it, expect } from 'vitest';
import { DICTS } from '../i18n.tsx';
import { GUIDE_PAGES, BUSINESS_TYPES, GOALS, STEPS } from '../../../src/books/setupRules.ts';
import { NAV } from '../books/nav.ts';

const has = (k: string) => (['en', 'ar'] as const).every((l) => Boolean((DICTS[l] as Record<string, string>)[k]));
describe('Guided setup text', () => {
  it('has a guide (title, body, try) for every guide page, and every guide page is a real module', () => {
    const modules = new Set(NAV.map((m) => m.key));
    for (const p of GUIDE_PAGES) {
      expect(modules.has(p), p).toBe(true);
      for (const part of ['title', 'body', 'try']) expect(has(`tour.${p}.${part}`), `tour.${p}.${part}`).toBe(true);
    }
  });
  it('has text for every business type, goal and step', () => {
    for (const b of BUSINESS_TYPES) expect(has(`wiz.type.${b}`), b).toBe(true);
    for (const g of GOALS) expect(has(`wiz.goal.${g}`), g).toBe(true);
    for (const s of STEPS) expect(has(`wiz.s.${s}`), s).toBe(true);
  });
  it('every module of the menu has a guide', () => {
    for (const m of NAV) expect(GUIDE_PAGES.includes(m.key as never), m.key).toBe(true);
  });
});
