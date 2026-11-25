/** The worker only activates after an atomic install of the offline reader. */
export async function offlineReaderReady(): Promise<boolean> {
  if (!import.meta.env.PROD || !window.isSecureContext || !('serviceWorker' in navigator)) return false;
  try {
    const url = new URL('/sw.js', window.location.origin);
    const registration = await navigator.serviceWorker.register(url, { scope: '/', updateViaCache: 'none' });
    const worker = [registration.active, registration.installing, registration.waiting].find((w) => w?.scriptURL === url.href);
    if (!worker) return false;
    if (worker.state === 'activated') return true;
    if (worker.state === 'redundant') return false;
    return await new Promise<boolean>((resolve) => {
      const onStateChange = () => {
        if (worker.state === 'activated' || worker.state === 'redundant') {
          worker.removeEventListener('statechange', onStateChange);
          resolve(worker.state === 'activated');
        }
      };
      worker.addEventListener('statechange', onStateChange);
    });
  } catch {
    // Insecure origins and browsers which disallow storage still run the online wiki.
    return false;
  }
}
