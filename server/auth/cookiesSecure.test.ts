import { afterEach, describe, expect, it } from 'vitest';
import { cookiesSecure } from './session.js';

describe('auth/session cookiesSecure (pure, env only)', () => {
  const saved = { NODE_ENV: process.env.NODE_ENV, PUBLIC_URL: process.env.PUBLIC_URL };

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  function withEnv(nodeEnv: string | undefined, publicUrl: string | undefined): boolean {
    if (nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = nodeEnv;
    if (publicUrl === undefined) delete process.env.PUBLIC_URL;
    else process.env.PUBLIC_URL = publicUrl;
    return cookiesSecure();
  }

  it('is off outside production', () => {
    expect(withEnv('development', 'https://folio.example.com')).toBe(false);
  });

  it('is on in production for an https or scheme-less PUBLIC_URL, and when PUBLIC_URL is unset', () => {
    expect(withEnv('production', 'https://folio.example.com')).toBe(true);
    expect(withEnv('production', 'folio.example.com')).toBe(true);
    expect(withEnv('production', undefined)).toBe(true);
  });

  it('is off in production when the operator configured plain http', () => {
    expect(withEnv('production', 'http://192.168.1.20:4870')).toBe(false);
    expect(withEnv('production', 'localhost:4870')).toBe(false);
  });
});
