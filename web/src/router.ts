// Tiny path router. Uses the History API; the demo build (VITE_DEMO) keeps the path in memory,
// because a published preview page cannot change its own URL path.
import { useEffect, useState } from 'react';

export const DEMO = import.meta.env.VITE_DEMO === '1';
let memoryPath = '/';
const current = () => (DEMO ? memoryPath.split('?')[0]! : window.location.pathname);

let previousPath: string | null = null;
/** Where the person was before the last navigate (for a Back button on pages opened from inside the app). */
export const backPath = () => previousPath;

export function navigate(to: string) {
  if (to === current()) return;
  previousPath = current();
  if (DEMO) {
    memoryPath = to;
    window.dispatchEvent(new Event('nb:navigate'));
  } else {
    window.history.pushState(null, '', to);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }
  window.scrollTo(0, 0);
}

/** A date from the page's query string (…?from=2026-01-01), for a report opened from a dashboard widget with the widget's own dates. Anything that is not a date is ignored. */
export function queryDate(name: string): string | null {
  const q = DEMO ? (memoryPath.split('?')[1] ?? '') : window.location.search;
  const v = new URLSearchParams(q).get(name);
  return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

export function usePath(): string {
  const [path, setPath] = useState(current());
  useEffect(() => {
    const on = () => setPath(current());
    window.addEventListener('popstate', on);
    window.addEventListener('nb:navigate', on);
    return () => {
      window.removeEventListener('popstate', on);
      window.removeEventListener('nb:navigate', on);
    };
  }, []);
  return path;
}

export function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
