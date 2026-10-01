// @vitest-environment jsdom
/**
 * The graceful-fallback branch of the mermaid dialog: visimer understands a
 * large but finite part of mermaid, and a diagram it cannot model must leave
 * the author with a working editor rather than an empty dialog.
 */
import { act } from '@testing-library/react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MermaidVisualBoundary, MermaidVisualFallback } from './mermaid-visual';

let host: HTMLDivElement | null = null;
let root: Root | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  const current = root;
  if (current) act(() => current.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.restoreAllMocks();
});

function mount(node: React.ReactNode): HTMLElement {
  host = document.createElement('div');
  document.body.append(host);
  const created = createRoot(host);
  root = created;
  act(() => created.render(node));
  return host;
}

function Boom(): React.ReactElement {
  throw new Error('visimer cannot model this diagram');
}

describe('MermaidVisualBoundary', () => {
  it('renders the canvas while nothing throws', () => {
    const dom = mount(
      <MermaidVisualBoundary fallback={<p>fallback</p>}>
        <p>canvas</p>
      </MermaidVisualBoundary>,
    );
    expect(dom.textContent).toContain('canvas');
    expect(dom.textContent).not.toContain('fallback');
  });

  it('swaps in the fallback when the canvas throws, and says so once', () => {
    // React logs the caught error itself; the test is about what the user sees.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const onFail = vi.fn();

    const dom = mount(
      <MermaidVisualBoundary fallback={<p>fallback</p>} onFail={onFail}>
        <Boom />
      </MermaidVisualBoundary>,
    );

    expect(dom.textContent).toContain('fallback');
    expect(dom.textContent).not.toContain('canvas');
    expect(onFail).toHaveBeenCalledTimes(1);
  });

  it('stays on the fallback for the life of the dialog', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const dom = mount(
      <MermaidVisualBoundary fallback={<p>fallback</p>}>
        <Boom />
      </MermaidVisualBoundary>,
    );

    // A later keystroke re-renders the same boundary with a healthy child; the
    // canvas must not come back and throw again on every character typed.
    act(() =>
      root!.render(
        <MermaidVisualBoundary fallback={<p>fallback</p>}>
          <p>canvas</p>
        </MermaidVisualBoundary>,
      ),
    );
    expect(dom.textContent).toContain('fallback');
  });
});

describe('MermaidVisualFallback', () => {
  it('shows the reason and keeps rendering the diagram from the draft code', () => {
    const dom = mount(<MermaidVisualFallback code="flowchart TD\n A --> B" notice="no canvas" />);
    const notice = dom.querySelector('.folio-modal__notice');
    expect(notice?.textContent).toBe('no canvas');
    expect(notice?.getAttribute('role')).toBe('status');
    // The preview host is present, so the source pane is not the only surface.
    expect(dom.querySelector('.folio-modal__fallback-preview')).not.toBeNull();
  });
});
