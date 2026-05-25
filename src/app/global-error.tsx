'use client';

import { useEffect } from 'react';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Global error:', error);
  }, [error]);

  return (
    <html lang="en">
      <body>
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: '100vh',
          fontFamily: 'system-ui, sans-serif',
          padding: '20px',
          textAlign: 'center',
        }}>
          <h1 style={{ fontSize: '24px', marginBottom: '8px' }}>Something went wrong</h1>
          <p style={{ color: '#666', marginBottom: '24px', maxWidth: '400px' }}>
            An unexpected error occurred. Please try again or contact your administrator if the problem persists.
          </p>
          <div style={{ display: 'flex', gap: '12px' }}>
            <button
              onClick={reset}
              style={{
                padding: '10px 20px',
                backgroundColor: '#228be6',
                color: 'white',
                border: 'none',
                borderRadius: '6px',
                cursor: 'pointer',
                fontSize: '14px',
              }}
            >
              Try Again
            </button>
            <a
              href="/"
              style={{
                padding: '10px 20px',
                backgroundColor: '#e9ecef',
                color: '#333',
                borderRadius: '6px',
                textDecoration: 'none',
                fontSize: '14px',
              }}
            >
              Go Home
            </a>
          </div>
        </div>
      </body>
    </html>
  );
}
