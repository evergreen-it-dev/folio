import { describe, expect, it } from 'vitest';
import { substituteTemplate, todayDateStamp } from './template';

const vars = { date: '2026-08-20', author: 'Ivan Petrov', title: 'New page' };

describe('substituteTemplate', () => {
  it('replaces all three known placeholders', () => {
    const md = '# {{title}}\n\nCreated on {{date}} by {{author}}.\n';
    expect(substituteTemplate(md, vars)).toBe('# New page\n\nCreated on 2026-08-20 by Ivan Petrov.\n');
  });

  it('replaces repeated occurrences of the same placeholder', () => {
    expect(substituteTemplate('{{date}} / {{date}}', vars)).toBe('2026-08-20 / 2026-08-20');
  });

  it('tolerates whitespace inside the braces', () => {
    expect(substituteTemplate('{{ date }}', vars)).toBe('2026-08-20');
  });

  it('leaves unrecognized {{...}} placeholders untouched', () => {
    expect(substituteTemplate('{{unknown}}', vars)).toBe('{{unknown}}');
  });

  it('leaves markdown without placeholders unchanged', () => {
    const md = '# Plain heading\n\nNo placeholders here.\n';
    expect(substituteTemplate(md, vars)).toBe(md);
  });
});

describe('todayDateStamp', () => {
  it('formats as YYYY-MM-DD, zero-padded', () => {
    expect(todayDateStamp(new Date(2026, 0, 5))).toBe('2026-01-05'); // January (0-indexed month) 5th
  });

  it('uses local date fields, not a UTC-shifted ISO string', () => {
    // 23:30 local time should still stamp as the *local* day, not roll over
    // to the next day the way toISOString() (UTC) would for timezones behind UTC.
    const lateLocal = new Date(2026, 5, 15, 23, 30);
    expect(todayDateStamp(lateLocal)).toBe('2026-06-15');
  });
});
