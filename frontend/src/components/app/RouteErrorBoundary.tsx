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
      <div role="alert" data-route-error="true" className="mwz-hud-frame mx-auto my-10 max-w-xl space-y-3 p-6 text-sm">
        <h1 className="font-retro text-lg text-foreground">Something went wrong on this page</h1>
        <p className="text-muted-foreground">The rest of the app still works. Reload to try again, or go back.</p>
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/60 bg-background/60 p-3 text-xs text-orange-200">
          {String(error?.message || error)}
        </pre>
        <div className="flex gap-2">
          <button type="button" className="mwz-button mwz-button-orange min-h-10 px-4 font-retro text-xs" onClick={() => window.location.reload()}>
            Reload
          </button>
          <button type="button" className="min-h-10 rounded-md border border-border/60 px-4 font-retro text-xs" onClick={() => window.history.back()}>
            Back
          </button>
        </div>
      </div>
    );
  }
}
