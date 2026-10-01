/**
 * Ghost hint shown on an empty page: three muted lines naming the triggers.
 * It is a decoration rather than real text, so it can never be selected,
 * copied or saved, and it vanishes the moment anything is typed.
 */
import { StateField, type Extension } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import { t } from './i18n';
import { currentLanguage, languageChangedEffect } from './i18n-reload';
import { isEffectivelyEmpty } from './live-decorations';

/** Trigger glyphs are literal; only the explanation is translated. */
const LINES: readonly (readonly [key: string, messageKey: string])[] = [
  ['/', 'emptyHint.insert'],
  ['[[', 'emptyHint.links'],
  ['⌘K', 'emptyHint.search'],
];

class EmptyHintWidget extends WidgetType {
  constructor(readonly lang: string) {
    super();
  }

  eq(other: EmptyHintWidget): boolean {
    // Content only varies with the interface language.
    return other.lang === this.lang;
  }

  get estimatedHeight(): number {
    return 76;
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'cm-md-emptyhint';
    wrap.setAttribute('aria-hidden', 'true');
    for (const [key, messageKey] of LINES) {
      const line = document.createElement('div');
      line.className = 'cm-md-emptyhint__line';
      const kbd = document.createElement('span');
      kbd.className = 'cm-md-emptyhint__key';
      kbd.textContent = key;
      line.append(kbd, document.createTextNode(t(messageKey)));
      wrap.appendChild(line);
    }
    return wrap;
  }
}

function build(text: string, length: number): DecorationSet {
  if (!isEffectivelyEmpty(text)) return Decoration.none;
  const hint = Decoration.widget({
    widget: new EmptyHintWidget(currentLanguage()),
    block: true,
    side: 1,
  });
  return Decoration.set([hint.range(length)]);
}

/** Active in both live and source mode; reading mode has its own empty state. */
export const emptyPageHint: Extension = StateField.define<DecorationSet>({
  create: (state) => build(state.doc.toString(), state.doc.length),
  update(value, tr) {
    const relanguaged = tr.effects.some((effect) => effect.is(languageChangedEffect));
    if (!tr.docChanged && !relanguaged) return value;
    return build(tr.state.doc.toString(), tr.state.doc.length);
  },
  provide: (field) => EditorView.decorations.from(field),
});
