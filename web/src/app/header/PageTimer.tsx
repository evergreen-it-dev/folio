import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Pause, Play, RotateCcw, Timer, Volume2, VolumeX } from 'lucide-react';
import type { PageTimerActionBody, PageTimerState } from '@shared/contracts';
import { useOutsideClick } from '../hooks';
import { armAudioUnlock, isMuted, playChime, setMuted, unlockAudio, useAudioLocked } from '../timer/chime';
import { usePageTimer, timerKeyOf, type TimerTarget } from '../timer/pageTimerStore';
import { FINISH_LATE_MS, TIMER_PRESET_MINUTES, URGENT_MS, formatClock, isGone, msLeft, nextBeatDelay, parseCustomTime, phaseOf } from '../timer/timerMath';
import { useToast } from '../ui/Toast';
import { positionMenu, type MenuCoords } from '../ui/Menu';
import { HEADER_ICON_BUTTON } from './PageActionsMenu';
import '../i18n/register';

const FLASH_MS = 8000;

/**
 * The shared page timer in the header (the owner, 16.10.2026: "a timer with
 * 1/3/5/10 minutes or a custom one, synchronized over sockets for everybody on
 * the page, with a sound at the end"). The mechanism, the permissions and the
 * wire format are in server/pageTimer.ts; the state lives in
 * timer/pageTimerStore.ts (a react-query cell filled by GET and by the
 * `/events` frames); the arithmetic in timer/timerMath.ts; the sound in
 * timer/chime.ts.
 *
 * Idle: a small icon — only for people who may start a timer (editors); a
 * reader sees nothing until somebody starts one. Running: a pill with the
 * countdown, which turns red for the last 10 seconds. Click: a popover with
 * the presets / the custom time, or with pause / resume / +1 min / reset.
 *
 * All clients render from the same `endsAt` corrected by their own clock
 * offset, so they reach 00:00 together; each one plays the chime and shows the
 * toast by itself, exactly once per timer (a reload long after the end stays quiet).
 */
export interface PageTimerProps {
  space: string;
  pageId?: string;
  /**
   * false: no idle icon — the header starts a timer from its «⋯» menu
   * («Start a timer…») and shows only the running pill. Default true.
   */
  idleTrigger?: boolean;
  /** Controlled popover (the header owns it so «⋯» can open it). Uncontrolled when omitted. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Where the popover is placed from while there is no pill or icon to place it from. */
  anchorRef?: RefObject<HTMLElement | null>;
  /** Extra classes for the idle icon's wrapper (the header hides it below md, where «⋯» starts the timer). */
  idleClassName?: string;
}

export function PageTimer({ space, pageId, idleTrigger = true, open: openProp, onOpenChange, anchorRef, idleClassName }: PageTimerProps) {
  const { t } = useTranslation('app');
  const toast = useToast();
  const target: TimerTarget = { space, pageId };
  const timerKey = timerKeyOf(target);
  const { data, act } = usePageTimer(target);

  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const openRef = useRef(open);
  openRef.current = open;
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;
  // Reports real changes only — see Menu.tsx: a closed controlled popover must
  // not answer every click on the page with onOpenChange(false).
  const [setOpen] = useState(() => (next: boolean) => {
    if (openRef.current === next) return;
    setOpenState(next);
    onOpenChangeRef.current?.(next);
  });
  const [coords, setCoords] = useState<MenuCoords | null>(null);
  const [customMinutes, setCustomMinutes] = useState('');
  const [customSeconds, setCustomSeconds] = useState('');
  const [invalid, setInvalid] = useState(false);
  const [muted, setMutedState] = useState(isMuted);
  const [flashing, setFlashing] = useState(false);
  const [, setBeat] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const firedFor = useRef<string | null>(null);
  const audioLocked = useAudioLocked();

  const offsetMs = data?.offsetMs ?? 0;
  const canControl = data?.canControl ?? false;
  const rawTimer = data?.timer ?? null;
  const timer: PageTimerState | null = rawTimer && !isGone(rawTimer, Date.now(), offsetMs) ? rawTimer : null;
  const endsAt = timer?.endsAt ?? null;

  // Another page: the popover of the previous one must not stay open, nor the typed time.
  useEffect(() => {
    setOpen(false);
    setInvalid(false);
  }, [timerKey]);

  useEffect(() => {
    if (timer) armAudioUnlock();
  }, [timer !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  // Redraw exactly when the displayed second changes (and once more when a finished timer clears itself).
  useEffect(() => {
    if (!timer || timer.endsAt === null) return;
    const left = msLeft(timer, Date.now(), offsetMs);
    const delay = left > 0 ? nextBeatDelay(left) : Math.max(1000, timer.endsAt + 5 * 60_000 - (Date.now() + offsetMs));
    const id = setTimeout(() => setBeat((n) => n + 1), delay);
    return () => clearTimeout(id);
  });

  // The end: once per timer per device, at the moment the countdown reaches zero.
  useEffect(() => {
    if (endsAt === null) return;
    const token = `${timerKey}:${endsAt}`;
    if (firedFor.current === token) return;
    const delay = endsAt - (Date.now() + offsetMs);
    // Long over (a reload, a latecomer, a stale cache): shown as finished, but silent.
    if (delay < -FINISH_LATE_MS) {
      firedFor.current = token;
      return;
    }
    const id = setTimeout(() => {
      firedFor.current = token;
      const heard = playChime();
      toast(heard ? t('timer.timeUp') : `${t('timer.timeUp')} · ${t('timer.soundLockedToast')}`, 'info');
      setFlashing(true);
    }, Math.max(0, delay));
    return () => clearTimeout(id);
  }, [endsAt, offsetMs, timerKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!flashing) return;
    const id = setTimeout(() => setFlashing(false), FLASH_MS);
    return () => clearTimeout(id);
  }, [flashing]);
  // A new run of the timer (or another page) ends the old flash.
  useEffect(() => setFlashing(false), [endsAt, timerKey]);

  useLayoutEffect(() => {
    if (!open) {
      setCoords(null);
      return;
    }
    // A hidden trigger (the idle icon below md) has no box: place from the anchor then.
    const triggerBox = triggerRef.current?.getBoundingClientRect();
    const triggerEl = triggerBox && triggerBox.width > 0 ? triggerRef.current : anchorRef?.current ?? triggerRef.current;
    const panelEl = panelRef.current;
    if (triggerEl && panelEl) setCoords(positionMenu(triggerEl.getBoundingClientRect(), panelEl.getBoundingClientRect(), 'right'));
  }, [open, timer === null, canControl, audioLocked, invalid]);

  const [dismiss] = useState(() => () => setOpen(false));
  useOutsideClick([triggerRef, panelRef], dismiss);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    const dismiss = (event: Event) => {
      if (event.target instanceof Node && panelRef.current?.contains(event.target)) return;
      setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', dismiss, { capture: true });
    window.addEventListener('resize', dismiss);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', dismiss, { capture: true });
      window.removeEventListener('resize', dismiss);
    };
  }, [open]);

  // Nothing to show: not loaded yet (or the server said no), and nothing running that a reader could look at.
  if (!data) return null;
  if (!timer && !canControl) return null;

  const send = (body: PageTimerActionBody, closeAfter = false): void => {
    void unlockAudio();
    act.mutate(body, { onError: () => toast(t('timer.failed')) });
    if (closeAfter) setOpen(false);
  };

  const startCustom = (): void => {
    const parsed = parseCustomTime(customMinutes, customSeconds);
    if (!parsed.ok) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    send({ action: 'start', durationMs: parsed.durationMs }, true);
  };

  const now = Date.now();
  const phase = timer ? phaseOf(timer, now, offsetMs) : null;
  const left = timer ? Math.max(0, msLeft(timer, now, offsetMs)) : 0;
  const clock = formatClock(left);
  const urgent = phase === 'running' && left <= URGENT_MS;

  const label = !timer
    ? t('timer.button')
    : phase === 'finished'
      ? t('timer.pillFinished')
      : phase === 'paused'
        ? t('timer.pillPaused', { time: clock })
        : t('timer.pill', { time: clock });

  const pillTone =
    phase === 'finished'
      ? flashing
        ? 'animate-pulse border-red-500 bg-red-500 text-white'
        : 'border-red-300 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300'
      : urgent
        ? 'animate-pulse border-red-300 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300'
        : phase === 'paused'
          ? 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300'
          : 'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-300';

  const toggleMuted = (): void => {
    const next = !muted;
    setMuted(next);
    setMutedState(next);
  };

  const popover =
    open &&
    createPortal(
      <div
        ref={panelRef}
        role="dialog"
        aria-label={t('timer.title')}
        style={{ position: 'fixed', top: coords?.top ?? 0, left: coords?.left ?? 0, visibility: coords ? 'visible' : 'hidden' }}
        // z-[80] — as in Menu.tsx: above all floating surfaces.
        className="z-[80] w-[min(18rem,calc(100vw-1rem))] rounded-lg border border-neutral-200 bg-white p-3 text-sm text-neutral-700 shadow-lg dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200"
      >
        {timer ? (
          <div className="flex flex-col gap-2.5">
            <div className="flex items-baseline justify-between gap-2">
              <span className={`text-3xl font-semibold tabular-nums ${phase === 'finished' || urgent ? 'text-red-600 dark:text-red-400' : ''}`}>{clock}</span>
              <span className="text-xs text-neutral-500 dark:text-neutral-400">
                {phase === 'finished' ? t('timer.finished') : phase === 'paused' ? t('timer.paused', { time: clock }) : ''}
              </span>
            </div>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('timer.startedBy', { name: timer.startedByName })}</p>
            {canControl && (
              <div className="flex flex-wrap gap-1.5">
                {phase === 'running' && (
                  <TimerButton icon={<Pause size={14} aria-hidden="true" />} disabled={act.isPending} onClick={() => send({ action: 'pause' })}>
                    {t('timer.pause')}
                  </TimerButton>
                )}
                {phase === 'paused' && (
                  <TimerButton icon={<Play size={14} aria-hidden="true" />} disabled={act.isPending} onClick={() => send({ action: 'resume' })}>
                    {t('timer.resume')}
                  </TimerButton>
                )}
                <TimerButton disabled={act.isPending} onClick={() => send({ action: 'add', ms: 60_000 })}>
                  {t('timer.addMinute')}
                </TimerButton>
                <TimerButton icon={<RotateCcw size={14} aria-hidden="true" />} disabled={act.isPending} onClick={() => send({ action: 'reset' }, true)}>
                  {t('timer.reset')}
                </TimerButton>
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-2.5">
            <p className="text-xs text-neutral-500 dark:text-neutral-400">{pageId ? t('timer.sharedPage') : t('timer.sharedSpace')}</p>
            <div className="grid grid-cols-4 gap-1.5" role="group" aria-label={t('timer.presets')}>
              {TIMER_PRESET_MINUTES.map((minutes) => (
                <button
                  key={minutes}
                  type="button"
                  disabled={act.isPending}
                  onClick={() => send({ action: 'start', durationMs: minutes * 60_000 }, true)}
                  className="rounded-md border border-neutral-300 px-1 py-1.5 text-xs font-medium hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-600 dark:hover:bg-neutral-800"
                >
                  {t('timer.minutesShort', { count: minutes })}
                </button>
              ))}
            </div>
            <form
              className="flex flex-col gap-1.5"
              onSubmit={(event) => {
                event.preventDefault();
                startCustom();
              }}
            >
              <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">{t('timer.custom')}</span>
              <div className="flex items-end gap-1.5">
                <label className="flex min-w-0 flex-1 flex-col gap-0.5 text-[11px] text-neutral-500 dark:text-neutral-400">
                  {t('timer.minutes')}
                  <input
                    inputMode="numeric"
                    autoComplete="off"
                    placeholder="0"
                    value={customMinutes}
                    onChange={(event) => {
                      setCustomMinutes(event.target.value);
                      setInvalid(false);
                    }}
                    className="w-full rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm tabular-nums text-neutral-800 dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100"
                  />
                </label>
                <label className="flex min-w-0 flex-1 flex-col gap-0.5 text-[11px] text-neutral-500 dark:text-neutral-400">
                  {t('timer.seconds')}
                  <input
                    inputMode="numeric"
                    autoComplete="off"
                    placeholder="0"
                    value={customSeconds}
                    onChange={(event) => {
                      setCustomSeconds(event.target.value);
                      setInvalid(false);
                    }}
                    className="w-full rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm tabular-nums text-neutral-800 dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100"
                  />
                </label>
                <button
                  type="submit"
                  disabled={act.isPending}
                  className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {t('timer.start')}
                </button>
              </div>
              {invalid && (
                <span role="alert" className="text-xs text-red-600 dark:text-red-400">
                  {t('timer.invalid')}
                </span>
              )}
            </form>
          </div>
        )}

        <div className="mt-3 flex flex-col gap-1.5 border-t border-neutral-200 pt-2.5 dark:border-neutral-700">
          <label className="flex cursor-pointer items-center gap-2 text-xs">
            <input type="checkbox" checked={!muted} onChange={toggleMuted} />
            {muted ? <VolumeX size={13} aria-hidden="true" /> : <Volume2 size={13} aria-hidden="true" />}
            {t('timer.muteLabel')}
          </label>
          {audioLocked && !muted && (
            <div className="flex items-center justify-between gap-2 text-xs text-amber-700 dark:text-amber-400">
              <span>{t('timer.soundLocked')}</span>
              <button
                type="button"
                onClick={() => void unlockAudio().then((ready) => ready && playChime({ force: true }))}
                className="shrink-0 rounded-md border border-amber-300 px-2 py-1 font-medium hover:bg-amber-50 dark:border-amber-800 dark:hover:bg-amber-950"
              >
                {t('timer.enableSound')}
              </button>
            </div>
          )}
        </div>
      </div>,
      document.body,
        );

  // Idle without its own icon: only the popover, opened from the header's «⋯» and placed under it.
  if (!timer && !idleTrigger) return popover || null;

  return (
    <div className={`relative shrink-0 ${timer ? '' : idleClassName ?? ''}`} data-page-timer="">
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        title={timer ? label : pageId ? t('timer.buttonTitle') : t('timer.buttonTitleSpace')}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => {
          void unlockAudio();
          setOpen(!open);
        }}
        className={
          timer
            ? `inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium tabular-nums max-md:min-h-10 ${pillTone}`
            : HEADER_ICON_BUTTON
        }
      >
        {timer ? (
          <>
            {audioLocked && !muted && phase !== 'finished' ? <VolumeX size={12} aria-hidden="true" /> : <Timer size={12} aria-hidden="true" className="max-sm:hidden" />}
            <span role="timer">{clock}</span>
          </>
        ) : (
          <Timer size={16} aria-hidden="true" />
        )}
      </button>

      {popover}
    </div>
  );
}

function TimerButton({ icon, disabled, onClick, children }: { icon?: React.ReactNode; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="inline-flex items-center gap-1 rounded-md border border-neutral-300 px-2.5 py-1.5 text-xs font-medium hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-600 dark:hover:bg-neutral-800"
    >
      {icon}
      {children}
    </button>
  );
}
