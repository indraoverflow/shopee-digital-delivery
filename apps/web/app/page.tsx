import { ClaimFlow } from "@/components/claim/claim-flow";
import { ToastProvider } from "@/components/ui";

interface PublicConfig {
  branding: { brandName: string; tagline: string; supportEmail: string; supportWhatsapp: string; claimDomain: string };
  claim: { sessionMinutes: number };
  gatewayMode: "live" | "fixture";
}

/**
 * Branding and claim limits are read on the server so the page paints with the
 * real store name, and the browser never waits on a second round trip.
 */
async function loadConfig(): Promise<PublicConfig | null> {
  try {
    const response = await fetch(`${process.env.API_URL ?? "http://127.0.0.1:4000"}/api/public/config`, { cache: "no-store" });
    if (!response.ok) return null;
    return (await response.json()) as PublicConfig;
  } catch {
    return null;
  }
}

export default async function ClaimPortalPage() {
  const config = await loadConfig();

  return (
    <main className="relative min-h-dvh overflow-hidden">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[420px] bg-gradient-to-b from-brand-50 via-canvas to-canvas" aria-hidden />
      <div className="pointer-events-none absolute -left-24 top-24 h-64 w-64 rounded-full bg-brand-100/60 blur-3xl" aria-hidden />
      <div className="pointer-events-none absolute -right-20 top-64 h-72 w-72 rounded-full bg-amber-100/50 blur-3xl" aria-hidden />

      <div className="relative mx-auto flex min-h-dvh w-full max-w-6xl flex-col px-4 py-6 sm:px-6 sm:py-10">
        <header className="mb-10 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-700 text-[15px] font-semibold text-white">Q</span>
            <div className="leading-tight">
              <p className="text-[14px] font-semibold text-ink-950">{config?.branding.brandName ?? "Qansa"}</p>
              <p className="text-[11.5px] text-ink-400">{config?.branding.claimDomain ?? "claim.qansa.web.id"}</p>
            </div>
          </div>
          <a
            href={`mailto:${config?.branding.supportEmail ?? "support@qansa.web.id"}`}
            className="rounded-lg px-3 py-1.5 text-[12.5px] font-medium text-ink-600 ring-1 ring-inset ring-line transition-colors hover:bg-surface"
          >
            Dukungan
          </a>
        </header>

        <div className="flex flex-1 items-start justify-center pb-10 sm:items-center">
          <ToastProvider>
            <ClaimFlow config={config} />
          </ToastProvider>
        </div>
      </div>
    </main>
  );
}
