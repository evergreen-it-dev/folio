/**
 * Public surface of the diagrams module (Agent DIAGRAMS' owned area).
 * Consumers (editor widgets, markdown reading view, board routes) should
 * only ever import from here — everything else in this directory is an
 * implementation detail and may change shape freely.
 */
export { MermaidBlock, type MermaidBlockProps } from './MermaidBlock';
export { BoardEditor, type BoardEditorProps } from './BoardEditor';
