import type { SpaceImportPhase, SpaceImportProgress } from '../shared/contracts.js';

interface StoredProgress extends SpaceImportProgress {
  userId: string;
  startedAt: number;
  touchedAt: number;
}

const jobs = new Map<string, StoredProgress>();
const RETAIN_MS = 15 * 60_000;

function prune(now = Date.now()) {
  for (const [id, job] of jobs) if (now - job.touchedAt > RETAIN_MS) jobs.delete(id);
}

export function startSpaceImport(id: string, userId: string): void {
  const now = Date.now();
  prune(now);
  jobs.set(id, {
    id,
    userId,
    startedAt: now,
    touchedAt: now,
    phase: 'preparing',
    percent: 1,
    processedFiles: 0,
    totalFiles: 0,
    elapsedMs: 0,
    done: false,
  });
}

export function updateSpaceImport(
  id: string,
  patch: Partial<Pick<SpaceImportProgress, 'phase' | 'percent' | 'processedFiles' | 'totalFiles' | 'done' | 'error'>>,
): void {
  const job = jobs.get(id);
  if (!job) return;
  const now = Date.now();
  Object.assign(job, patch, {
    percent: Math.max(job.percent, Math.min(100, Math.round(patch.percent ?? job.percent))),
    touchedAt: now,
    elapsedMs: now - job.startedAt,
  });
}

export function phaseSpaceImport(id: string, phase: SpaceImportPhase, percent: number): void {
  updateSpaceImport(id, { phase, percent });
}

export function getSpaceImport(id: string, userId: string): SpaceImportProgress | undefined {
  prune();
  const job = jobs.get(id);
  if (!job || job.userId !== userId) return undefined;
  const { userId: _userId, startedAt, touchedAt: _touchedAt, ...progress } = job;
  return { ...progress, elapsedMs: Date.now() - startedAt };
}

export function failSpaceImport(id: string, error: string): void {
  updateSpaceImport(id, { phase: 'error', done: true, error });
}

export function finishSpaceImport(id: string): void {
  updateSpaceImport(id, { phase: 'done', percent: 100, done: true });
}
