/**
 * AssetStore (round 3b): content-addressed binary storage, separate from
 * git. Metadata always lives in PG's `assets` table regardless of backend;
 * only the bytes move between backends. Local is the default; s3 is
 * env-switched (ASSET_BACKEND=s3) and used the same way. MVP reads/writes
 * whole buffers (not streamed) — fine at wiki-attachment sizes, matches how
 * the round-1 upload route already worked (multipart's own toBuffer()).
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query, queryOne } from './db/pool.js';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCAL_ASSETS_DIR = path.join(APP_ROOT, 'data', 'assets');

function backendName(): 'local' | 's3' {
  return process.env.ASSET_BACKEND === 's3' ? 's3' : 'local';
}

// --- local backend -----------------------------------------------------

function localPathFor(sha256: string): string {
  return path.join(LOCAL_ASSETS_DIR, sha256.slice(0, 2), sha256);
}
async function localPut(sha256: string, data: Buffer): Promise<void> {
  const file = localPathFor(sha256);
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    await fs.access(file);
  } catch {
    await fs.writeFile(file, data); // content-addressed: identical bytes already there, nothing to do
  }
}
async function localRead(sha256: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(localPathFor(sha256));
  } catch {
    return null;
  }
}

// --- s3 backend ----------------------------------------------------------

let s3ClientPromise: Promise<import('@aws-sdk/client-s3').S3Client> | null = null;
async function getS3Client(): Promise<import('@aws-sdk/client-s3').S3Client> {
  if (!s3ClientPromise) {
    s3ClientPromise = import('@aws-sdk/client-s3').then(
      ({ S3Client }) =>
        new S3Client({
          endpoint: process.env.S3_ENDPOINT,
          region: process.env.S3_REGION || 'us-east-1',
          forcePathStyle: true,
          credentials:
            process.env.S3_ACCESS_KEY && process.env.S3_SECRET_KEY
              ? { accessKeyId: process.env.S3_ACCESS_KEY, secretAccessKey: process.env.S3_SECRET_KEY }
              : undefined,
        }),
    );
  }
  return s3ClientPromise;
}
function s3Bucket(): string {
  const bucket = process.env.S3_BUCKET;
  if (!bucket) throw new Error('S3_BUCKET is not set (required when ASSET_BACKEND=s3)');
  return bucket;
}
async function s3Put(sha256: string, data: Buffer, mime: string): Promise<void> {
  const { PutObjectCommand } = await import('@aws-sdk/client-s3');
  const client = await getS3Client();
  await client.send(new PutObjectCommand({ Bucket: s3Bucket(), Key: sha256, Body: data, ContentType: mime }));
}
async function s3Read(sha256: string): Promise<Buffer | null> {
  try {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const client = await getS3Client();
    const res = await client.send(new GetObjectCommand({ Bucket: s3Bucket(), Key: sha256 }));
    if (!res.Body) return null;
    const bytes = await res.Body.transformToByteArray();
    return Buffer.from(bytes);
  } catch {
    return null;
  }
}

// --- public API ------------------------------------------------------------

export interface StoredAsset {
  sha256: string;
  size: number;
  url: string;
}

function sanitizeUrlFilename(name: string): string {
  const base = name.replace(/[\\/:*?"<>|]/g, '').trim();
  return encodeURIComponent(base || 'asset');
}

export async function putAsset(data: Buffer, meta: { mime: string; filename: string }, createdBy: string | null): Promise<StoredAsset> {
  const sha256 = createHash('sha256').update(data).digest('hex');
  if (backendName() === 's3') await s3Put(sha256, data, meta.mime);
  else await localPut(sha256, data);

  await query(
    `INSERT INTO assets (sha256, mime, size, filename, created_by) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (sha256) DO NOTHING`,
    [sha256, meta.mime, data.length, meta.filename, createdBy],
  );
  return { sha256, size: data.length, url: `/a/${sha256}/${sanitizeUrlFilename(meta.filename)}` };
}

export interface LoadedAsset {
  data: Buffer;
  mime: string;
  filename: string;
}

export async function getAsset(sha256: string): Promise<LoadedAsset | null> {
  if (!/^[0-9a-f]{64}$/.test(sha256)) return null;
  const row = await queryOne<{ mime: string; filename: string }>('SELECT mime, filename FROM assets WHERE sha256 = $1', [sha256]);
  if (!row) return null;
  const data = backendName() === 's3' ? await s3Read(sha256) : await localRead(sha256);
  if (!data) return null;
  return { data, mime: row.mime, filename: row.filename };
}
