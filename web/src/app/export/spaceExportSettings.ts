/**
 * R23 tail (headers and footers) — network side of the space-level PDF header/footer
 * editor. Its own plain-fetch module (same reasoning as ./pageExport.ts):
 * app/api.ts is frozen for this round, and these two calls mirror the two
 * request() behaviors that matter — a 401 re-dispatches UNAUTHORIZED_EVENT,
 * and every non-2xx becomes an ApiError carrying the server's own message.
 */
import { ApiError, UNAUTHORIZED_EVENT } from '../api';

export interface SpaceExportSettingsPayload {
  headerHtml?: string;
  footerHtml?: string;
}

/** The five placeholders server/export/css.ts substitutes — the dialog's hint renders exactly these. */
export const EXPORT_PLACEHOLDERS = ['{{page}}', '{{pages}}', '{{title}}', '{{space}}', '{{date}}'] as const;

async function handle(res: Response): Promise<SpaceExportSettingsPayload> {
  if (!res.ok) {
    let message = res.statusText || `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) message = body.error;
    } catch {
      // not JSON — keep the status fallback
    }
    if (res.status === 401) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    throw new ApiError(res.status, message);
  }
  return (await res.json()) as SpaceExportSettingsPayload;
}

export async function getSpaceExportSettings(space: string): Promise<SpaceExportSettingsPayload> {
  return handle(await fetch(`/api/spaces/${encodeURIComponent(space)}/export-settings`));
}

export async function putSpaceExportSettings(space: string, settings: SpaceExportSettingsPayload): Promise<SpaceExportSettingsPayload> {
  return handle(
    await fetch(`/api/spaces/${encodeURIComponent(space)}/export-settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    }),
  );
}
