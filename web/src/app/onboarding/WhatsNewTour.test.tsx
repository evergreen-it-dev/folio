// @vitest-environment jsdom
/**
 * The one-time «we updated the design» hint: shows once, draws tags only for
 * anchors in the DOM, and «Got it» / Esc mark it seen.
 * jsdom has no layout, so anchors get a stubbed rect.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18next from 'i18next';
import { WhatsNewTour, openWhatsNewTour } from './WhatsNewTour';
import { WHATS_NEW_STORAGE_KEY } from './whatsNewSteps';
import '../i18n/register';

beforeAll(async () => {
  await i18next.changeLanguage('en');
});

function addAnchor(name: string) {
  const el = document.createElement('div');
  el.setAttribute('data-tour', name);
  el.getBoundingClientRect = () => ({ x: 20, y: 20, top: 20, left: 20, right: 120, bottom: 60, width: 100, height: 40, toJSON: () => ({}) }) as DOMRect;
  document.body.appendChild(el);
  return el;
}

function mount(client = new QueryClient()) {
  return render(
    <QueryClientProvider client={client}>
      <WhatsNewTour delayMs={0} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

const seen = () => window.localStorage.getItem(WHATS_NEW_STORAGE_KEY);

describe('WhatsNewTour', () => {
  it('shows once, tags only the anchors that exist, and «Got it» marks it seen', async () => {
    addAnchor('search');
    addAnchor('graph-links');
    const first = mount();
    expect(await screen.findByRole('dialog', { name: "We've refreshed the design" })).toBeTruthy();
    expect(await screen.findByText(/search is here now/)).toBeTruthy();
    expect(screen.getByText('graph, outline and TODO — here')).toBeTruthy();
    expect(screen.queryByText('properties — under the title')).toBeNull();
    expect(seen()).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(seen()).toBe('1');
    first.unmount();
    mount();
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Esc closes it and marks it seen', async () => {
    addAnchor('search');
    mount();
    await screen.findByRole('dialog');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(seen()).toBe('1');
  });

  it('with no anchors on screen lists the changes in the card', async () => {
    mount();
    expect(await screen.findByRole('button', { name: 'Got it' })).toBeTruthy();
    expect(screen.getByText('Nested pages')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
    expect(seen()).toBe('1');
  });

  it('stays hidden in demo mode, and can be reopened on purpose', async () => {
    addAnchor('search');
    window.localStorage.setItem(WHATS_NEW_STORAGE_KEY, '1');
    const client = new QueryClient();
    client.setQueryData(['auth', 'state'], { demo: { resetHours: 1 } });
    mount(client);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('dialog')).toBeNull();
    openWhatsNewTour();
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });
});
