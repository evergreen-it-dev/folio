import { useParams } from 'react-router';
import { PageContent } from './PageContent';
import { NotFound } from './NotFound';

/** `/s/:space/p/:id` — the route param supplies the id directly. */
export function PageView() {
  const { id } = useParams<{ id: string }>();
  if (!id) return <NotFound />;
  return <PageContent id={id} />;
}
