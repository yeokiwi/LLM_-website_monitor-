/**
 * Catches render errors so they show up as a message instead of a white page.
 *
 * Without this, any throw during render unmounts the whole tree and leaves an
 * empty <div id="root">: no header, no nav, nothing to report. A one-line
 * `ReferenceError` in a table header presented exactly like a dead server, and
 * cost a deploy cycle to track down. Whatever breaks next should say so.
 */
import React from 'react';
import s from './ErrorBoundary.module.css';

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null, componentStack: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Log as well as render: a blank console is what made this hard to place,
    // and a full page navigation clears the console before anyone reads it.
    console.error('Render error caught by ErrorBoundary:', error, info);
    this.setState({ componentStack: info?.componentStack || null });
  }

  render() {
    const { error, componentStack } = this.state;
    if (!error) return this.props.children;

    return (
      <div className={s.page}>
        <div className={s.card}>
          <h1 className={s.title}>Something broke on this page</h1>
          <p className={s.lead}>
            The error is below. Reloading often clears it; if it comes straight
            back, the message is what to report.
          </p>

          <pre className={s.message}>{error.message || String(error)}</pre>

          {componentStack && (
            <details className={s.details}>
              <summary className={s.summary}>Where it happened</summary>
              <pre className={s.stack}>{componentStack}</pre>
            </details>
          )}

          <button className={s.btn} type="button" onClick={() => window.location.reload()}>
            Reload the page
          </button>
        </div>
      </div>
    );
  }
}
