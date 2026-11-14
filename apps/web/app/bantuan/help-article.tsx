"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  ChevronDown,
  LifeBuoy,
  Search,
  ThumbsDown,
  ThumbsUp,
} from "lucide-react";

/**
 * The help article, shaped like the Shopee help centre a buyer already knows: a search
 * field, a breadcrumb, collapsible sections, a sketch of the screen being described, and a
 * "did this help" footer. Someone arriving here is usually mid-claim on a phone, so the
 * search matters more than the prose.
 *
 * The diagrams are drawn, not photographed. Real Shopee screens would need a buyer account
 * and would age badly; a labelled sketch of where the value sits never claims to be one.
 */

type Step = {
  id: string;
  title: string;
  where: string;
  body: string;
  example: string;
  diagram: "order" | "profile" | "address";
  keywords: string;
};

const STEPS: Step[] = [
  {
    id: "nomor-pesanan",
    title: "Nomor pesanan",
    where: "Shopee → Saya → Pesanan Saya → pilih pesanan → Detail Pesanan",
    body: "Nomor ini tertulis di bagian paling atas detail pesanan, tepat di bawah nama toko. Bentuknya campuran huruf dan angka, biasanya 13 sampai 16 karakter, dan diawali tanggal pesanan. Nomor yang sama juga ada di email konfirmasi dan notifikasi Shopee.",
    example: "260101REV0001",
    diagram: "order",
    keywords: "nomor pesanan order id invoice detail pesanan resi",
  },
  {
    id: "username",
    title: "Username Shopee",
    where: "Shopee → Saya → ketuk foto profil di kiri atas",
    body: "Username tampil tepat di bawah nama, tanpa tanda @. Yang dipakai adalah username akun yang memesan, bukan nama penerima di alamat pengiriman. Banyak pembeli tertukar di sini, karena nama penerima sering nama anggota keluarga.",
    example: "rina_kurnia",
    diagram: "profile",
    keywords: "username akun nama pengguna profil pembeli",
  },
  {
    id: "nomor-hp",
    title: "4 digit terakhir nomor HP",
    where: "Detail Pesanan → Alamat Pengiriman",
    body: "Nomor HP di alamat pengiriman ditampilkan tersamar; hanya empat digit terakhir yang terlihat. Itulah empat digit yang diminta portal. Kalau nomor itu sudah tidak aktif, pakai username saja, tidak perlu mencari nomor lamanya.",
    example: "2250",
    diagram: "address",
    keywords: "nomor hp telepon handphone alamat pengiriman 4 digit terakhir",
  },
];

const FAQ = [
  {
    id: "lupa-salah-satu",
    q: "Saya lupa salah satu, apakah tetap bisa klaim?",
    a: "Bisa. Portal menerima username, atau 4 digit terakhir nomor HP. Cukup salah satu, tidak harus dua-duanya.",
  },
  {
    id: "nomor-mati",
    q: "Nomor HP saya sudah tidak aktif atau sudah ganti",
    a: "Pakai username saja. Nomor yang tercatat di pesanan tetap nomor lama, jadi jangan bingung kalau nomor Anda sekarang berbeda.",
  },
  {
    id: "lupa-dua",
    q: "Saya lupa username dan nomor lamanya",
    a: "Kirim nomor pesanan dan bukti pembelian ke support@example.com. Kami cocokkan manual, biasanya di hari yang sama pada jam kerja.",
  },
  {
    id: "tidak-ketemu",
    q: "Nomor pesanan saya tidak ditemukan",
    a: "Periksa kembali: nomor pesanan bukan nomor resi. Nomor pesanan diawali tanggal, misalnya 260101ABC1234. Kalau tetap tidak ditemukan, hubungi dukungan dengan tangkapan layar detail pesanan.",
  },
  {
    id: "keamanan",
    q: "Apakah portal meminta kata sandi atau OTP?",
    a: "Tidak pernah. Portal tidak punya kolom untuk kata sandi, PIN, atau OTP, dan tidak pernah meminta nomor HP lengkap. Alamat resmi hanya claim.example.com.",
  },
];

/**
 * Real screenshots win when they exist. Drop `public/bantuan/<step-id>.png` and it replaces
 * the sketch with no code change; until then the labelled sketch is shown, because a drawn
 * diagram is honest and a fake phone screenshot is not.
 */
function StepVisual({ step, hasShot }: { step: Step; hasShot: boolean }) {
  if (hasShot) {
    return (
      <figure className="mt-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={`/bantuan/${step.id}.png`}
          alt={`Tangkapan layar aplikasi Shopee untuk ${step.title}`}
          className="mx-auto w-full max-w-[320px] rounded-xl ring-1 ring-line"
        />
        <figcaption className="mt-1.5 text-center text-[10.5px] text-ink-500">
          Tangkapan layar aplikasi Shopee.
        </figcaption>
      </figure>
    );
  }
  return <Diagram kind={step.diagram} />;
}

function Diagram({ kind }: { kind: Step["diagram"] }) {
  const rows =
    kind === "order"
      ? ["Pesanan Saya", "Detail Pesanan", "Alamat Pengiriman"]
      : kind === "profile"
        ? ["Akun Saya", "Pesanan Saya", "Ubah Profil"]
        : ["Detail Pesanan", "Alamat Pengiriman", "Nomor HP"];
  const highlight = kind === "order" ? 1 : kind === "profile" ? 0 : 2;
  const value =
    kind === "order"
      ? "260101ABC1234"
      : kind === "profile"
        ? "@rina_kurnia"
        : "********2250";

  return (
    <div className="mt-3 rounded-xl bg-canvas p-3 ring-1 ring-inset ring-line">
      <p className="mb-2 text-[10.5px] font-medium uppercase tracking-wide text-ink-500">
        Ilustrasi layar, bukan tangkapan layar
      </p>
      <div className="mx-auto w-[188px] rounded-[18px] bg-surface p-2 ring-1 ring-line">
        <p className="sr-only">{`Ilustrasi menu ${rows.join(", ")}`}</p>
        <div className="mb-2 flex items-center gap-1.5">
          <span className="h-5 w-5 rounded-full bg-canvas ring-1 ring-line" />
          <span className="h-2 w-16 rounded-full bg-canvas" />
        </div>
        <div className="space-y-1">
          {rows.map((row, index) => (
            <div
              key={row}
              className={`flex items-center justify-between rounded-md px-2 py-1.5 text-[10px] ${
                index === highlight
                  ? "bg-brand-50 font-semibold text-brand-800 ring-1 ring-inset ring-brand-100"
                  : "text-ink-500"
              }`}
            >
              <span>{row}</span>
              <ChevronDown className="h-3 w-3 -rotate-90 opacity-60" />
            </div>
          ))}
        </div>
        <p className="mt-2 rounded-md bg-canvas px-2 py-1 font-mono text-[9.5px] text-ink-800">
          {value}
        </p>
      </div>
      <p className="mt-2 text-center text-[10.5px] leading-relaxed text-ink-500">
        Pilih {rows[highlight]} di aplikasi Shopee.
      </p>
    </div>
  );
}

export function HelpArticle({
  screenshots,
}: {
  screenshots: Record<string, boolean>;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<string | null>(STEPS[0]?.id ?? null);
  const [openFaq, setOpenFaq] = useState<string | null>(null);
  const [voted, setVoted] = useState<"up" | "down" | null>(null);

  const q = query.trim().toLowerCase();
  const steps = useMemo(
    () =>
      q
        ? STEPS.filter(
            (step) =>
              step.title.toLowerCase().includes(q) ||
              step.where.toLowerCase().includes(q) ||
              step.keywords.includes(q),
          )
        : STEPS,
    [q],
  );
  const faq = useMemo(
    () =>
      q
        ? FAQ.filter(
            (item) =>
              item.q.toLowerCase().includes(q) ||
              item.a.toLowerCase().includes(q),
          )
        : FAQ,
    [q],
  );

  return (
    <main className="relative min-h-dvh bg-canvas">
      <div className="relative mx-auto w-full max-w-2xl px-4 pt-6 pb-[calc(env(safe-area-inset-bottom)+3rem)] sm:px-6 sm:py-10">
        <nav className="mb-3 flex flex-wrap items-center gap-1.5 text-[11.5px] text-ink-500">
          <Link href="/" className="hover:text-ink-950">
            Portal klaim
          </Link>
          <span aria-hidden>/</span>
          <span className="text-ink-800">Bantuan</span>
          <span aria-hidden>/</span>
          <span className="text-ink-800">Detail pesanan</span>
        </nav>

        <p className="text-[13px] font-medium uppercase tracking-wide text-brand-800">
          Pesanan
        </p>
        <h1 className="mt-1 text-[24px] font-semibold leading-tight tracking-tight text-ink-950">
          Cara melihat nomor pesanan, username, dan nomor HP
        </h1>
        <p className="mt-2 text-[14px] leading-relaxed text-ink-600">
          Hai, ada yang bisa kami bantu? Portal klaim meminta tiga hal supaya
          produk tidak bisa diambil orang lain, dan semuanya ada di aplikasi
          Shopee Anda.
        </p>

        <div className="relative mt-4">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-500" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Cari: nomor pesanan, username, nomor HP"
            aria-label="Cari di halaman bantuan"
            className="h-11 w-full rounded-lg bg-surface pl-9 pr-3 text-[14px] text-ink-950 ring-1 ring-inset ring-line placeholder:text-ink-500 focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>

        <p className="mt-2 text-[11.5px] text-ink-500">
          {q
            ? `${steps.length + faq.length} hasil untuk "${query.trim()}"`
            : `${STEPS.length} langkah, ${FAQ.length} pertanyaan`}
        </p>

        <div className="mt-4 space-y-2">
          {steps.map((step, index) => {
            const isOpen = open === step.id;
            return (
              <section
                key={step.id}
                className="overflow-hidden rounded-2xl bg-surface shadow-card ring-1 ring-line"
              >
                <button
                  onClick={() => setOpen(isOpen ? null : step.id)}
                  aria-expanded={isOpen}
                  className="flex w-full items-start gap-3 p-4 text-left"
                >
                  <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-700 text-[12.5px] font-semibold text-white">
                    {index + 1}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[11px] font-medium uppercase tracking-wide text-brand-800">
                      Langkah {index + 1}
                    </span>
                    <span className="mt-0.5 block text-[15px] font-semibold text-ink-950">
                      {step.title}
                    </span>
                    <span className="mt-1 block text-[12px] font-medium text-ink-600">
                      {step.where}
                    </span>
                  </span>
                  <ChevronDown
                    className={`mt-1 h-4 w-4 shrink-0 text-ink-500 transition-transform ${isOpen ? "rotate-180" : ""}`}
                  />
                </button>
                {isOpen ? (
                  <div className="border-t border-line px-4 pb-4 pt-3">
                    <p className="text-[13px] leading-relaxed text-ink-600">
                      {step.body}
                    </p>
                    <p className="mt-2 inline-block rounded-lg bg-canvas px-2.5 py-1 font-mono text-[12.5px] text-ink-800 ring-1 ring-inset ring-line">
                      contoh: {step.example}
                    </p>
                    <StepVisual
                      step={step}
                      hasShot={screenshots[step.id] === true}
                    />
                  </div>
                ) : null}
              </section>
            );
          })}
          {steps.length === 0 ? (
            <p className="rounded-2xl bg-surface px-4 py-6 text-center text-[13px] text-ink-500 ring-1 ring-line">
              Tidak ada langkah yang cocok. Coba kata lain, atau kirim ke
              support@example.com.
            </p>
          ) : null}
        </div>

        <h2 className="mt-7 text-[17px] font-semibold text-ink-950">
          Pertanyaan yang sering muncul
        </h2>
        <div className="mt-2 divide-y divide-line overflow-hidden rounded-2xl bg-surface shadow-card ring-1 ring-line">
          {faq.map((item) => {
            const isOpen = openFaq === item.id;
            return (
              <div key={item.id}>
                <button
                  onClick={() => setOpenFaq(isOpen ? null : item.id)}
                  aria-expanded={isOpen}
                  className="flex w-full items-center justify-between gap-3 px-4 py-3.5 text-left"
                >
                  <span className="text-[13.5px] font-medium text-ink-900">
                    {item.q}
                  </span>
                  <ChevronDown
                    className={`h-4 w-4 shrink-0 text-ink-500 transition-transform ${isOpen ? "rotate-180" : ""}`}
                  />
                </button>
                {isOpen ? (
                  <p className="px-4 pb-4 text-[13px] leading-relaxed text-ink-600">
                    {item.a}
                  </p>
                ) : null}
              </div>
            );
          })}
          {faq.length === 0 ? (
            <p className="px-4 py-6 text-center text-[13px] text-ink-500">
              Tidak ada pertanyaan yang cocok. Kirim ke support@example.com.
            </p>
          ) : null}
        </div>

        <section className="mt-6 rounded-2xl bg-surface p-4 shadow-card ring-1 ring-line">
          <div className="flex items-center gap-2">
            <LifeBuoy className="h-4 w-4 text-brand-700" />
            <h2 className="text-[14px] font-semibold text-ink-950">
              Masih butuh bantuan?
            </h2>
          </div>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-600">
            Kirim nomor pesanan dan bukti pembelian ke{" "}
            <a
              className="font-medium text-brand-800 underline decoration-line underline-offset-2 hover:text-ink-950"
              href="mailto:support@example.com"
            >
              support@example.com
            </a>
            . Kami cocokkan manual, biasanya di hari yang sama.
          </p>
        </section>

        <section className="mt-6 rounded-2xl bg-surface p-4 shadow-card ring-1 ring-line">
          <p className="text-[13.5px] font-medium text-ink-900">
            Apakah halaman ini membantu?
          </p>
          {voted ? (
            <p className="mt-2 text-[12.5px] text-ink-600">
              Terima kasih.{" "}
              {voted === "down"
                ? "Kalau masih buntu, kirim email ke support@example.com."
                : ""}
            </p>
          ) : (
            <div className="mt-2 flex gap-2">
              <button
                onClick={() => setVoted("up")}
                className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-[12.5px] font-medium text-ink-700 ring-1 ring-inset ring-line hover:bg-canvas"
              >
                <ThumbsUp className="h-3.5 w-3.5" /> Ya
              </button>
              <button
                onClick={() => setVoted("down")}
                className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-[12.5px] font-medium text-ink-700 ring-1 ring-inset ring-line hover:bg-canvas"
              >
                <ThumbsDown className="h-3.5 w-3.5" /> Belum
              </button>
            </div>
          )}
        </section>

        <Link
          href="/"
          className="mt-6 flex h-12 w-full items-center justify-center rounded-lg bg-brand-700 text-[15px] font-medium text-white transition-colors hover:bg-brand-800"
        >
          Kembali ke portal klaim
        </Link>
      </div>
    </main>
  );
}
