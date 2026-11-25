// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import shell from '../../index.html?raw';
import reader from '../../offline.html?raw';
import { SettingsProvider, useSettings } from './settings';

function ThemePicker() {
  const { setTheme } = useSettings();
  return <>{(['light', 'dark', 'system'] as const).map(mode =>
    <button key={mode} onClick={() => setTheme(mode)}>{mode}</button>)}</>;
}

function titleColor(os: 'light' | 'dark') {
  return [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')]
    .find(meta => {
      const media = meta.getAttribute('media');
      return !media || media === 'all' || media === `(prefers-color-scheme: ${os})`;
    })?.content;
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  document.head.replaceChildren();
});

it.each([['shell', shell], ['offline reader', reader]])('%s follows the OS before scripts run', (_entry, html) => {
  document.head.innerHTML = new DOMParser().parseFromString(html, 'text/html').head.innerHTML;
  expect(titleColor('dark')).toBe('#0a0a0a');
  expect(titleColor('light')).toBe('#ffffff');
});

it('applies the saved theme to the title bar and releases the override in system mode', () => {
  document.head.innerHTML = new DOMParser().parseFromString(shell, 'text/html').head.innerHTML;
  localStorage.setItem('folio:theme', JSON.stringify('dark'));
  render(<SettingsProvider><ThemePicker /></SettingsProvider>);
  expect(titleColor('light')).toBe('#0a0a0a');
  fireEvent.click(screen.getByText('light'));
  expect(titleColor('dark')).toBe('#ffffff');
  fireEvent.click(screen.getByText('system'));
  expect(titleColor('light')).toBe('#ffffff');
  expect(titleColor('dark')).toBe('#0a0a0a');
});
