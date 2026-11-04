import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import { useDebouncedValue, useDocumentTitle } from '../hooks';
import '../i18n/register';

export interface PageGoneProps {
  /** The space of the address, when known: the way back to its start and the scope of the search. */
  space?: string;
}

/**
 * A page address that points at nothing (never a blank screen): the page was moved, renamed, deleted, or the
 * instance was reset since the link was made. Says so, offers a search of the space and the way back to its
 * start. Rights stay out of it: a 403 is NoAccess's job, and a thing that does not exist cannot be asked for.
 */
export function PageGone({ space }: PageGoneProps) {
  const { t } = useTranslation('app');
  useDocumentTitle(t('routes.notFound.title'));
  const [text, setText] = useState('');
  const q = useDebouncedValue(text.trim(), 250);
  const hits = useQuery({
    queryKey: ['page-gone-search', space ?? '', q],
    queryFn: () => api.search(q, space ?? '', { limit: 6 }),
    enabled: q.length > 0,
    retry: false,
  });
  return (
    <div role="status" className="flex h-full min-h-[60vh] flex-col items-center justify-center gap-3 p-8 text-center">
      <div className="text-5xl font-bold text-neutral-300 dark:text-neutral-700">404</div>
      <p className="text-base font-medium text-neutral-700 dark:text-neutral-200">{t('routes.page.gone.title')}</p>
      <p className="max-w-sm text-sm text-neutral-500 dark:text-neutral-400">{t('routes.page.notFound')}</p>
      <div className="flex w-full max-w-sm flex-col gap-2 text-left">
        <input
          type="search"
          value={text}
          onChange={(event) => setText(event.target.value)}
          aria-label={t('routes.page.gone.searchLabel')}
          placeholder={t('routes.page.gone.searchPlaceholder')}
          className="w-full rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
        />
        {q && hits.data && hits.data.hits.length === 0 && (
          <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('routes.page.gone.noResults')}</p>
        )}
        {hits.data && hits.data.hits.length > 0 && (
          <ul className="flex flex-col gap-1">
            {hits.data.hits.map((hit) => (
              <li key={hit.id}>
                <Link to={`/s/${encodeURIComponent(hit.space)}/p/${encodeURIComponent(hit.id)}`} className="text-sm text-blue-600 underline underline-offset-2 dark:text-blue-400">
                  {hit.title}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
      <Link to={space ? `/s/${encodeURIComponent(space)}` : '/'} className="text-sm text-blue-600 underline underline-offset-2 dark:text-blue-400">
        {space ? t('routes.page.gone.spaceHome', { space }) : t('admin.backHome')}
      </Link>
    </div>
  );
}
