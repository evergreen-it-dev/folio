import type { FastifyReply, FastifyRequest } from 'fastify';
import { OFFLINE_READER_ACCOUNT_HEADER } from '../../shared/contracts.js';
import { conflict } from '../errors.js';

/** The header is a precondition for keeping a local copy. The route still enforces its usual page permissions. */
export async function bindOfflineReaderAccount(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const expected = request.headers[OFFLINE_READER_ACCOUNT_HEADER];
  if (expected === undefined) return;
  reply.header('Cache-Control', 'private, no-store');
  if (expected !== request.authUser?.id) throw conflict('The account for offline reading has changed.');
  reply.header(OFFLINE_READER_ACCOUNT_HEADER, expected);
}
