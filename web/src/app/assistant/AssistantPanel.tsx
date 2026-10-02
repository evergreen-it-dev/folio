import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLocation, useNavigate, matchPath } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Bot, ChevronUp, History, Loader2, MessageCircle, Minus, Plus, Send, Settings, Shield, Square, X } from 'lucide-react';
import type { AssistantMessage, AssistantRunMode } from '@shared/contracts';
import { api } from '../api';
import { useAssistantRun } from './runState';
import { useApiErrorText } from '../errorText';
import { useActivePageId, useLocalStorage } from '../hooks';
import { useToast } from '../ui/Toast';
import { Menu } from '../ui/Menu';
import { AssistantSettingsModal } from './AssistantSettingsModal';
import { renderChatMarkdown } from './chatMarkdown';
import '../i18n/register';

/**
 * Tailwind arbitrary-variant rules compacting rehype's default block/inline
 * elements to read well in this panel's ~440px width — see chatMarkdown.ts
 * for the sanitize-then-stringify pipeline that produces the HTML this
 * wraps. Kept as one shared class string rather than duplicated per call
 * site (there's only the one, but it's a mouthful).
 */
const CHAT_MARKDOWN_CLASS =
  'folio-chat-md text-sm [&_p]:my-1 [&_ul]:my-1 [&_ol]:my-1 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 ' +
  '[&_li]:my-0.5 [&_h1]:mt-2 [&_h2]:mt-2 [&_h3]:mt-2 [&_h1]:mb-1 [&_h2]:mb-1 [&_h3]:mb-1 [&_h1]:text-base [&_h2]:text-base ' +
  '[&_h3]:text-sm [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold [&_p:first-child]:mt-0 [&_h1:first-child]:mt-0 ' +
  '[&_h2:first-child]:mt-0 [&_h3:first-child]:mt-0 [&_p:last-child]:mb-0 [&_blockquote]:my-1 [&_blockquote]:border-l-2 ' +
  '[&_blockquote]:border-neutral-300 [&_blockquote]:pl-2 [&_blockquote]:text-neutral-600 dark:[&_blockquote]:border-neutral-600 ' +
  'dark:[&_blockquote]:text-neutral-400 [&_code]:rounded [&_code]:bg-neutral-100 [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[13px] ' +
  'dark:[&_code]:bg-neutral-800 [&_pre]:my-1 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-neutral-100 [&_pre]:p-2 ' +
  'dark:[&_pre]:bg-neutral-800 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_table]:my-1 [&_table]:text-xs [&_th]:border ' +
  '[&_td]:border [&_th]:border-neutral-300 [&_td]:border-neutral-300 dark:[&_th]:border-neutral-700 dark:[&_td]:border-neutral-700 ' +
  '[&_th]:px-1 [&_td]:px-1 [&_a]:underline [&_hr]:my-2 [&_hr]:border-neutral-300 dark:[&_hr]:border-neutral-700';

/** Assistant reply body: rendered markdown (sanitized), memoized per text — see chatMarkdown.ts. */
function AssistantMessageContent({ text }: { text: string }) {
  const html = useMemo(() => renderChatMarkdown(text), [text]);
  return <div className={CHAT_MARKDOWN_CLASS} dangerouslySetInnerHTML={{ __html: html }} />;
}

export interface AssistantPanelProps {
  /**
   * Panel stays mounted while closed (`open` only toggles CSS `hidden`) —
   * historically so a running stream survived, but a run is server-side
   * tracked by AssistantRunProvider now regardless of this panel's
   * mount/open state (see runState.tsx). Kept mounted anyway: cheaper than
   * re-fetching the conversation/settings queries on every toggle.
   */
  open: boolean;
  onClose: () => void;
}

// sessionStorage (not localStorage): "survive a reload" per the
// brief, deliberately scoped to the tab — a stale conversation id carried
// forever across every future tab/session isn't worth the persistence.
const CONVERSATION_STORAGE_KEY = 'folio:assistant:conversationId';

function readStoredConversationId(): string | null {
  try {
    return sessionStorage.getItem(CONVERSATION_STORAGE_KEY);
  } catch {
    return null;
  }
}

function storeConversationId(id: string | null) {
  try {
    if (id) sessionStorage.setItem(CONVERSATION_STORAGE_KEY, id);
    else sessionStorage.removeItem(CONVERSATION_STORAGE_KEY);
  } catch {
    // Storage full/unavailable (private mode) — state still works in-memory for this session.
  }
}

function segmentClass(active: boolean): string {
  return `flex-1 rounded px-2.5 py-1 text-xs font-medium transition-colors ${
    active
      ? 'bg-white text-neutral-900 shadow-sm dark:bg-neutral-600 dark:text-neutral-50'
      : 'text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200'
  }`;
}

/**
 * The "Ask AI" chat panel — opened from Sidebar (which owns the open/close
 * state), floating above it bottom-left. Ported from a sibling project's
 * assistant-widget.tsx, trimmed to Folio's slimmer contract: no file
 * attachments, explain mode or element picker — just Ask/Agent + streamed
 * text. Completed assistant replies render as sanitized markdown (see
 * chatMarkdown.ts's own minimal unified pipeline — deliberately not
 * web/src/markdown's <Markdown>, to avoid its mentionable-list fetch firing
 * on every message for a `space`/`pagePath` this panel doesn't really have a
 * stable one of); the in-progress streaming bubble stays plain pre-wrapped
 * text (re-parsing markdown on every delta buys nothing since it's about to
 * be replaced), and user messages are always plain text.
 *
 * The actual run — starting it, subscribing to its NDJSON events, surviving
 * disconnects/F5/navigation — lives in useAssistantRun() (runState.tsx),
 * shared with the Sidebar button's spinner. This component is purely
 * conversation UI: which conversation is shown, the message list, the
 * composer, and reflecting that hook's live streamText/step/reconnecting.
 */

/**
 * Where the visible sidebar ends (viewport px), or 0 when it's hidden
 * (collapsed on desktop, or the <md drawer). The panel docks just right of
 * it so the page tree stays clickable while the chat is open — the owner
 * navigates page-to-page with the panel up. Measured from the DOM
 * (Sidebar's own width/collapse state lives there) via ResizeObserver, so it
 * follows drag-resize and collapse without prop plumbing across the app.
 */
function useSidebarRightEdge(): number {
  const [edge, setEdge] = useState(0);
  useEffect(() => {
    let observer: ResizeObserver | null = null;
    let observed: Element | null = null;
    const measure = () => {
      const el = document.querySelector('[data-folio-sidebar]');
      if (el !== observed) {
        observer?.disconnect();
        observed = el;
        if (el && typeof ResizeObserver !== 'undefined') {
          observer = new ResizeObserver(measure);
          observer.observe(el);
        }
      }
      if (!el) {
        setEdge(0);
        return;
      }
      const rect = el.getBoundingClientRect();
      // md+ only: the mobile drawer is position:fixed and overlays content.
      const desktop = window.matchMedia('(min-width: 768px)').matches;
      const visible = desktop && rect.width > 0 && getComputedStyle(el).position !== 'fixed';
      setEdge(visible ? Math.round(rect.right) : 0);
    };
    measure();
    window.addEventListener('resize', measure);
    // Sidebar mounts/unmounts with the space route — re-find it after route changes.
    const mo = new MutationObserver(measure);
    mo.observe(document.body, { childList: true, subtree: false });
    return () => {
      window.removeEventListener('resize', measure);
      observer?.disconnect();
      mo.disconnect();
    };
  }, []);
  return edge;
}

export function AssistantPanel({ open, onClose }: AssistantPanelProps) {
  const { t } = useTranslation('app');
  const errorText = useApiErrorText();
  const showToast = useToast();
  const run = useAssistantRun();
  const location = useLocation();
  const navigate = useNavigate();
  const pageId = useActivePageId();
  const currentPath = location.pathname;
  const sidebarEdge = useSidebarRightEdge();
  // Mounted above the route tree (AssistantHost), so the space comes from the
  // URL rather than from a Sidebar prop — null outside /s/<space>/…
  const space = matchPath('/s/:space/*', currentPath)?.params.space ?? matchPath('/s/:space', currentPath)?.params.space ?? null;
  // `.agent` rules indicator (owner spec, 21.09.2026; widened 22.09.2026) —
  // shares the ['spaces'] cache with Sidebar/SpaceSwitcher (no extra
  // request). `agentRules` is present for every MEMBER once the space has
  // any `.agent` pages; only its `path` is admin-only (server/routes.ts's
  // GET /api/spaces) — the render below picks link-vs-plain-text on that.
  const { data: spacesData } = useQuery({ queryKey: ['spaces'], queryFn: api.listSpaces });
  const agentRules = space ? spacesData?.spaces.find((s) => s.slug === space)?.agentRules : undefined;

  const [conversationId, setConversationId] = useState<string | null>(readStoredConversationId);
  const [startNew, setStartNew] = useState(false);
  const [pendingMessages, setPendingMessages] = useState<AssistantMessage[]>([]);
  const [draft, setDraft] = useState('');
  // Owner (17.09): Agent is the default mode — Ask stays one click away. The
  // assistant is mostly asked to CHANGE pages, and starting in Ask meant every
  // such request had to be re-sent after switching.
  // The minimized state is remembered between sessions — like the fact of the panel being open.
  const [minimized, setMinimized] = useLocalStorage('folio:assistant-minimized', false);
  const [runMode, setRunMode] = useState<AssistantRunMode>('agent');
  // Covers the gap between clicking send and run.start()'s POST resolving —
  // run.isRunning only flips once the server has actually accepted the run,
  // so without this the conversation query could refetch (and briefly show
  // stale data) in that window. Mirrors the old code's synchronous
  // setIsRunning(true) before its network call.
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const busy = run.isRunning || isSubmitting;

  const settings = useQuery({ queryKey: ['assistant', 'settings'], queryFn: api.getAssistantSettings });
  const conversation = useQuery({
    queryKey: ['assistant', 'chat', conversationId ?? 'latest'],
    queryFn: () => api.getAssistantConversation(conversationId),
    // Stays enabled during a run: after F5 the saved user question must show
    // above the live stream (the run hook invalidates it again on complete).
    enabled: !isSubmitting,
  });
  const conversations = useQuery({ queryKey: ['assistant', 'conversations'], queryFn: api.listAssistantConversations });

  // Tells the run hook whether it's OK to toast "finished" — only while this
  // panel isn't visible (open prop only toggles CSS `hidden`, panel itself
  // stays mounted, so this must track `open`, not mount/unmount).
  useEffect(() => {
    run.setPanelOpen(open);
    return () => run.setPanelOpen(false);
    // run.setPanelOpen is stable (useCallback, [] deps in runState.tsx) — `run` itself
    // is a fresh object every provider render, so depending on it would refire every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, run.setPanelOpen]);

  // A run started elsewhere in this app instance (F5 reconnect via
  // AssistantRunProvider's mount effect, or a run started before this
  // conversation was selected) may belong to a different conversation than
  // the one currently shown — follow it so the live text lands somewhere visible.
  useEffect(() => {
    const runConversationId = run.activeRun?.conversationId;
    if (runConversationId && runConversationId !== conversationId) {
      setStartNew(false);
      setConversationId(runConversationId);
      storeConversationId(runConversationId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.activeRun?.conversationId]);

  // A run's finished message, applied optimistically the instant it lands
  // (deduped by id below) rather than waiting for the invalidated query's
  // refetch — see runState.tsx's `lastMessage` doc comment.
  useEffect(() => {
    const message = run.lastMessage;
    if (!message) return;
    setPendingMessages((current) => (current.some((m) => m.id === message.id) ? current : [...current, message]));
  }, [run.lastMessage]);

  // Once the invalidated conversation query has actually refetched, its
  // `messages` is the authoritative list — drop the optimistic overlay.
  useEffect(() => {
    setPendingMessages([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation.dataUpdatedAt]);

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [pendingMessages, conversation.data?.messages, run.isRunning, run.streamText]);

  const ready = Boolean(settings.data?.apiKeyConfigured && settings.data.runtimeAvailable);
  const storedMessages = startNew ? [] : (conversation.data?.messages ?? []);
  const messages = useMemo(() => [...storedMessages, ...pendingMessages], [storedMessages, pendingMessages]);
  const activeConversationId = conversationId ?? conversation.data?.conversationId ?? null;
  const step = run.step;
  const statusText = step
    ? step.status === 'tool' && step.label
      ? t('assistant.chat.status.tool', { tool: step.label })
      : (step.label ?? t(`assistant.chat.status.${step.status}`))
    : t('assistant.chat.status.starting');

  function newConversation() {
    if (busy) return;
    setStartNew(true);
    setConversationId(null);
    storeConversationId(null);
    setPendingMessages([]);
    setDraft('');
  }

  function selectConversation(id: string) {
    if (busy) return;
    setStartNew(false);
    setConversationId(id);
    storeConversationId(id);
    setPendingMessages([]);
  }

  async function stop() {
    const partial = run.streamText;
    if (partial.trim()) {
      setPendingMessages((current) => [
        ...current,
        { id: `optimistic-stopped-${Date.now()}`, role: 'assistant', content: partial, createdAt: new Date().toISOString() },
      ]);
    }
    await run.stop();
  }

  async function submit() {
    const message = draft.trim();
    if (!message || busy || !ready) return;
    const now = new Date().toISOString();
    const optimistic: AssistantMessage = { id: `optimistic-${Date.now()}`, role: 'user', content: message, createdAt: now };
    setPendingMessages((current) => [...current, optimistic]);
    setDraft('');
    setIsSubmitting(true);
    try {
      const res = await run.start({
        message,
        runMode,
        conversationId: startNew ? null : activeConversationId,
        startNew,
        currentPath,
        space,
        pageId: pageId ?? null,
      });
      setStartNew(false);
      setConversationId(res.conversationId);
      storeConversationId(res.conversationId);
    } catch (error) {
      // The run never started server-side — drop the optimistic bubble, it was never sent.
      setPendingMessages((current) => current.filter((m) => m.id !== optimistic.id));
      showToast(errorText(error, 'assistant.chat.sendFailed'));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <section
      role="dialog"
      aria-label={t('assistant.chat.title')}
      hidden={!open}
      // Owner (17.09): the panel is on the right and can be minimized.
      // Minimizing is a crop to the height of the header, NOT unmounting: the
      // conversation, an unfinished run and unsent text stay in place, and
      // expanding brings everything back as it was.
      className={`fixed bottom-14 right-2 z-[70] flex w-[440px] max-w-[calc(100vw-1rem)] flex-col overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-2xl max-md:inset-x-2 max-md:bottom-2 max-md:w-auto md:bottom-2 dark:border-neutral-700 dark:bg-neutral-900 ${
        minimized ? 'h-[52px]' : 'h-[min(88vh,960px)] max-md:h-[min(70vh,720px)]'
      }`}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-neutral-200 px-3 py-2.5 dark:border-neutral-800">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
          <Bot size={16} aria-hidden="true" />
        </span>
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-neutral-900 dark:text-neutral-100">{t('assistant.chat.title')}</h2>
        <button
          type="button"
          onClick={newConversation}
          disabled={busy}
          aria-label={t('assistant.chat.new')}
          title={t('assistant.chat.new')}
          className="shrink-0 rounded p-1.5 text-neutral-500 hover:bg-neutral-100 disabled:opacity-40 dark:hover:bg-neutral-800"
        >
          <Plus size={15} />
        </button>
        <Menu trigger={<History size={15} />} triggerLabel={t('assistant.chat.history')} align="right" className="w-auto shrink-0">
          {(close) => (
            <div className="max-h-80 w-64 overflow-y-auto">
              {conversations.isLoading && <p className="px-2.5 py-3 text-xs text-neutral-400">{t('ui.loading')}</p>}
              {!conversations.isLoading && (conversations.data?.items.length ?? 0) === 0 && (
                <p className="px-2.5 py-3 text-xs text-neutral-400">{t('assistant.chat.noHistory')}</p>
              )}
              {conversations.data?.items.map((item) => (
                <button
                  key={item.conversationId}
                  type="button"
                  onClick={() => {
                    selectConversation(item.conversationId);
                    close();
                  }}
                  className={`block w-full truncate rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800 ${
                    activeConversationId === item.conversationId ? 'bg-neutral-100 dark:bg-neutral-800' : ''
                  }`}
                >
                  {item.title || t('assistant.chat.untitled')}
                </button>
              ))}
            </div>
          )}
        </Menu>
        <button
          type="button"
          onClick={() => setMinimized((v) => !v)}
          aria-label={minimized ? t('assistant.chat.expand') : t('assistant.chat.minimize')}
          title={minimized ? t('assistant.chat.expand') : t('assistant.chat.minimize')}
          className="shrink-0 rounded p-1.5 text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
        >
          {minimized ? <ChevronUp size={15} /> : <Minus size={15} />}
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('assistant.chat.close')}
          className="shrink-0 rounded p-1.5 text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
        >
          <X size={15} />
        </button>
      </div>

      {settings.isLoading ? (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-neutral-400" />
        </div>
      ) : !ready ? (
        <div className="m-3 rounded-lg border border-neutral-200 bg-neutral-50 p-3 text-sm dark:border-neutral-700 dark:bg-neutral-800/60">
          <p className="font-medium text-neutral-900 dark:text-neutral-100">{t('assistant.chat.notConfiguredTitle')}</p>
          <p className="mt-1 text-neutral-500 dark:text-neutral-400">{t('assistant.chat.notConfiguredDescription')}</p>
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="mt-2.5 flex items-center gap-1.5 rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white dark:bg-white dark:text-neutral-900"
          >
            <Settings size={14} />
            {t('assistant.chat.openSettings')}
          </button>
        </div>
      ) : (
        <>
          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
            <div className="flex flex-col gap-2.5">
              {conversation.isLoading && messages.length === 0 && (
                <div className="flex justify-center py-8">
                  <Loader2 className="h-5 w-5 animate-spin text-neutral-400" />
                </div>
              )}
              {!conversation.isLoading && messages.length === 0 && (
                <div className="py-10 text-center">
                  <MessageCircle className="mx-auto h-7 w-7 text-neutral-300 dark:text-neutral-600" />
                  <p className="mt-2 text-sm text-neutral-500 dark:text-neutral-400">{t('assistant.chat.emptyTitle')}</p>
                </div>
              )}
              {messages.map((message) => (
                <div
                  key={message.id}
                  className={`max-w-[88%] rounded-xl px-3 py-2 text-sm ${
                    message.role === 'user'
                      ? 'ml-auto whitespace-pre-wrap bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900'
                      : 'mr-auto border border-neutral-200 bg-neutral-50 text-neutral-800 dark:border-neutral-700 dark:bg-neutral-800/60 dark:text-neutral-100'
                  }`}
                >
                  {message.role === 'user' ? message.content : <AssistantMessageContent text={message.content} />}
                </div>
              ))}
              {run.isRunning && (
                <div className="mr-auto max-w-[88%] rounded-xl border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-800/60">
                  {run.streamText && <p className="whitespace-pre-wrap text-neutral-800 dark:text-neutral-100">{run.streamText}</p>}
                  <div
                    className={`flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400 ${
                      run.streamText ? 'mt-2 border-t border-neutral-200 pt-2 dark:border-neutral-700' : ''
                    }`}
                  >
                    <Loader2 className={`h-3.5 w-3.5 shrink-0 animate-spin ${run.reconnecting ? 'text-amber-500' : ''}`} />
                    <span className="min-w-0 flex-1 truncate">{run.reconnecting ? t('assistant.chat.reconnecting') : statusText}</span>
                    <button
                      type="button"
                      onClick={() => void stop()}
                      className="flex shrink-0 items-center gap-1 rounded-md border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-100 dark:border-neutral-600 dark:hover:bg-neutral-700"
                    >
                      <Square size={11} className="fill-current" />
                      {t('assistant.chat.stop')}
                    </button>
                  </div>
                </div>
              )}
              <div ref={bottomRef} />
            </div>
          </div>

          {/* `.agent` rules indicator (widened 22.09.2026 — owner report: a
              viewer had no sign that space rules even exist). Shown to EVERY
              member once `used` is true — the server sends `used`/`pages` to
              anyone, but only includes `path` for whoever can actually open
              the section (space/instance admin; see shared/contracts.ts's
              SpaceInfo.agentRules). With a `path`: a clickable link, same as
              before. Without one: plain text with a tooltip explaining what
              it means, since there's nowhere for a non-admin to navigate to —
              `.agent` pages stay invisible to them everywhere else. */}
          {agentRules?.used &&
            (agentRules.path ? (
              <div className="shrink-0 border-t border-neutral-200 px-2.5 py-1.5 dark:border-neutral-800">
                <button
                  type="button"
                  onClick={() => navigate(`/s/${space}/d/${agentRules.path}`)}
                  className="flex items-center gap-1.5 text-xs text-neutral-400 hover:text-neutral-600 dark:text-neutral-500 dark:hover:text-neutral-300"
                >
                  <Shield size={12} aria-hidden="true" />
                  {t('assistant.chat.agentRules', { count: agentRules.pages })}
                </button>
              </div>
            ) : (
              <div className="shrink-0 border-t border-neutral-200 px-2.5 py-1.5 dark:border-neutral-800">
                <span
                  className="flex items-center gap-1.5 text-xs text-neutral-400 dark:text-neutral-500"
                  title={t('assistant.chat.agentRulesHint')}
                >
                  <Shield size={12} aria-hidden="true" />
                  {t('assistant.chat.agentRules', { count: agentRules.pages })}
                </span>
              </div>
            ))}

          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
            className="shrink-0 border-t border-neutral-200 p-2.5 dark:border-neutral-800"
          >
            <div className="mb-2 flex items-center gap-2">
              <div className="flex gap-0.5 rounded-md bg-neutral-100 p-0.5 dark:bg-neutral-800">
                <button
                  type="button"
                  disabled={busy}
                  title={t('assistant.chat.modeHints.ask')}
                  onClick={() => setRunMode('ask')}
                  className={segmentClass(runMode === 'ask')}
                >
                  {t('assistant.chat.modes.ask')}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  title={t('assistant.chat.modeHints.agent')}
                  onClick={() => setRunMode('agent')}
                  className={segmentClass(runMode === 'agent')}
                >
                  {t('assistant.chat.modes.agent')}
                </button>
              </div>
              <span className="ml-auto truncate text-[11px] text-neutral-400">{t(`assistant.chat.modeHints.${runMode}`)}</span>
            </div>
            <div className="flex items-end gap-2">
              <textarea
                rows={2}
                value={draft}
                disabled={busy}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    void submit();
                  }
                }}
                placeholder={t('assistant.chat.placeholder')}
                aria-label={t('assistant.chat.placeholder')}
                className="min-h-16 max-h-40 flex-1 resize-none rounded-lg border border-neutral-300 bg-white px-2.5 py-2 text-sm outline-none focus:border-neutral-500 disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
              />
              <button
                type="submit"
                disabled={!draft.trim() || busy}
                aria-label={t('assistant.chat.send')}
                title={t('assistant.chat.send')}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-neutral-900 text-white disabled:opacity-40 dark:bg-white dark:text-neutral-900"
              >
                <Send size={15} />
              </button>
            </div>
          </form>
        </>
      )}

      {settingsOpen && <AssistantSettingsModal onClose={() => setSettingsOpen(false)} />}
    </section>
  );
}
