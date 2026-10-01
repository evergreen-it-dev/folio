import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { PageMeta } from '@shared/contracts';
import './i18n/register';

export interface BacklinksProps {
  pageId: string;
}

async function fetchBacklinks(pageId: string): Promise<{ backlinks: PageMeta[] }> {
  const res = await fetch(`/api/pages/${encodeURIComponent(pageId)}/backlinks`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<{ backlinks: PageMeta[] }>;
}

/**
 * Backlinks (`t('backlinks.title')` — this zone's own `markdown` i18n
 * namespace, see i18n/register.ts) — pages that link to this one, at the
 * bottom of the reading view. A plain fetch rather than app/api.ts
 * deliberately: markdown/ stays a standalone module the editor's reading
 * mode can import without pulling in app/'s module graph (same reasoning as
 * index.tsx's own resolve-on-click fetch). Hides itself entirely on any
 * error or an empty result — supplementary information, never worth its own
 * error state.
 */
export function Backlinks({ pageId }: BacklinksProps) {
  const navigate = useNavigate();
  const { t } = useTranslation('markdown');
  const { data, isError } = useQuery({
    queryKey: ['backlinks', pageId],
    queryFn: () => fetchBacklinks(pageId),
    retry: false,
  });

  const backlinks = data?.backlinks ?? [];
  if (isError || backlinks.length === 0) return null;

  return (
    <div className="folio-backlinks">
      <div className="folio-backlinks-title">{t('backlinks.title')}</div>
      <ul>
        {backlinks.map((page) => (
          <li key={page.id}>
            <button type="button" onClick={() => navigate(`/s/${page.space}/p/${page.id}`)}>
              {page.title}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
