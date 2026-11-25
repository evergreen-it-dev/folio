import { listOfflineDocuments, subscribeOfflineDocuments } from '../app/offline/savedDocuments';
import { bundlesFrom } from '../i18n/bundles';
import { renderReader, type Labels } from './view';
import './reader.css';

const root = document.querySelector<HTMLElement>('#reader')!;
const bundles = bundlesFrom(import.meta.glob('./i18n/*.json', { eager: true, import: 'default' })) as Record<string, Labels>;
let preference: string | null = null;
try { preference = localStorage.getItem('folio:lang'); } catch { /* Browser storage may be disabled. */ }
const lang = [preference, ...navigator.languages, 'en'].map((value) => value?.split('-')[0].toLowerCase())
  .map((value) => value === 'ru' ? 'uk' : value).find((value) => value && bundles[value])!;
document.documentElement.lang = lang;
const labels = bundles[lang];

// The worker supplies this entry only for eligible navigations when the network fails. Its
// physical build URL can also be opened directly; it must never be a second online reader.
if (location.search || !(location.pathname === '/' || /^\/s\/[^/]+\/p\/[^/]+$/.test(location.pathname))) {
  const home = document.createElement('a');
  home.href = '/';
  home.textContent = labels.open;
  root.append(home);
} else {
  let generation = 0;
  function clear() {
    generation++;
    root.replaceChildren();
  }
  async function refresh() {
    clear();
    const current = generation;
    try {
      const docs = await listOfflineDocuments();
      if (current === generation) renderReader(root, location.pathname, docs, labels, lang);
    } catch {
      if (current === generation) root.textContent = labels.unavailable;
    }
  }
  function reconnect() {
    clear();
    location.reload();
  }
  let probing = false;
  async function checkConnection() {
    if (probing || document.hidden || !navigator.onLine) return;
    probing = true;
    try {
      // Any HTTP answer (including a gateway redirect or denial) hands control back to
      // normal navigation. A real network failure leaves the saved snapshot available.
      await fetch('/api/auth/state', { cache: 'no-store', redirect: 'manual', signal: AbortSignal.timeout(5000) });
      reconnect();
    } catch { /* Still offline. */ }
    finally { probing = false; }
  }
  subscribeOfflineDocuments(() => { void refresh(); });
  window.addEventListener('online', reconnect);
  window.addEventListener('pagehide', clear);
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) navigator.onLine ? reconnect() : void refresh();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) clear();
    else { void refresh(); void checkConnection(); }
  });
  window.setInterval(checkConnection, 30_000);
  void refresh();
}
