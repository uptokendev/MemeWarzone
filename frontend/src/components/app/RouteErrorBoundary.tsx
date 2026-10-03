import { Component, type ReactNode } from "react";

/**
 * Without a boundary, any render error on any page unmounts the whole app and leaves a blank screen
 * with no clue (reported 2026-09-25 on an imported token page). This keeps the shell, says what
 * broke, and lets the user reload. Keyed by the route, so navigating away clears it.
 */
type Props = { children: ReactNode; routeKey: string };
type State = { error: Error | null };

export class RouteErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string }) {
    console.error("[route-error]", this.props.routeKey, error, info?.componentStack || "");
  }

  componentDidUpdate(prev: Props) {
    if (prev.routeKey !== this.props.routeKey && this.state.error) this.setState({ error: null });
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div role="alert" data-route-error="true" className="mx-4 my-10 max-w-xl space-y-3 rounded-[18px] border border-mw-edge bg-mw-surface font-mw-body text-mw-text p-5 text-sm sm:mx-auto">
        <h1 className="font-mw-cond text-2xl font-bold text-mw-text">Something went wrong on this page</h1>
        <p className="text-mw-muted">The rest of the app still works. Reload to try again, or go back.</p>
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-[14px] border border-mw-border bg-mw-input p-3 font-mw-mono text-xs text-mw-sell">
          {String(error?.message || error)}
        </pre>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="mw-focus inline-flex min-h-11 items-center justify-center gap-2 rounded-[10px] border border-mw-accent bg-mw-accent px-4 text-[15px] font-semibold text-[#140A02] hover:bg-[#FF8F3D] disabled:opacity-50" onClick={() => window.location.reload()}>
            Reload
          </button>
          <button type="button" className="mw-focus inline-flex min-h-11 items-center justify-center gap-2 whitespace-nowrap rounded-[10px] border border-mw-edge bg-mw-raised px-4 text-[15px] font-semibold text-mw-text hover:bg-[#222830] hover:text-mw-text disabled:opacity-60" onClick={() => window.history.back()}>
            Back
          </button>
        </div>
      </div>
    );
  }
}
