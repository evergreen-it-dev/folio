import { SpellCheck } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import { useAssistantUi } from '../assistant/AssistantHost';
import { useAssistantRun } from '../assistant/runState';
import { writingRulesCheckMessage, writingRulesLanguageName } from '../assistant/writingRulesPrompt';
import '../i18n/register';

export interface WritingRulesButtonProps {
  pageId: string;
  space: string;
  title: string;
}

/**
 * Header icon: "Check against writing rules". Runs the Folio AI assistant in read-only Ask mode on this page
 * and the space's writing rules (`.agent/writing-rules.md`); the findings appear in the assistant panel.
 *
 * Absent when the space has no writing rules (nothing to check against; admins create them from the `.agent`
 * section of the sidebar). Present but disabled, with the reason in its tooltip, while no Folio AI key works
 * for this space or another assistant run is in flight.
 */
export function WritingRulesButton(props: WritingRulesButtonProps) {
  const { data } = useQuery({ queryKey: ['spaces'], queryFn: api.listSpaces });
  const hasRules = data?.spaces.find((s) => s.slug === props.space)?.agentRules?.writingRules === true;
  // The assistant context (panel, run tracker) is only needed once there is a button to show.
  return hasRules ? <WritingRulesAction {...props} /> : null;
}

function WritingRulesAction({ pageId, space, title }: WritingRulesButtonProps) {
  const { t, i18n } = useTranslation('app');
  const assistant = useAssistantUi();
  const run = useAssistantRun();
  const settings = useQuery({ queryKey: ['assistant', 'settings', space], queryFn: () => api.getAssistantSettings(space) });

  const configured = Boolean(settings.data?.apiKeyConfigured && settings.data.runtimeAvailable);
  // While the settings are still loading the button stays enabled: a click is then answered by the panel itself.
  const unavailable = settings.isSuccess && !configured ? t('assistant.writingRules.noKey') : run.isRunning ? t('assistant.writingRules.busy') : null;
  const label = t('assistant.writingRules.action');

  function start() {
    if (unavailable) return;
    assistant.ask({
      message: writingRulesCheckMessage({ pageId, title, uiLanguage: writingRulesLanguageName(i18n.resolvedLanguage ?? i18n.language) }),
      // The chat shows this, not the instruction prompt above (which is what the model gets).
      displayMessage: t('assistant.writingRules.checkDisplay', { title }),
      runMode: 'ask',
      startNew: true,
      writingRulesCheck: { pageId, title },
    });
  }

  return (
    <button
      type="button"
      aria-label={label}
      aria-disabled={unavailable !== null}
      title={unavailable ? `${label} — ${unavailable}` : label}
      onClick={start}
      // max-md:min-h/w-10: touch-target floor (round 14), no-op at md+.
      className={`inline-flex shrink-0 items-center justify-center rounded-md p-1.5 max-md:min-h-10 max-md:min-w-10 ${
        unavailable ? 'cursor-not-allowed text-neutral-300 dark:text-neutral-600' : 'text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-300'
      }`}
    >
      <SpellCheck size={15} aria-hidden="true" />
    </button>
  );
}
