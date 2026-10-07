import { createRoot } from 'react-dom/client';
import { initI18n } from './i18n';
import { App } from './app/App';
import { captureHandoff } from './analytics';
import { clearStaleChunkReloadFlag, installStaleChunkListener } from './app/stale-chunk';
import './styles.css';

// A stale tab (open across a deploy) failing to load a hashed chunk is a
// site-wide possibility, not just a mermaid/table/board thing — install this
// before anything else so it catches it wherever it happens. See
// app/stale-chunk.ts for the full story.
installStaleChunkListener();

// The marketing site's "Try the demo" link carries an anonymous visit id in the address. Read it (and remove it from
// the address bar) before anything renders; analytics, if the server switches it on, continues that visit.
captureHandoff();

// Must resolve before the first render — see i18n/index.ts's own doc comment.
void initI18n().then(() => {
  createRoot(document.getElementById('root')!).render(<App />);
  // We actually rendered — if a stale-chunk reload happened earlier this
  // session, it worked. Clear the flag so a FUTURE deploy gets its own fresh
  // attempt instead of silently skipping straight to the error text.
  clearStaleChunkReloadFlag();
});
