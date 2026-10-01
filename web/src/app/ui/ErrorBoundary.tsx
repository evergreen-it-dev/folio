import { Component, type ErrorInfo, type ReactNode } from 'react';

export interface ErrorBoundaryProps {
  /** What to show instead of the subtree that threw. `reset` renders the subtree again. */
  fallback: (error: unknown, reset: () => void) => ReactNode;
  /** A change of this value clears the error by itself — the route, the page id. */
  resetKey?: unknown;
  children: ReactNode;
}

interface State {
  error: unknown;
  failed: boolean;
}

/**
 * React takes the WHOLE tree down when a render throws and nothing catches
 * it — sidebar, header, everything (the owner, 29.09.2026: "an attempt to
 * create a board offline led to everything disappearing": a lazily loaded module
 * that cannot be fetched without a network rejects inside `lazy()`, which
 * is a render error). This keeps the damage to the part that failed.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, State> {
  state: State = { error: null, failed: false };

  static getDerivedStateFromError(error: unknown): State {
    return { error, failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error('[folio] render failed:', error, info.componentStack);
  }

  componentDidUpdate(previous: ErrorBoundaryProps): void {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) this.reset();
  }

  reset = (): void => {
    this.setState({ error: null, failed: false });
  };

  render(): ReactNode {
    return this.state.failed ? this.props.fallback(this.state.error, this.reset) : this.props.children;
  }
}
