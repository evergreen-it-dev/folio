import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { bindOfflineReaderAccount } from './offlineReader.js';
import { OFFLINE_READER_ACCOUNT_HEADER } from '../../shared/contracts.js';
import { HttpError } from '../errors.js';

describe('document reads for the offline reader', () => {
  it('binds an explicit offline read to the authenticated session and leaves ordinary responses alone', async () => {
    const app = Fastify();
    app.addHook('onRequest', async (request) => { request.authUser = { id: 'reader' } as NonNullable<typeof request.authUser>; });
    app.setErrorHandler((error, _, reply) => reply.status(error instanceof HttpError ? error.status : 500).send());
    app.get('/page', { preHandler: bindOfflineReaderAccount }, async () => 'document');
    try {
      const read = (account?: string) => app.inject({ url: '/page', headers: account ? { [OFFLINE_READER_ACCOUNT_HEADER]: account } : {} });
      const ordinary = await read();
      expect(ordinary.statusCode).toBe(200);
      expect(ordinary.headers[OFFLINE_READER_ACCOUNT_HEADER]).toBeUndefined();
      const pinned = await read('reader');
      expect(pinned.headers[OFFLINE_READER_ACCOUNT_HEADER]).toBe('reader');
      expect(pinned.headers['cache-control']).toBe('private, no-store');
      const changed = await read('previous-reader');
      expect(changed.statusCode).toBe(409);
      expect(changed.body).not.toContain('document');
    } finally {
      await app.close();
    }
  });
});
