import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useApiErrorText } from '../errorText';
import { mentionQueryAt, useMentionCandidates } from './mentionCandidates';
import '../i18n/register';

export interface CommentComposerProps {
  placeholder: string;
  submitLabel: string;
  initial?: string;
  autoFocus?: boolean;
  /** Resolves when the comment was saved; a rejection is shown under the field and keeps the text. */
  onSubmit(body: string): Promise<void>;
  onCancel(): void;
}

const KEY_HINT = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? navigator.userAgent) ? '⌘' : 'Ctrl';

/** A comment box: Ctrl/Cmd+Enter sends, Esc cancels. Used for a new thread, a reply and an edit. */
export function CommentComposer({ placeholder, submitLabel, initial = '', autoFocus = false, onSubmit, onCancel }: CommentComposerProps) {
  const { t } = useTranslation('app');
  const errorText = useApiErrorText();
  const [body, setBody] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const candidates = useMentionCandidates();
  const [caret, setCaret] = useState(0);
  const [pickIndex, setPickIndex] = useState(0);
  const [pickerOff, setPickerOff] = useState(false);
  const liveRef = useRef(true);
  useEffect(() => {
    liveRef.current = true;
    return () => {
      liveRef.current = false;
    };
  }, []);
  useEffect(() => {
    if (!autoFocus) return;
    const field = fieldRef.current;
    field?.focus();
    field?.setSelectionRange(field.value.length, field.value.length);
  }, [autoFocus]);

  const mention = pickerOff ? null : mentionQueryAt(body, caret);
  const suggestions = mention
    ? candidates.filter((c) => c.username.toLowerCase().startsWith(mention.query) || c.name.toLowerCase().includes(mention.query)).slice(0, 6)
    : [];
  const pick = (username: string) => {
    if (!mention) return;
    const next = `${body.slice(0, mention.start)}@${username} ${body.slice(caret)}`;
    const position = mention.start + username.length + 2;
    setBody(next);
    setCaret(position);
    setPickIndex(0);
    requestAnimationFrame(() => {
      fieldRef.current?.focus();
      fieldRef.current?.setSelectionRange(position, position);
    });
  };

  const trimmed = body.trim();
  const submit = async () => {
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(trimmed);
    } catch (err) {
      if (liveRef.current) setError(errorText(err, 'comments.saveFailed'));
    } finally {
      if (liveRef.current) setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <textarea
        ref={fieldRef}
        value={body}
        rows={3}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(event) => {
          setBody(event.target.value);
          setCaret(event.target.selectionStart ?? event.target.value.length);
          setPickIndex(0);
          setPickerOff(false);
        }}
        onSelect={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
        onKeyDown={(event) => {
          if (suggestions.length > 0) {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              setPickIndex((i) => (i + (event.key === 'ArrowDown' ? 1 : suggestions.length - 1)) % suggestions.length);
              return;
            }
            if ((event.key === 'Enter' && !event.metaKey && !event.ctrlKey) || event.key === 'Tab') {
              event.preventDefault();
              pick(suggestions[pickIndex % suggestions.length].username);
              return;
            }
            if (event.key === 'Escape') {
              // Closes the list, not the whole box.
              event.preventDefault();
              event.stopPropagation();
              setPickerOff(true);
              return;
            }
          }
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void submit();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
          }
        }}
        className="w-full resize-y rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-blue-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:placeholder:text-neutral-500"
      />
      {suggestions.length > 0 && (
        <ul role="listbox" aria-label={t('comments.mentionList')} className="max-h-40 overflow-y-auto rounded-md border border-neutral-200 bg-white p-1 text-sm shadow-sm dark:border-neutral-700 dark:bg-neutral-900">
          {suggestions.map((c, i) => (
            <li key={c.username} role="option" aria-selected={i === pickIndex % suggestions.length}>
              <button
                type="button"
                onMouseDown={(event) => {
                  event.preventDefault();
                  pick(c.username);
                }}
                className={`flex w-full items-baseline gap-2 rounded px-2 py-1 text-left ${i === pickIndex % suggestions.length ? 'bg-neutral-100 dark:bg-neutral-800' : ''}`}
              >
                <span className="font-medium text-blue-600 dark:text-blue-400">@{c.username}</span>
                <span className="truncate text-xs text-neutral-500 dark:text-neutral-400">{c.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-neutral-400 dark:text-neutral-500">{t('comments.hint', { key: KEY_HINT })}</span>
        <div className="flex gap-1.5">
          <button type="button" onClick={onCancel} className="rounded-md px-2.5 py-1 text-xs text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800">
            {t('ui.cancel')}
          </button>
          <button
            type="button"
            disabled={!trimmed || busy}
            onClick={() => void submit()}
            className="rounded-md bg-blue-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {busy ? t('ui.pleaseWait') : submitLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
