import { Component, type ErrorInfo, type ReactNode } from 'react'

interface ErrorBoundaryProps {
  children: ReactNode
}

interface ErrorBoundaryState {
  error: Error | null
}

/**
 * Top-level React error boundary.
 *
 * Without one, any render/effect throw in the tree unmounts the whole app to a
 * blank screen (we hit exactly this when a hot-reloaded renderer ran ahead of a
 * stale preload). This catches the error, logs it, and shows a recoverable
 * panel with the message + stack and a Reload button, instead of a black void.
 */
export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error('Renderer error caught by ErrorBoundary:', error, info)
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
          alignItems: 'flex-start',
          justifyContent: 'center',
          padding: '0 48px',
          background: 'var(--bg-base, #0b0f1a)',
          color: 'var(--fg-1, #e6eaf2)',
          font: 'var(--t-body, 14px/1.5 system-ui, sans-serif)',
          overflow: 'auto',
        }}
      >
        <div style={{ font: 'var(--t-h2, 600 20px/1.3 system-ui)' }}>
          Something went wrong
        </div>
        <div style={{ color: 'var(--fg-3, #8a93a6)', maxWidth: 640 }}>
          The interface hit an unexpected error and stopped rendering. Reloading
          usually recovers it.
        </div>
        <pre
          style={{
            margin: 0,
            padding: 16,
            maxWidth: '100%',
            maxHeight: '40vh',
            overflow: 'auto',
            background: 'var(--bg-inset, #060a14)',
            border: '1px solid var(--border-default, #1c2436)',
            borderRadius: 8,
            color: 'var(--diff-del-fg, #fb7185)',
            font: 'var(--t-code-sm, 12px/1.5 ui-monospace, monospace)',
            whiteSpace: 'pre-wrap',
          }}
        >
          {error.message}
          {error.stack ? `\n\n${error.stack}` : ''}
        </pre>
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={{
            padding: '8px 16px',
            background: 'var(--accent, #6366f1)',
            color: '#fff',
            border: 'none',
            borderRadius: 8,
            cursor: 'pointer',
            font: 'inherit',
          }}
        >
          Reload
        </button>
      </div>
    )
  }
}

export default ErrorBoundary
