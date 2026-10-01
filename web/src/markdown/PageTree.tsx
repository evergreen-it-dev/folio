import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import './i18n/register';

export interface PageTreeProps {
  /** The page whose OWN children to list — not a page to navigate into. */
  pageId: string;
  /** How many levels deep to recurse, 1..5 (server clamps too; see pagetreeSplit.ts's parsePagetreeDepth for the same range used when parsing the directive's attribute). */
  depth: number;
}

interface SubtreeNode {
  id: string;
  space: string;
  path: string;
  title: string;
  icon?: string;
  children: SubtreeNode[];
}

type LoadState = { status: 'loading' } | { status: 'ok'; nodes: SubtreeNode[] } | { status: 'empty' };

/**
 * Round 13: renders GET /api/pages/:id/subtree?depth=N as an indented list
 * of links, respecting each node's icon. Used both by the reading pipeline
 * (the `::pagetree{depth=N}` directive — see pagetreeSplit.ts, wired in via
 * this module's index.tsx re-export) and by EDITOR's live block-widget
 * (imports this same component directly — coordinate the export name/path
 * with them: `PageTree` from `web/src/markdown` — see this file's own
 * report note on the app/sidebar/PageTree.tsx naming echo, which is a
 * different component in a different module, not a collision).
 *
 * A plain fetch, not react-query: this has to work wherever it's mounted,
 * including inside a CodeMirror block widget that may not have an ambient
 * QueryClientProvider — matching this module's own established precedent
 * (index.tsx's relative-link click handler already uses a raw fetch for the
 * exact same reason, rather than importing app/'s api client).
 */
export function PageTree({ pageId, depth }: PageTreeProps) {
  const { t } = useTranslation('markdown');
  const navigate = useNavigate();
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    fetch(`/api/pages/${encodeURIComponent(pageId)}/subtree?depth=${encodeURIComponent(String(depth))}`)
      .then((res) => {
        if (!res.ok) throw new Error(`subtree ${res.status}`);
        return res.json() as Promise<{ children?: SubtreeNode[] }>;
      })
      .then((data) => {
        if (cancelled) return;
        const nodes = data.children ?? [];
        setState(nodes.length > 0 ? { status: 'ok', nodes } : { status: 'empty' });
      })
      .catch(() => {
        // Any failure degrades to the same "nothing to show" state and
        // never throws: 404 (endpoint not live yet), 401/403 (e.g. an
        // anonymous share guest — a page's subtree isn't exposed there),
        // a genuinely empty subtree, or a network error all look the same
        // from here — there is nothing useful to show any of them.
        if (!cancelled) setState({ status: 'empty' });
      });
    return () => {
      cancelled = true;
    };
  }, [pageId, depth]);

  if (state.status === 'loading') {
    return <p className="text-sm text-neutral-400 dark:text-neutral-500">{t('pagetree.loading')}</p>;
  }
  if (state.status === 'empty') {
    return <p className="text-sm text-neutral-400 dark:text-neutral-500">{t('pagetree.empty')}</p>;
  }

  return (
    <PageTreeLevel
      nodes={state.nodes}
      onNavigate={(href) => {
        navigate(href);
      }}
    />
  );
}

function PageTreeLevel({ nodes, onNavigate }: { nodes: SubtreeNode[]; onNavigate: (href: string) => void }) {
  return (
    <ul className="m-0 list-none pl-4 first:pl-0">
      {nodes.map((node) => {
        const href = `/s/${node.space}/p/${node.id}`;
        return (
          <li key={node.id} className="my-1">
            <a
              href={href}
              onClick={(event) => {
                event.preventDefault();
                onNavigate(href);
              }}
              className="text-blue-600 no-underline hover:underline dark:text-blue-400"
            >
              {node.icon && <span aria-hidden="true">{node.icon} </span>}
              {node.title}
            </a>
            {node.children.length > 0 && <PageTreeLevel nodes={node.children} onNavigate={onNavigate} />}
          </li>
        );
      })}
    </ul>
  );
}
