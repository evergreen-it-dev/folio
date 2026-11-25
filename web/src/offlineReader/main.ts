import { getOfflineDocument, listOfflineDocuments, subscribeOfflineDocuments } from '../app/offline/savedDocuments';
import { bundlesFrom } from '../i18n/bundles';
import { parseDocumentPath, renderReader, type Labels } from './view';
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
  let readingOffline = false;
  function clear() {
    generation++;
    readingOffline = false;
    root.replaceChildren();
  }
  async function refresh() {
    clear();
    readingOffline = true;
    const current = generation;
    try {
      const address = parseDocumentPath(location.pathname);
      let content;
      if (location.pathname === '/') content = await listOfflineDocuments();
      else if (address) content = await getOfflineDocument(address.space, address.id);
      if (current === generation) renderReader(root, content, labels, lang);
    } catch {
      if (current === generation) root.textContent = labels.unavailable;
    }
  }
  function reconnect() {
    clear();
    location.reload();
  }
  let probe: Promise<boolean> | undefined;
  function canReachServer(): Promise<boolean> {
    if (document.hidden || !navigator.onLine) return Promise.resolve(false);
    // Any HTTP answer (including a gateway redirect or denial) hands control back to
    // normal navigation. A genuine network failure leaves the saved snapshot available.
    probe ??= fetch('/api/auth/state', { cache: 'no-store', redirect: 'manual', signal: AbortSignal.timeout(5000) })
      .then(() => true, () => false)
      .finally(() => { probe = undefined; });
    return probe;
  }
  async function resume() {
    if (await canReachServer()) reconnect();
    else if (!document.hidden) await refresh();
  }
  subscribeOfflineDocuments(() => { if (readingOffline && !document.hidden) void refresh(); });
  window.addEventListener('online', reconnect);
  window.addEventListener('pagehide', clear);
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) navigator.onLine ? reconnect() : void refresh();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) clear();
    else void resume();
  });
  window.setInterval(() => { void canReachServer().then((reachable) => { if (reachable) reconnect(); }); }, 30_000);
  // A single failed navigation can reach this reader on a live network. Offer a retry
  // rather than displaying stored content or automatically repeating the same failing navigation.
  void canReachServer().then((reachable) => {
    if (!reachable) return refresh();
    const retry = document.createElement('a');
    retry.href = location.pathname;
    retry.textContent = labels.retry;
    root.replaceChildren(retry);
  });
}
