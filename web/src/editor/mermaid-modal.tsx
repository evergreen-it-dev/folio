/**
 * The mermaid editor dialog: a visual canvas (round 20) with the mermaid source
 * beside it, and starter templates above both.
 *
 * The two panes are bound in both directions through one string. The source
 * pane is the CodeMirror draft, the canvas is visimer; whichever one the author
 * touches writes the smallest possible edit into the other, so a click on the
 * diagram does not reset the caret in the code and vice versa.
 *
 * Saving writes ONE text edit back into the page document, so it lands in Yjs
 * and the undo history like any other edit. The fence is re-resolved at save
 * time through the mapped anchor, because the collab connection stays live
 * while the modal is open and a peer may have moved or deleted the block.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { syntaxTree } from '@codemirror/language';
import { EditorState, Prec } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { blockAnchorField, setBlockAnchor, type MermaidEditRequest } from './editor-services';
import { mermaidFenceAt } from './live-decorations';
import { MermaidVisualPane } from './mermaid-visual';
import { mermaidTemplates } from './mermaid-templates';
import { ModalShell } from './modal-shell';
import { minimalReplace } from './text-edit';
import { showToast } from './toast';
import { NS } from './i18n';
import { useTranslation } from 'react-i18next';

export function MermaidModal({ request, onClose }: { request: MermaidEditRequest; onClose: () => void }) {
  const { t } = useTranslation(NS);
  const { view } = request;
  const [draft, setDraft] = useState(request.code);
  const hostRef = useRef<HTMLDivElement>(null);
  const draftViewRef = useRef<EditorView | null>(null);
  // The draft editor is built once; its keymap reaches the current handlers here.
  const actions = useRef({ save: () => {}, cancel: () => {} });

  const close = useCallback(() => {
    view.dispatch({ effects: setBlockAnchor.of(null) });
    onClose();
    view.focus();
  }, [view, onClose]);

  const save = useCallback(() => {
    const anchor = view.state.field(blockAnchorField, false);
    if (anchor === null || anchor === undefined) {
      showToast(view, t('mermaid.deleted'));
      close();
      return;
    }
    const fence = mermaidFenceAt(view.state.doc, syntaxTree(view.state), anchor);
    if (!fence) {
      showToast(view, t('mermaid.changed'));
      close();
      return;
    }
    const body = draft.replace(/\s+$/, '');
    view.dispatch({
      changes: { from: fence.from, to: fence.to, insert: `${fence.open}\n${body}\n${fence.close}` },
      effects: setBlockAnchor.of(null),
    });
    onClose();
    view.focus();
  }, [view, draft, close, onClose]);

  actions.current = { save, cancel: close };

  useEffect(() => {
    const parent = hostRef.current;
    if (!parent) return;
    const draftView = new EditorView({
      state: EditorState.create({
        doc: request.code,
        extensions: [
          lineNumbers(),
          history(),
          EditorView.lineWrapping,
          EditorView.updateListener.of((update) => {
            if (update.docChanged) setDraft(update.state.doc.toString());
          }),
          Prec.high(
            keymap.of([
              { key: 'Mod-Enter', run: () => (actions.current.save(), true) },
              { key: 'Escape', run: () => (actions.current.cancel(), true) },
            ]),
          ),
          keymap.of([...historyKeymap, ...defaultKeymap]),
          modalEditorTheme,
        ],
      }),
      parent,
    });
    draftViewRef.current = draftView;
    draftView.focus();
    return () => {
      draftViewRef.current = null;
      draftView.destroy();
    };
    // Mount-only: later `request.code` changes mean a different block entirely,
    // and the modal is remounted with a fresh key in that case.
  }, [request]);

  /**
   * The canvas edited the diagram: mirror it into the source pane as the one
   * edit that actually changed, so the code editor keeps its caret, its scroll
   * position and a sane undo history.
   */
  const applyVisualEdit = useCallback((next: string) => {
    const draftView = draftViewRef.current;
    if (!draftView) return;
    const current = draftView.state.doc.toString();
    const change = minimalReplace(current, next);
    if (!change) return;
    draftView.dispatch({ changes: change });
  }, []);

  const applyTemplate = (code: string) => {
    const draftView = draftViewRef.current;
    if (!draftView) return;
    const current = draftView.state.doc.toString();
    if (current.trim() && !window.confirm(t('mermaid.replaceConfirm'))) return;
    draftView.dispatch({ changes: { from: 0, to: current.length, insert: code } });
    draftView.focus();
  };

  const templates = (
    <div className="folio-modal__templates">
      <span className="folio-modal__templates-label">{t('mermaid.templates')}</span>
      {mermaidTemplates().map((template) => (
        <button
          key={template.id}
          type="button"
          className="folio-modal__chip"
          onClick={() => applyTemplate(template.code)}
        >
          {template.label}
        </button>
      ))}
    </div>
  );

  return (
    <ModalShell
      ariaLabel={t('mermaid.modalAria')}
      title={t('mermaid.modalTitle')}
      closeLabel={t('mermaid.close')}
      hint={t('mermaid.hint')}
      cancelLabel={t('mermaid.cancel')}
      saveLabel={t('mermaid.save')}
      fullscreenLabel={t('mermaid.fullscreen')}
      restoreLabel={t('mermaid.restore')}
      onCancel={close}
      onSave={save}
      toolbar={templates}
    >
      <div className="folio-modal__pane folio-modal__pane--code" ref={hostRef} />
      <div className="folio-modal__pane folio-modal__pane--visual">
        <MermaidVisualPane code={draft} onCodeChange={applyVisualEdit} />
      </div>
    </ModalShell>
  );
}

const modalEditorTheme = EditorView.theme({
  '&': { height: '100%', fontSize: '13px', backgroundColor: 'transparent' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--folio-ed-mono)', lineHeight: '1.6' },
  '.cm-content': { caretColor: 'var(--folio-ed-caret)' },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    border: 'none',
    color: 'var(--folio-ed-faint)',
  },
});

/** Memoised so the modal isn't recreated on unrelated parent renders. */
export function useMermaidModal() {
  const [request, setRequest] = useState<MermaidEditRequest | null>(null);
  const services = useMemo(() => ({ openMermaidEditor: setRequest }), []);
  const close = useCallback(() => setRequest(null), []);
  return { request, services, close };
}
