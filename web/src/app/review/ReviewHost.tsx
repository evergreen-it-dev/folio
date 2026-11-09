import { useSearchParams } from 'react-router';
import { useSpaceRole } from '../auth/AuthProvider';
import { canEditContent } from '../auth/roles';
import { ReviewDialog } from './ReviewDialog';

/**
 * Opens the review dialog from the URL: `?review=<proposalId>` (a bell row, the page banner) or
 * `?review=all` (the sidebar entry). Closing drops the parameter, so the dialog is a link-able state
 * and the browser's Back button closes it.
 */
export function ReviewHost({ space }: { space: string }) {
  const [params, setParams] = useSearchParams();
  const role = useSpaceRole(space);
  const review = params.get('review');
  if (!review || !canEditContent(role)) return null;
  const close = () => {
    const next = new URLSearchParams(params);
    next.delete('review');
    setParams(next, { replace: true });
  };
  return <ReviewDialog space={space} proposalId={review === 'all' ? undefined : review} onClose={close} />;
}
