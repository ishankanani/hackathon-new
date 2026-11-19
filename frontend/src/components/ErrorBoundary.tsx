import { Component, type ErrorInfo, type ReactNode } from "react";

/** Shows what went wrong instead of a blank page when a view crashes while drawing. */
export class ErrorBoundary extends Component<{ name: string; children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[${this.props.name}] crashed:`, error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div role="alert" className="notice notice--warn" style={{ display: "block" }}>
        <b>The {this.props.name} could not be displayed.</b> Your data is safe.
        <pre style={{ whiteSpace: "pre-wrap", fontSize: 12, margin: "8px 0" }}>{error.message}</pre>
        <button className="linkbtn" onClick={() => this.setState({ error: null })}>Try again</button>{" "}
        <button className="linkbtn" onClick={() => window.location.reload()}>Reload page</button>
      </div>
    );
  }
}
