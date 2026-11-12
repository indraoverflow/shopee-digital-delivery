import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex min-h-dvh items-center justify-center px-4">
      <div className="max-w-md text-center">
        <p className="mb-3 font-mono text-[12px] uppercase tracking-[0.18em] text-ink-400">404</p>
        <h1 className="text-[24px] font-semibold text-ink-950">Halaman tidak ditemukan</h1>
        <p className="mt-2 text-[13.5px] leading-relaxed text-ink-500">
          Tautan ini mungkin sudah tidak berlaku. Buka portal klaim untuk memeriksa pesanan Anda.
        </p>
        <Link
          href="/"
          className="mt-6 inline-flex h-10 items-center rounded-lg bg-brand-700 px-4 text-[14px] font-medium text-white hover:bg-brand-800"
        >
          Ke portal klaim
        </Link>
      </div>
    </main>
  );
}
