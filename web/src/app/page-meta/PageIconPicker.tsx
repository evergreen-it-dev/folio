import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Smile } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { EmojiPicker } from '../../emoji';
import { api } from '../api';
import { useApiErrorText } from '../errorText';
import { Menu } from '../ui/Menu';
import { useToast } from '../ui/Toast';

export function PageIconPicker({ pageId, space, icon }: { pageId: string; space: string; icon?: string }) {
  const { t } = useTranslation('app');
  const queryClient = useQueryClient();
  const showToast = useToast();
  const errorText = useApiErrorText();
  const [optimistic, setOptimistic] = useState<string | null | undefined>();
  useEffect(() => setOptimistic(undefined), [pageId, icon]);
  const display = optimistic !== undefined ? (optimistic ?? undefined) : icon;

  const save = useMutation({
    mutationFn: (next: string | null) => api.updatePage(pageId, { icon: next }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['page', pageId] });
      queryClient.invalidateQueries({ queryKey: ['tree', space] });
    },
    onError: (err) => {
      setOptimistic(undefined);
      showToast(errorText(err, 'pageChrome.saveFailed'));
    },
  });

  return (
    <Menu
      className="shrink-0"
      triggerLabel={t('pageChrome.icon')}
      trigger={display ? <span className="text-base leading-none">{display}</span> : <Smile size={15} aria-hidden="true" />}
    >
      {(close) => (
        <EmojiPicker
          value={display}
          onPick={(emoji) => {
            setOptimistic(emoji);
            save.mutate(emoji);
            close();
          }}
          onClear={() => {
            setOptimistic(null);
            save.mutate(null);
            close();
          }}
          onClose={close}
          onFavoritesError={() => showToast(t('pageChrome.favoritesFailed'))}
        />
      )}
    </Menu>
  );
}
