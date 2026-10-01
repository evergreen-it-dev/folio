import { Star } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { StarKind } from '../stars';
import { isStarred, useStars, useToggleStar } from '../stars';
import '../i18n/register';

export interface StarButtonProps {
  kind: StarKind;
  id: string;
}

/**
 * Star/unstar toggle — the page one lives in the header, the space one in
 * the sidebar next to SpaceSwitcher (round 8: two identical-looking stars
 * side by side in the header read as confusing even with distinct
 * aria-labels, since aria-label alone gives a sighted user nothing to go
 * on — see Header.tsx's docblock). `title` (a real hover tooltip, not just
 * the accessible name) is deliberate here for that same reason, on both of
 * the two remaining call sites.
 */
export function StarButton({ kind, id }: StarButtonProps) {
  const { t } = useTranslation('app');
  const { data: stars } = useStars();
  const toggle = useToggleStar();
  const starred = isStarred(stars, kind, id);
  const noun = t(`star.noun.${kind}`);
  const label = t(starred ? 'star.remove' : 'star.add', { noun });

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={starred}
      onClick={() => toggle.mutate({ kind, id, starred: !starred })}
      // max-md:min-h/w-10: touch-target floor (round 14) for this "main
      // button" — a no-op at md+, where the compact p-1.5 box is unchanged.
      className={`inline-flex shrink-0 items-center justify-center rounded-md p-1.5 hover:bg-neutral-100 max-md:min-h-10 max-md:min-w-10 dark:hover:bg-neutral-800 ${
        starred ? 'text-amber-500' : 'text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300'
      }`}
    >
      <Star size={15} className={starred ? 'fill-current' : undefined} aria-hidden="true" />
    </button>
  );
}
