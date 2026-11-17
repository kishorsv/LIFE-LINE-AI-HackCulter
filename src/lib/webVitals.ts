// Native browser PerformanceObserver Core Web Vitals reporter (LCP, INP, CLS, TTFB)

interface VitalsSample {
  lcpMs?: number;
  inpMs?: number;
  cls?: number;
  ttfbMs?: number;
}

let initialized = false;

export function initWebVitalsReporting() {
  if (initialized || typeof window === 'undefined' || typeof PerformanceObserver === 'undefined') {
    return;
  }
  initialized = true;

  const sample: VitalsSample = {};
  let clsValue = 0;
  let maxInp = 0;
  let flushed = false;
  const observers: PerformanceObserver[] = [];

  try {
    const navEntries = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[];
    if (navEntries.length > 0) {
      const nav = navEntries[0];
      const ttfb = Math.max(0, nav.responseStart - nav.requestStart);
      if (Number.isFinite(ttfb)) {
        sample.ttfbMs = Math.round(ttfb);
      }
    }
  } catch {
    // ignore unsupported navigation timing
  }

  try {
    const lcpObserver = new PerformanceObserver((entryList) => {
      const entries = entryList.getEntries();
      const last = entries[entries.length - 1];
      if (last && Number.isFinite(last.startTime)) {
        sample.lcpMs = Math.round(last.startTime);
      }
    });
    lcpObserver.observe({ type: 'largest-contentful-paint', buffered: true });
    observers.push(lcpObserver);
  } catch {
    // LCP observer unsupported
  }

  try {
    const clsObserver = new PerformanceObserver((entryList) => {
      for (const entry of entryList.getEntries() as Array<PerformanceEntry & { value?: number; hadRecentInput?: boolean }>) {
        if (!entry.hadRecentInput && typeof entry.value === 'number') {
          clsValue += entry.value;
          sample.cls = Number(clsValue.toFixed(4));
        }
      }
    });
    clsObserver.observe({ type: 'layout-shift', buffered: true });
    observers.push(clsObserver);
  } catch {
    // CLS observer unsupported
  }

  try {
    const inpObserver = new PerformanceObserver((entryList) => {
      for (const entry of entryList.getEntries() as Array<PerformanceEntry & { duration?: number; interactionId?: number }>) {
        if ((entry.interactionId || entry.entryType === 'first-input') && typeof entry.duration === 'number') {
          if (entry.duration > maxInp) {
            maxInp = entry.duration;
            sample.inpMs = Math.round(maxInp);
          }
        }
      }
    });
    inpObserver.observe({ type: 'event', buffered: true });
    observers.push(inpObserver);
  } catch {
    try {
      const fidObserver = new PerformanceObserver((entryList) => {
        for (const entry of entryList.getEntries() as Array<PerformanceEntry & { processingStart?: number; startTime: number }>) {
          if (typeof entry.processingStart === 'number') {
            const delay = Math.round(entry.processingStart - entry.startTime);
            if (delay > maxInp) {
              maxInp = delay;
              sample.inpMs = delay;
            }
          }
        }
      });
      fidObserver.observe({ type: 'first-input', buffered: true });
      observers.push(fidObserver);
    } catch {
      // INP/FID observer unsupported
    }
  }

  const flush = () => {
    if (flushed) return;
    if (
      sample.lcpMs === undefined &&
      sample.inpMs === undefined &&
      sample.cls === undefined &&
      sample.ttfbMs === undefined
    ) {
      return;
    }
    flushed = true;
    for (const obs of observers) {
      try {
        obs.disconnect();
      } catch {
        // ignore
      }
    }

    const body = JSON.stringify(sample);
    try {
      if (typeof navigator.sendBeacon === 'function') {
        const blob = new Blob([body], { type: 'application/json' });
        if (navigator.sendBeacon('/api/metrics/vitals', blob)) return;
      }
    } catch {
      // fall through to keepalive fetch
    }

    fetch('/api/metrics/vitals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => {});
  };

  const onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') {
      flush();
    }
  };
  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('pagehide', flush, { once: true });

  // Also capture initial load telemetry shortly after load settles so Operator System Health populates immediately
  setTimeout(() => {
    if (!flushed && (sample.lcpMs !== undefined || sample.ttfbMs !== undefined)) {
      const snapshotPayload = JSON.stringify(sample);
      fetch('/api/metrics/vitals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: snapshotPayload,
        keepalive: true,
      }).catch(() => {});
    }
  }, 4500);
}
