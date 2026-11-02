import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from './i18n.tsx';
import { App } from './App.tsx';
import { initTheme } from './theme.ts';
import './styles.css';

initTheme();
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </StrictMode>,
);
