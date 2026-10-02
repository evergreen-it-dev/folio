import { useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import {
  Bot,
  FileText,
  GitBranch,
  LayoutDashboard,
  MessageCircleQuestion,
  PenTool,
  Plug,
  ShieldCheck,
  Table2,
  Users,
  Wand2,
  WifiOff,
} from 'lucide-react';
import type { PageMeta } from '@shared/contracts';
import { api } from '../api';
import { canEditContent } from '../auth/roles';
import { useApiErrorText } from '../errorText';
import { readLastSpace } from '../lastSpace';
import { CreateSpaceDialog } from '../sidebar/CreateSpaceDialog';
import '../i18n/register';

/** What the first page of the first space is — the answer to the wizard's opening question. */
export type FirstKind = 'doc' | 'board' | 'table';

const KINDS: FirstKind[] = ['doc', 'board', 'table'];
const FEATURES = ['git', 'together', 'offline', 'tables', 'boards', 'access'] as const;
const AI_POINTS = ['ask', 'agent', 'rules', 'mcp'] as const;
const STEP_COUNT = 3;

const FEATURE_ICONS: Record<(typeof FEATURES)[number], ReactNode> = {
  git: <GitBranch size={18} aria-hidden="true" />,
  together: <Users size={18} aria-hidden="true" />,
  offline: <WifiOff size={18} aria-hidden="true" />,
  tables: <Table2 size={18} aria-hidden="true" />,
  boards: <PenTool size={18} aria-hidden="true" />,
  access: <ShieldCheck size={18} aria-hidden="true" />,
};

const AI_ICONS: Record<(typeof AI_POINTS)[number], ReactNode> = {
  ask: <MessageCircleQuestion size={18} aria-hidden="true" />,
  agent: <Wand2 size={18} aria-hidden="true" />,
  rules: <Bot size={18} aria-hidden="true" />,
  mcp: <Plug size={18} aria-hidden="true" />,
};

const KIND_ICONS: Record<FirstKind, ReactNode> = {
  doc: <FileText size={16} aria-hidden="true" />,
  board: <LayoutDashboard size={16} aria-hidden="true" />,
  table: <Table2 size={16} aria-hidden="true" />,
};

/**
 * The welcome wizard (the owner, 02.10.2026): what someone who has just
 * installed Folio sees instead of an empty screen with one button. Three
 * steps and then the product itself:
 *
 *   1. "What do you want to create first?" — a document, a whiteboard or a
 *      data table;
 *   2. what Folio can do — deliberately without the assistant;
 *   3. Folio AI, on a screen of its own;
 *   →  the first space is created with the chosen page in it, and that page
 *      opens.
 *
 * Shown by RootRedirect while the person has no space at all — which is
 * exactly "just installed" (or "just invited, nothing shared yet"), and stops
 * being true the moment the wizard finishes, so there is no "seen it" flag to
 * store anywhere. `/welcome` opens the same thing on purpose, as a tour: with
 * spaces already there, the page is created in the last one the person can
 * edit and no space is made.
 *
 * Client-side only. Creating a space and a page are the two requests the
 * sidebar already makes; nothing new is asked of the server.
 */
export function Onboarding() {
  const { t } = useTranslation('app');
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const errorText = useApiErrorText();

  const spacesQuery = useQuery({ queryKey: ['spaces'], queryFn: api.listSpaces });
  const spaces = spacesQuery.data?.spaces ?? [];
  const firstRun = spaces.length === 0;
  // The tour's destination: where the person last was, if they can write there.
  const editable = spaces.filter((space) => canEditContent(space.myRole));
  const remembered = readLastSpace();
  const target = editable.find((space) => space.slug === remembered) ?? editable[0];

  const [step, setStep] = useState(0);
  const [kind, setKind] = useState<FirstKind>('doc');
  const [spaceName, setSpaceName] = useState('');
  const [connectingGit, setConnectingGit] = useState(false);
  // A space that was created by an attempt whose page then failed: the retry
  // must put the page into it, not make a second space.
  const createdSpace = useRef<string | null>(null);

  const finish = useMutation({
    mutationFn: async (): Promise<PageMeta | null> => {
      let space = createdSpace.current ?? (firstRun ? null : (target?.slug ?? null));
      if (!space && firstRun) {
        const created = await api.createSpace({ name: spaceName.trim() || t('onboarding.start.spaceNameDefault') });
        createdSpace.current = created.slug;
        space = created.slug;
      }
      if (!space) return null; // a tour by someone who can only read: nothing to create
      return api.createPage({ space, parentPath: '', title: t(`onboarding.firstTitle.${kind}`), kind });
    },
    onSuccess: (page) => {
      queryClient.invalidateQueries({ queryKey: ['spaces'] });
      if (!page) {
        navigate('/');
        return;
      }
      queryClient.invalidateQueries({ queryKey: ['tree', page.space] });
      // A fresh document opens ready to type in. Router state, not the URL: a
      // copied link to this page still opens for reading, like any other.
      navigate(`/s/${page.space}/p/${page.id}`, { state: { startEditing: kind === 'doc' } });
    },
  });

  if (spacesQuery.isLoading) {
    return <div className="flex h-full items-center justify-center text-sm text-neutral-400">{t('ui.loading')}</div>;
  }
  if (spacesQuery.isError) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-sm text-red-600 dark:text-red-400">
        {t('routes.root.connectionError')}
      </div>
    );
  }

  const canCreate = firstRun || !!target;
  const last = step === STEP_COUNT - 1;

  /** "Skip" skips the tour, not the outcome: on a first run there is nowhere to land until a space exists. */
  function skip() {
    if (firstRun) finish.mutate();
    else navigate('/');
  }

  function next() {
    if (last) finish.mutate();
    else setStep(step + 1);
  }

  return (
    <div className="flex h-full min-h-screen flex-col overflow-y-auto bg-neutral-50 dark:bg-neutral-950">
      <header className="flex shrink-0 items-center gap-4 px-5 pt-4 sm:px-8">
        <span className="text-sm font-semibold tracking-tight text-neutral-900 dark:text-neutral-100">Folio</span>
        <div
          className="flex flex-1 gap-1.5"
          role="progressbar"
          aria-valuemin={1}
          aria-valuemax={STEP_COUNT}
          aria-valuenow={step + 1}
          aria-label={t('onboarding.progress', { step: step + 1, total: STEP_COUNT })}
        >
          {Array.from({ length: STEP_COUNT }, (_, index) => (
            <span
              key={index}
              className={`h-1 flex-1 rounded-full transition-colors ${
                index <= step ? 'bg-neutral-900 dark:bg-neutral-100' : 'bg-neutral-200 dark:bg-neutral-800'
              }`}
            />
          ))}
        </div>
        <button
          type="button"
          onClick={skip}
          disabled={finish.isPending}
          className="rounded-md px-2 py-1 text-sm text-neutral-500 hover:bg-neutral-200/60 hover:text-neutral-900 disabled:opacity-50 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
        >
          {t('onboarding.skip')}
        </button>
      </header>

      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-5 pb-10 pt-10 sm:px-8 sm:pt-14">
        {step === 0 && (
          <section aria-labelledby="onboarding-title">
            <StepHeading
              title={t('onboarding.start.title')}
              subtitle={
                firstRun
                  ? t('onboarding.start.subtitleFirstRun')
                  : target
                    ? t('onboarding.start.subtitleTour', { space: target.name })
                    : t('onboarding.start.subtitleReadOnly')
              }
            />
            <div role="radiogroup" aria-labelledby="onboarding-title" className="mt-8 grid gap-4 sm:grid-cols-3">
              {KINDS.map((option) => (
                <KindCard
                  key={option}
                  kind={option}
                  selected={kind === option}
                  onSelect={() => setKind(option)}
                  name={t(`onboarding.start.kinds.${option}.name`)}
                  hint={t(`onboarding.start.kinds.${option}.hint`)}
                />
              ))}
            </div>

            {firstRun && (
              <div className="mt-8">
                <label htmlFor="onboarding-space" className="block text-sm font-medium text-neutral-800 dark:text-neutral-200">
                  {t('onboarding.start.spaceName')}
                </label>
                <input
                  id="onboarding-space"
                  value={spaceName}
                  onChange={(event) => setSpaceName(event.target.value)}
                  placeholder={t('onboarding.start.spaceNameDefault')}
                  maxLength={80}
                  className="mt-1.5 h-10 w-full max-w-sm rounded-md border border-neutral-300 bg-white px-3 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
                />
                <p className="mt-1.5 text-xs text-neutral-500 dark:text-neutral-400">{t('onboarding.start.spaceNameHint')}</p>
                <p className="mt-5 text-sm text-neutral-500 dark:text-neutral-400">
                  {t('onboarding.start.git')}{' '}
                  <button
                    type="button"
                    onClick={() => setConnectingGit(true)}
                    className="font-medium text-neutral-900 underline decoration-neutral-300 underline-offset-2 hover:decoration-neutral-900 dark:text-neutral-100 dark:decoration-neutral-600 dark:hover:decoration-neutral-100"
                  >
                    {t('onboarding.start.gitAction')}
                  </button>
                </p>
              </div>
            )}
          </section>
        )}

        {step === 1 && (
          <section aria-labelledby="onboarding-title">
            <StepHeading title={t('onboarding.features.title')} subtitle={t('onboarding.features.subtitle')} />
            <ul className="mt-8 grid gap-3 sm:grid-cols-2">
              {FEATURES.map((feature) => (
                <li
                  key={feature}
                  className="flex gap-3 rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900"
                >
                  <IconBadge>{FEATURE_ICONS[feature]}</IconBadge>
                  <div className="min-w-0">
                    <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
                      {t(`onboarding.features.items.${feature}.title`)}
                    </h3>
                    <p className="mt-1 text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
                      {t(`onboarding.features.items.${feature}.text`)}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        {step === 2 && (
          <section aria-labelledby="onboarding-title">
            <StepHeading title={t('onboarding.ai.title')} subtitle={t('onboarding.ai.subtitle')} />
            <div className="mt-8 grid gap-6 sm:grid-cols-[minmax(0,1fr)_17rem]">
              <ul className="flex flex-col gap-4">
                {AI_POINTS.map((point) => (
                  <li key={point} className="flex gap-3">
                    <IconBadge>{AI_ICONS[point]}</IconBadge>
                    <div className="min-w-0">
                      <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
                        {t(`onboarding.ai.items.${point}.title`)}
                      </h3>
                      <p className="mt-1 text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
                        {t(`onboarding.ai.items.${point}.text`)}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
              <ChatArt question={t('onboarding.ai.art.question')} answer={t('onboarding.ai.art.answer')} source={t('onboarding.ai.art.source')} />
            </div>
            <p className="mt-8 rounded-lg border border-neutral-200 bg-white px-4 py-3 text-sm leading-relaxed text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
              {t('onboarding.ai.byos')}
            </p>
          </section>
        )}

        <footer className="mt-10 flex items-center gap-3">
          {step > 0 && (
            <button
              type="button"
              onClick={() => setStep(step - 1)}
              disabled={finish.isPending}
              className="rounded-md px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-200/60 disabled:opacity-50 dark:text-neutral-300 dark:hover:bg-neutral-800"
            >
              {t('onboarding.back')}
            </button>
          )}
          <button
            type="button"
            onClick={next}
            disabled={finish.isPending}
            className="rounded-md bg-neutral-900 px-5 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
          >
            {finish.isPending
              ? t('onboarding.finish.creating')
              : !last
                ? t('onboarding.continue')
                : canCreate
                  ? t(`onboarding.finish.${kind}`)
                  : t('onboarding.finish.done')}
          </button>
          {finish.isError && (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {errorText(finish.error, 'onboarding.finish.failed')}
            </p>
          )}
        </footer>
      </main>

      {connectingGit && <CreateSpaceDialog onClose={() => setConnectingGit(false)} initialTab="git" />}
    </div>
  );
}

function StepHeading({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <>
      <h1 id="onboarding-title" className="text-2xl font-semibold tracking-tight text-neutral-900 sm:text-3xl dark:text-neutral-100">
        {title}
      </h1>
      <p className="mt-3 max-w-2xl text-base leading-relaxed text-neutral-600 dark:text-neutral-400">{subtitle}</p>
    </>
  );
}

function IconBadge({ children }: { children: ReactNode }) {
  return (
    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200">
      {children}
    </span>
  );
}

function KindCard({ kind, selected, onSelect, name, hint }: {
  kind: FirstKind;
  selected: boolean;
  onSelect: () => void;
  name: string;
  hint: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={`group flex flex-col overflow-hidden rounded-xl border text-left transition-shadow focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400 ${
        selected
          ? 'border-neutral-900 shadow-sm ring-1 ring-neutral-900 dark:border-neutral-100 dark:ring-neutral-100'
          : 'border-neutral-200 hover:border-neutral-400 dark:border-neutral-800 dark:hover:border-neutral-600'
      }`}
    >
      <span className="flex h-36 items-center justify-center bg-white px-5 dark:bg-neutral-900">
        {kind === 'doc' ? <DocArt /> : kind === 'board' ? <BoardArt /> : <TableArt />}
      </span>
      <span
        className={`flex flex-1 flex-col gap-1 border-t px-4 py-3 ${
          selected
            ? 'border-neutral-200 bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-800'
            : 'border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-900/60'
        }`}
      >
        <span className="flex items-center gap-2 text-sm font-semibold text-neutral-900 dark:text-neutral-100">
          {KIND_ICONS[kind]}
          {name}
        </span>
        <span className="text-xs leading-relaxed text-neutral-600 dark:text-neutral-400">{hint}</span>
      </span>
    </button>
  );
}

/*
 * The three card pictures and the chat sketch are drawings, not screenshots:
 * they carry no text of their own to translate (the chat's three lines come
 * in as props) and follow the theme through Tailwind's fill/stroke classes.
 */

const LINE = 'fill-neutral-200 dark:fill-neutral-700';
const LINE_STRONG = 'fill-neutral-400 dark:fill-neutral-500';
const STROKE = 'stroke-neutral-300 dark:stroke-neutral-600';

function DocArt() {
  return (
    <svg viewBox="0 0 200 110" className="h-full w-full max-w-[13rem]" aria-hidden="true">
      <rect x="0" y="8" width="96" height="9" rx="4.5" className={LINE_STRONG} />
      <circle cx="170" cy="12" r="8" className="fill-amber-300 dark:fill-amber-400/80" />
      <circle cx="184" cy="12" r="8" className="fill-sky-300 dark:fill-sky-400/80" />
      <rect x="0" y="34" width="200" height="6" rx="3" className={LINE} />
      <rect x="0" y="48" width="184" height="6" rx="3" className={LINE} />
      <rect x="0" y="62" width="120" height="6" rx="3" className={LINE} />
      <rect x="122" y="58" width="2" height="14" className="fill-sky-500" />
      <rect x="0" y="84" width="150" height="6" rx="3" className={LINE} />
      <rect x="0" y="98" width="76" height="6" rx="3" className={LINE} />
      <rect x="78" y="94" width="2" height="14" className="fill-amber-500" />
    </svg>
  );
}

function BoardArt() {
  return (
    <svg viewBox="0 0 200 110" className="h-full w-full max-w-[13rem]" aria-hidden="true">
      <rect x="6" y="14" width="58" height="34" rx="6" fill="none" strokeWidth="2" className={STROKE} />
      <rect x="18" y="27" width="34" height="5" rx="2.5" className={LINE} />
      <path d="M64 31 H96" fill="none" strokeWidth="2" className={STROKE} />
      <path d="M92 26 L98 31 L92 36" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={STROKE} />
      <path d="M126 10 L154 31 L126 52 L98 31 Z" fill="none" strokeWidth="2" strokeLinejoin="round" className={STROKE} />
      <path d="M126 52 V72" fill="none" strokeWidth="2" className={STROKE} />
      <rect x="92" y="72" width="68" height="30" rx="6" className="fill-violet-200 dark:fill-violet-400/40" />
      <rect x="104" y="84" width="44" height="5" rx="2.5" className="fill-violet-400 dark:fill-violet-300/70" />
      <rect x="14" y="62" width="46" height="40" rx="3" className="fill-amber-200 dark:fill-amber-400/50" transform="rotate(-4 37 82)" />
      <rect x="22" y="74" width="30" height="4" rx="2" className="fill-amber-500/70 dark:fill-amber-200/80" transform="rotate(-4 37 82)" />
      <rect x="22" y="84" width="20" height="4" rx="2" className="fill-amber-500/70 dark:fill-amber-200/80" transform="rotate(-4 37 82)" />
    </svg>
  );
}

function TableArt() {
  return (
    <svg viewBox="0 0 200 110" className="h-full w-full max-w-[13rem]" aria-hidden="true">
      <rect x="1" y="8" width="198" height="94" rx="6" fill="none" strokeWidth="2" className={STROKE} />
      <path d="M1 34 H199 M1 68 H199 M78 8 V102 M140 8 V102" fill="none" strokeWidth="2" className={STROKE} />
      <rect x="12" y="18" width="42" height="6" rx="3" className={LINE_STRONG} />
      <rect x="88" y="18" width="30" height="6" rx="3" className={LINE_STRONG} />
      <rect x="150" y="18" width="30" height="6" rx="3" className={LINE_STRONG} />
      <rect x="12" y="48" width="52" height="6" rx="3" className={LINE} />
      <rect x="88" y="44" width="38" height="14" rx="7" className="fill-sky-200 dark:fill-sky-400/40" />
      <rect x="150" y="48" width="36" height="6" rx="3" className={LINE} />
      <rect x="12" y="82" width="38" height="6" rx="3" className={LINE} />
      <rect x="88" y="78" width="44" height="14" rx="7" className="fill-emerald-200 dark:fill-emerald-400/40" />
      <rect x="150" y="82" width="24" height="6" rx="3" className={LINE} />
    </svg>
  );
}

function ChatArt({ question, answer, source }: { question: string; answer: string; source: string }) {
  return (
    <div
      aria-hidden="true"
      className="flex flex-col gap-2.5 self-start rounded-xl border border-neutral-200 bg-white p-3.5 text-xs leading-relaxed dark:border-neutral-800 dark:bg-neutral-900"
    >
      <p className="ml-6 self-end rounded-lg rounded-br-sm bg-neutral-900 px-3 py-2 text-white dark:bg-neutral-100 dark:text-neutral-900">
        {question}
      </p>
      <p className="mr-6 rounded-lg rounded-bl-sm bg-neutral-100 px-3 py-2 text-neutral-800 dark:bg-neutral-800 dark:text-neutral-200">
        {answer}
      </p>
      <p className="mr-6 flex items-center gap-1.5 text-neutral-500 dark:text-neutral-400">
        <FileText size={12} />
        {source}
      </p>
    </div>
  );
}
