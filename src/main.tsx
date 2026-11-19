import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import App from './App.tsx';
import './index.css';
import { initWebVitalsReporting } from './lib/webVitals.ts';

import {
  detectMapsErrorCodeFromText,
  dispatchMapsAuthError,
  dispatchMapsQuotaExceeded,
} from './lib/googleMapsStatus.ts';

let lastQuotaErrorAt = 0;
let lastAuthErrorAt = 0;

// Google Maps Auth & Quota Defense (registered before React mounts)
(window as unknown as { gm_authFailure?: () => void }).gm_authFailure = () => {
  setTimeout(() => {
    const now = Date.now();
    if (now - lastQuotaErrorAt < 800 || now - lastAuthErrorAt < 800) return;
    dispatchMapsAuthError('AuthFailure');
  }, 80);
};

const origConsoleError = console.error;
console.error = (...args: unknown[]) => {
  origConsoleError.apply(console, args);
  const msg = args.map((a) => String(a)).join(' ');
  if (msg.includes('OverQuotaMapError') || msg.includes('QuotaExceededError')) {
    lastQuotaErrorAt = Date.now();
    dispatchMapsQuotaExceeded();
    return;
  }
  const detectedCode = detectMapsErrorCodeFromText(msg);
  if (detectedCode || msg.includes('Google Maps JavaScript API error')) {
    lastAuthErrorAt = Date.now();
    dispatchMapsAuthError(detectedCode || 'AuthFailure', msg);
  }
};

// Register Service Worker for offline emergency asset caching & resilience
registerSW({ immediate: true });
initWebVitalsReporting();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
