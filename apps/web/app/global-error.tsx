"use client";

/**
 * A fatal error still has to look like the product, so this page replaces the
 * framework default: same palette, one action, no stack trace in the browser.
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="id">
      <body style={{ background: "#faf8f5", color: "#2a2722", fontFamily: "ui-sans-serif, system-ui, sans-serif", margin: 0 }}>
        <main style={{ display: "flex", minHeight: "100dvh", alignItems: "center", justifyContent: "center", padding: "2rem" }}>
          <div style={{ maxWidth: 420, textAlign: "center" }}>
            <div
              style={{
                display: "flex",
                height: 44,
                width: 44,
                alignItems: "center",
                justifyContent: "center",
                borderRadius: 14,
                background: "#0b4b40",
                color: "#fff",
                fontWeight: 600,
                margin: "0 auto 1.25rem",
              }}
            >
              Q
            </div>
            <h1 style={{ fontSize: 20, fontWeight: 600, margin: "0 0 0.5rem" }}>Ada gangguan di halaman ini</h1>
            <p style={{ fontSize: 13.5, lineHeight: 1.6, color: "#57524a", margin: "0 0 1.25rem" }}>
              Permintaan tidak bisa diselesaikan. Coba muat ulang; bila tetap gagal, hubungi dukungan dan sebutkan kode{" "}
              <code style={{ fontFamily: "ui-monospace, monospace" }}>{error.digest ?? "tanpa-kode"}</code>.
            </p>
            <button
              onClick={reset}
              style={{
                height: 40,
                padding: "0 1rem",
                borderRadius: 10,
                border: "none",
                background: "#0b4b40",
                color: "#fff",
                fontSize: 14,
                fontWeight: 500,
                cursor: "pointer",
              }}
            >
              Muat ulang halaman
            </button>
          </div>
        </main>
      </body>
    </html>
  );
}
