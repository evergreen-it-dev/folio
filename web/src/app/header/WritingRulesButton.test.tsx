// @vitest-environment jsdom
/**
 * "Check against writing rules" (page header): absent without writing rules, disabled with a reason when no
 * Folio AI key works or a run is in flight, otherwise it asks the assistant for a read-only check of this page.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18next from 'i18next';
import { WritingRulesButton } from './WritingRulesButton';
import { writingRulesCheckMessage, writingRulesFixMessage, writingRulesLanguageName } from '../assistant/writingRulesPrompt';
import '../i18n/register';

const ask = vi.fn();
let running = false;

vi.mock('../assistant/AssistantHost', () => ({ useAssistantUi: () => ({ open: false, setOpen: () => {}, toggle: () => {}, ask }) }));
vi.mock('../assistant/runState', () => ({ useAssistantRun: () => ({ isRunning: running }) }));

beforeAll(async () => {
  await i18next.changeLanguage('en');
});

afterEach(() => {
  cleanup();
  ask.mockReset();
  running = false;
});

function renderButton({ writingRules, keyConfigured }: { writingRules: boolean; keyConfigured: boolean }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  queryClient.setQueryData(['spaces'], { spaces: [{ slug: 'team', name: 'Team', agentRules: { used: true, pages: 1, ...(writingRules ? { writingRules: true } : {}) } }] });
  queryClient.setQueryData(['assistant', 'settings', 'team'], { apiKeyConfigured: keyConfigured, runtimeAvailable: true });
  render(
    <QueryClientProvider client={queryClient}>
      <WritingRulesButton pageId="page-1" space="team" title="Launch plan" />
    </QueryClientProvider>,
  );
}

describe('WritingRulesButton', () => {
  it('is not shown when the space has no writing rules', () => {
    renderButton({ writingRules: false, keyConfigured: true });
    expect(screen.queryByRole('button', { name: 'Check against writing rules' })).toBeNull();
  });

  it('is disabled with the reason when no AI key is configured', () => {
    renderButton({ writingRules: true, keyConfigured: false });
    const button = screen.getByRole('button', { name: 'Check against writing rules' });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.getAttribute('title')).toContain('isn’t set up yet');
    fireEvent.click(button);
    expect(ask).not.toHaveBeenCalled();
  });

  it('is disabled while another assistant run is in flight', () => {
    running = true;
    renderButton({ writingRules: true, keyConfigured: true });
    const button = screen.getByRole('button', { name: 'Check against writing rules' });
    expect(button.getAttribute('title')).toContain('busy');
    fireEvent.click(button);
    expect(ask).not.toHaveBeenCalled();
  });

  it('asks the assistant, in Ask mode and a fresh conversation, to check this page', () => {
    renderButton({ writingRules: true, keyConfigured: true });
    fireEvent.click(screen.getByRole('button', { name: 'Check against writing rules' }));
    expect(ask).toHaveBeenCalledTimes(1);
    const request = ask.mock.calls[0][0];
    expect(request).toMatchObject({ runMode: 'ask', startNew: true, writingRulesCheck: { pageId: 'page-1', title: 'Launch plan' } });
    expect(request.message).toContain('check_page_writing_rules');
    expect(request.message).toContain('page-1');
    expect(request.message).toContain('in English');
    // The chat shows a short label, never the instruction prompt (the model still gets `message`).
    expect(request.displayMessage).toBe('Check against writing rules: Launch plan');
    expect(request.displayMessage).not.toContain('page-1');
    expect(request.displayMessage).not.toContain('check_page_writing_rules');
  });

  it('follows the interface language: Ukrainian label and a prompt that asks for a Ukrainian answer', async () => {
    await i18next.changeLanguage('uk');
    try {
      renderButton({ writingRules: true, keyConfigured: true });
      fireEvent.click(screen.getByRole('button', { name: 'Перевірити за правилами письма' }));
      const request = ask.mock.calls[0][0];
      expect(request.displayMessage).toBe('Перевірка за правилами письма: Launch plan');
      expect(request.message).toContain('in Ukrainian');
      expect(request.message).not.toContain('in English');
    } finally {
      await i18next.changeLanguage('en');
    }
  });
});

describe('writing-rules messages', () => {
  it('the check is read-only and fixes the answer format; the fix message edits only the quoted fragments', () => {
    const check = writingRulesCheckMessage({ pageId: 'p', title: 'T', uiLanguage: 'Ukrainian' });
    expect(check).toContain('change nothing');
    expect(check).toContain('### <number>. <rule name>');
    expect(check).toContain('**Suggested rewrite:**');
    expect(check).toContain('Ukrainian');
    const fix = writingRulesFixMessage({ pageId: 'p', title: 'T' });
    expect(fix).toContain('only the quoted fragments');
    expect(writingRulesFixMessage({ pageId: 'p', title: 'T', uiLanguage: 'Ukrainian' })).toContain('what you changed, in Ukrainian.');
  });

  it('names the answer language from the interface language: Ukrainian for uk, English otherwise', () => {
    expect(writingRulesLanguageName('uk')).toBe('Ukrainian');
    expect(writingRulesLanguageName('uk-UA')).toBe('Ukrainian');
    expect(writingRulesLanguageName('en')).toBe('English');
    expect(writingRulesLanguageName('en-US')).toBe('English');
    expect(writingRulesLanguageName(undefined)).toBe('English');
  });
});
