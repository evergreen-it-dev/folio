/**
 * F-04, S3 backend: Folio never redirects to the bucket — getAsset reads the
 * object through the SDK and /a/... sends the bytes itself — so the same
 * headers apply. The SDK is replaced by an in-memory fake here; nothing
 * leaves the machine.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  objects: new Map<string, Buffer>(),
  puts: [] as Array<Record<string, unknown>>,
}));

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {
    async send(command: { kind: 'put' | 'get'; input: Record<string, unknown> }) {
      if (command.kind === 'put') {
        fake.puts.push(command.input);
        fake.objects.set(String(command.input.Key), Buffer.from(command.input.Body as Buffer));
        return {};
      }
      const bytes = fake.objects.get(String(command.input.Key));
      return bytes ? { Body: { transformToByteArray: async () => new Uint8Array(bytes) } } : {};
    }
  },
  PutObjectCommand: class {
    kind = 'put' as const;
    constructor(public input: Record<string, unknown>) {}
  },
  GetObjectCommand: class {
    kind = 'get' as const;
    constructor(public input: Record<string, unknown>) {}
  },
}));

import { registerAssetRoute } from './assetRoute.js';
import { putAsset } from './assets.js';
import { setUpTestSchema } from './db/testSchema.js';
import { HttpError } from './errors.js';

const SANDBOX_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox";

describe('assets on the S3 backend (fake SDK)', () => {
  let teardownSchema: () => Promise<void>;
  let app: FastifyInstance;
  const saved = { backend: process.env.ASSET_BACKEND, bucket: process.env.S3_BUCKET };

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    process.env.ASSET_BACKEND = 's3';
    process.env.S3_BUCKET = 'folio-test-bucket';
    app = Fastify();
    app.setErrorHandler((err, _request, reply) => {
      if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
      return reply.status(500).send({ error: String(err) });
    });
    registerAssetRoute(app);
    await app.ready();
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    if (saved.backend === undefined) delete process.env.ASSET_BACKEND;
    else process.env.ASSET_BACKEND = saved.backend;
    if (saved.bucket === undefined) delete process.env.S3_BUCKET;
    else process.env.S3_BUCKET = saved.bucket;
    await teardownSchema();
  });

  it('serves an SVG from the bucket through the app with the sandbox policy, and stores it as a download', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg><!-- s3-svg -->');
    const stored = await putAsset(svg, { mime: 'image/png', filename: 'chart.png' }, null);

    expect(fake.puts.at(-1)).toMatchObject({ Bucket: 'folio-test-bucket', Key: stored.sha256, ContentType: 'image/svg+xml', ContentDisposition: 'attachment' });

    const res = await app.inject({ method: 'GET', url: stored.url });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/svg+xml');
    expect(res.headers['content-security-policy']).toBe(SANDBOX_CSP);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.body).toBe(svg.toString('utf8'));
  });

  it('serves a PNG from the bucket inline and stores it with its real type and no forced download', async () => {
    const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('s3-png')]);
    const stored = await putAsset(png, { mime: 'application/octet-stream', filename: 'pixel.png' }, null);

    const put = fake.puts.at(-1)!;
    expect(put).toMatchObject({ Key: stored.sha256, ContentType: 'image/png' });
    expect(put.ContentDisposition).toBeUndefined();

    const res = await app.inject({ method: 'GET', url: stored.url });
    expect(res.headers['content-type']).toBe('image/png');
    expect(String(res.headers['content-disposition'])).toMatch(/^inline;/);
    expect(res.headers['content-security-policy']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});
