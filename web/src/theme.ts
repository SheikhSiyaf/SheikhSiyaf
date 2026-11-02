export function initTheme() {
  try {
    const t = localStorage.getItem('nb.theme');
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  } catch { /* storage unavailable */ }
}

export function toggleTheme() {
  const r = document.documentElement;
  const dark = r.dataset.theme ? r.dataset.theme === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
  r.dataset.theme = dark ? 'light' : 'dark';
  try { localStorage.setItem('nb.theme', r.dataset.theme); } catch { /* storage unavailable */ }
}
