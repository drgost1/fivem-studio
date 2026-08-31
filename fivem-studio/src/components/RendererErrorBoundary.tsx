import { Component, type ErrorInfo, type ReactNode } from "react";

interface RendererErrorBoundaryProps {
  children: ReactNode;
}

interface RendererErrorBoundaryState {
  error: Error | null;
}

/**
 * Keep a preload or renderer initialization failure actionable instead of
 * leaving the user with an unexplained blank window.
 */
export default class RendererErrorBoundary extends Component<
  RendererErrorBoundaryProps,
  RendererErrorBoundaryState
> {
  state: RendererErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): RendererErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("FiveM Studio renderer failed", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <main className="renderer-error" role="alert" aria-live="assertive">
        <section className="renderer-error-card">
          <p className="eyebrow">FiveM Studio could not start</p>
          <h1>The interface hit an unexpected error.</h1>
          <p>
            Reload the window to try again. If the problem continues, include the
            message below when reporting it.
          </p>
          <pre>{this.state.error.message || "Unknown renderer error"}</pre>
          <button type="button" className="btn primary" onClick={() => window.location.reload()}>
            Reload FiveM Studio
          </button>
        </section>
      </main>
    );
  }
}
