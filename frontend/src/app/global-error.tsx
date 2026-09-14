'use client'

// Global error boundary: replaces the ROOT LAYOUT when it (or a child during
// hydration) fails, so no provider exists here — next-intl hooks would throw.
// Text is therefore static and bilingual, and styles are inline (globals.css
// may not have loaded).
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'system-ui, sans-serif',
          background: '#ffffff',
          color: '#111111',
        }}
      >
        <div style={{ maxWidth: 420, padding: 24, textAlign: 'center' }}>
          <h1 style={{ fontSize: 18, margin: '0 0 8px' }}>Something went wrong</h1>
          <p style={{ fontSize: 14, color: '#555555', margin: '0 0 8px' }}>
            An unexpected error occurred. Please reload the page.
          </p>
          <p style={{ fontSize: 13, color: '#777777', margin: '0 0 16px' }}>
            Произошла непредвиденная ошибка. Перезагрузите страницу.
          </p>
          <button
            onClick={() => {
              console.error('Global error boundary', error)
              reset()
            }}
            style={{
              padding: '6px 14px',
              fontSize: 14,
              borderRadius: 6,
              border: '1px solid #cccccc',
              background: '#f5f5f5',
              cursor: 'pointer',
            }}
          >
            Try again / Попробовать снова
          </button>
        </div>
      </body>
    </html>
  )
}
