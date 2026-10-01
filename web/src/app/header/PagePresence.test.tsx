// @vitest-environment jsdom
/**
 * Round (page presence) — component coverage for the header's presence
 * indicator. Driven directly against `PagePresenceIndicator` with plain
 * `PagePresencePerson[]` props (not the live awareness plumbing — that's
 * app/presence.ts's own job and is covered separately by presence.test.ts).
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import i18next from 'i18next';
import type { PagePresencePerson } from '../presence';
import { PagePresenceIndicator } from './PagePresence';
import '../i18n/register';

beforeAll(async () => {
  await i18next.changeLanguage('en');
});

afterEach(cleanup);

const ME: PagePresencePerson = { key: 'id:me', name: 'Zoe Me', color: '#1971c2', isSelf: true };
const ALICE: PagePresencePerson = { key: 'id:alice', name: 'Alice Anderson', username: 'alice', color: '#2f9e44', isSelf: false };

describe('PagePresenceIndicator', () => {
  it('renders nothing when only one person is present', () => {
    const { container } = render(<PagePresenceIndicator people={[ME]} />);
    expect(container.innerHTML).toBe('');
  });

  it('shows a "2" badge for two people, and the list opens with both names on hover/focus', async () => {
    render(<PagePresenceIndicator people={[ME, ALICE]} />);
    const trigger = screen.getByRole('button');
    expect(trigger.textContent).toBe('2');

    // Not shown until hovered/focused.
    expect(screen.queryByText('Alice Anderson')).toBeNull();

    fireEvent.mouseEnter(trigger.parentElement!);
    expect(screen.getByText('Alice Anderson')).toBeTruthy();
    expect(screen.getByText('Zoe Me')).toBeTruthy();
    expect(screen.getByText('@alice')).toBeTruthy();

    // Closing is deliberately delayed (CLOSE_GRACE_MS): the panel is portaled
    // to <body>, so the pointer travelling trigger -> panel leaves the trigger
    // first, and an instant close would make the list unreachable by mouse.
    fireEvent.mouseLeave(trigger.parentElement!);
    await waitFor(() => expect(screen.queryByText('Alice Anderson')).toBeNull());

    // Keyboard focus opens it too, independent of hover.
    fireEvent.focus(trigger);
    expect(screen.getByText('Alice Anderson')).toBeTruthy();
  });

  it('marks the local person as "you" and gives the trigger a full accessible name', () => {
    render(<PagePresenceIndicator people={[ME, ALICE]} />);
    const trigger = screen.getByRole('button');
    const label = trigger.getAttribute('aria-label') ?? '';
    expect(label).toContain('Zoe Me');
    expect(label).toContain('Alice Anderson');
    expect(label).toContain('you');

    fireEvent.mouseEnter(trigger.parentElement!);
    expect(screen.getAllByText((text) => text.includes('you')).length).toBeGreaterThan(0);
  });
});
