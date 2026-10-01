/**
 * QA-3 P2: a 400 from parseBody used to be zod's message ALONE — "Invalid
 * input: expected string, received undefined" — with no indication of WHICH
 * field was wrong. Identical text for a missing `name` on POST /api/spaces
 * and a missing `title` on POST /api/pages, so a client (or an MCP agent,
 * which has no form to look at) couldn't act on it. The field path now leads
 * the message.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { HttpError } from './errors.js';
import { issueMessage, issuePath, parseBody, queryString } from './validate.js';

/** The thrown HttpError's message, or a marker if the call unexpectedly succeeded. */
function messageFor(schema: { parse: (v: unknown) => unknown }, body: unknown): string {
  try {
    parseBody(schema, body);
    return '(no error thrown)';
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(400);
    return (err as HttpError).message;
  }
}

describe('validate.parseBody — the 400 message names the field', () => {
  it('names a missing top-level field', () => {
    const schema = z.object({ name: z.string(), repoUrl: z.string().optional() });
    const message = messageFor(schema, {});
    expect(message).toMatch(/^name: /);
    expect(message).toContain('expected string');
  });

  it('distinguishes two different missing fields that zod words identically', () => {
    const schema = z.object({ space: z.string(), title: z.string() });
    expect(messageFor(schema, { title: 'x' })).toMatch(/^space: /);
    expect(messageFor(schema, { space: 'x' })).toMatch(/^title: /);
  });

  it('uses bracketed indices for array elements, so a bad row in a bulk body is findable', () => {
    const schema = z.object({ changes: z.array(z.object({ userId: z.string(), role: z.enum(['viewer', 'editor', 'admin']) })) });
    const message = messageFor(schema, { changes: [{ userId: 'u1', role: 'admin' }, { userId: 'u2', role: 'owner' }] });
    expect(message).toMatch(/^changes\[1\]\.role: /);
  });

  it('keeps a custom message (regex/refine) and prefixes it with the path', () => {
    const schema = z.object({ slug: z.string().regex(/^[a-z-]+$/, 'slug must be lowercase letters and hyphens') });
    expect(messageFor(schema, { slug: 'Not A Slug' })).toBe('slug: slug must be lowercase letters and hyphens');
  });

  it('falls back to a generic message when the failure has no path at all (a non-object body)', () => {
    const schema = z.object({ name: z.string() });
    const message = messageFor(schema, 'not an object');
    expect(message).not.toMatch(/^: /); // never a dangling separator
    expect(message.length).toBeGreaterThan(0);
  });

  it('rethrows anything that is not a ZodError untouched', () => {
    const boom = new Error('not zod');
    expect(() => parseBody({ parse: () => { throw boom; } }, {})).toThrow(boom);
  });
});

describe('validate helpers', () => {
  it('issuePath joins object keys with dots and array indices with brackets', () => {
    expect(issuePath(['name'])).toBe('name');
    expect(issuePath(['memberships', 2, 'role'])).toBe('memberships[2].role');
    expect(issuePath([0, 'space'])).toBe('[0].space');
    expect(issuePath([])).toBe('');
    expect(issuePath(undefined)).toBe('');
  });

  it('issueMessage handles a missing issue and an empty path', () => {
    expect(issueMessage(undefined)).toBe('invalid request body');
    expect(issueMessage({ message: 'bad body', path: [] })).toBe('bad body');
    expect(issueMessage({ message: 'bad', path: ['a', 'b'] })).toBe('a.b: bad');
  });

  it('queryString returns only real strings', () => {
    expect(queryString({ q: 'hello' }, 'q')).toBe('hello');
    expect(queryString({ q: 5 }, 'q')).toBe('');
    expect(queryString(null, 'q')).toBe('');
  });
});
