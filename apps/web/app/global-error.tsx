"use client";

// Shown when the root layout itself fails; it must render its own <html> and <body>.
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", display: "grid", placeItems: "center", minHeight: "100dvh", margin: 0, textAlign: "center" }}>
        <div>
          <h1>Something went wrong</h1>
          {error.digest && <p style={{ fontFamily: "monospace", fontSize: 12, color: "#888" }}>Reference: {error.digest}</p>}
          <button onClick={reset} style={{ padding: "10px 20px", borderRadius: 12 }}>Try again</button>
        </div>
      </body>
    </html>
  );
}
