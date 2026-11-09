import { useEffect } from 'react';
import { useInRouterContext, useSearchParams } from 'react-router';

/**
 * Reads the ?thread=<id> a notification links to, hands it on once `enabled`
 * (the list and the page's own data are in) and drops it from the address. A separate
 * component because it needs the router: a board can be rendered outside one.
 */
export function ThreadLink(props: { enabled: boolean; onThread(id: string): void }) {
  return useInRouterContext() ? <RoutedThreadLink {...props} /> : null;
}

function RoutedThreadLink({ enabled, onThread }: { enabled: boolean; onThread(id: string): void }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const wanted = searchParams.get('thread');
  useEffect(() => {
    if (!wanted || !enabled) return;
    onThread(wanted);
    const next = new URLSearchParams(searchParams);
    next.delete('thread');
    setSearchParams(next, { replace: true });
  }, [wanted, enabled, onThread, searchParams, setSearchParams]);
  return null;
}
