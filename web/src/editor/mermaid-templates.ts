/** Starter diagrams for the modal editor's template palette. */
import { t } from './i18n';

export interface MermaidTemplate {
  id: string;
  label: string;
  code: string;
}

const IDS = [
  'flowchart',
  'sequence',
  'class',
  'state',
  'er',
  'gantt',
  'timeline',
  'pie',
  'mindmap',
] as const;

/**
 * Built per call rather than cached: labels *and* diagram bodies are
 * translated, so a language switch has to be reflected the next time the modal
 * opens without any invalidation bookkeeping.
 */
export function mermaidTemplates(): MermaidTemplate[] {
  return IDS.map((id) => ({
    id,
    label: t(`template.${id}`),
    code: t(`templateCode.${id}`),
  }));
}
