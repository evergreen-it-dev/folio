/**
 * Makes a language switch reach CodeMirror without remounting the editor.
 *
 * Decorations are cached by design — a StateField only recomputes on document
 * changes, and widgets keep their DOM while `eq()` says they are unchanged. So
 * a language switch has to (a) invalidate the fields via an effect and (b) make
 * the widgets that render text compare languages in `eq()`.
 */
import i18next from 'i18next';
import { StateEffect, type Extension } from '@codemirror/state';
import { ViewPlugin, type EditorView } from '@codemirror/view';
import { onLanguageChanged, t } from './i18n';

/** Dispatched on every language switch; cached fields rebuild when they see it. */
export const languageChangedEffect = StateEffect.define<string>();

/** Language stamp for widget `eq()` comparisons. */
export function currentLanguage(): string {
  return i18next.language || 'uk';
}

/**
 * The page-palette header is a CSS `::before` on a body-mounted tooltip, which
 * no component owns — so its text travels as a custom property on :root.
 */
function publishCssStrings(): void {
  document.documentElement.style.setProperty(
    '--folio-pages-hint',
    JSON.stringify(t('pagesHeader')),
  );
}

export const i18nReload: Extension = ViewPlugin.fromClass(
  class {
    private readonly off: () => void;

    constructor(view: EditorView) {
      publishCssStrings();
      this.off = onLanguageChanged(() => {
        publishCssStrings();
        view.dispatch({ effects: languageChangedEffect.of(currentLanguage()) });
      });
    }

    destroy() {
      this.off();
    }
  },
);
