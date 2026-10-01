/** HTTP-aware error. Thrown from storage/collab/route code; caught centrally in index.ts. */
export class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

export const notFound = (what: string) => new HttpError(404, `${what} not found`);
export const badRequest = (message: string) => new HttpError(400, message);
export const conflict = (message: string) => new HttpError(409, message);
export const unauthorized = (message = 'authentication required') => new HttpError(401, message);
export const forbidden = (message = 'insufficient role') => new HttpError(403, message);
/** Round 9: an invite that's unknown/expired/revoked/exhausted — the token URL "used to work". */
export const gone = (message: string) => new HttpError(410, message);
export const tooManyRequests = (message: string) => new HttpError(429, message);
