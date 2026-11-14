import type { Metadata } from "next";
import Link from "next/link";

/**
 * The page a buyer opens when the claim form asks for something they cannot find.
 *
 * It is written for a phone screen and for someone who is already annoyed: short steps,
 * the exact menu names in the Shopee app, and no talk about systems or verification
 * policies. Everything here is about where a value is shown, not about why we want it.
 */

export const metadata: Metadata = {
  title: "Cara melihat detail pesanan Shopee",
  description:
    "Di mana menemukan nomor pesanan, username, dan 4 digit terakhir nomor HP di aplikasi Shopee.",
};

const steps: Array<{
  title: string;
  where: string;
  body: string;
  example: string;
}> = [
  {
    title: "Nomor pesanan",
    where: "Shopee → Saya → Pesanan Saya → pilih pesanan → Detail Pesanan",
    body: "Nomor ini tertulis di bagian paling atas detail pesanan, di bawah nama toko. Bentuknya huruf dan angka, biasanya 13 sampai 16 karakter, dan selalu diawali tanggal pesanan.",
    example: "260101REV0001",
  },
  {
    title: "Username Shopee",
    where: "Shopee → Saya → ketuk foto profil di kiri atas",
    body: "Username tampil tepat di bawah nama Anda, tanpa tanda @. Ini username akun yang dipakai saat memesan, bukan nama penerima di alamat pengiriman.",
    example: "rina_kurnia",
  },
  {
    title: "4 digit terakhir nomor HP",
    where: "Detail Pesanan → Alamat Pengiriman",
    body: "Nomor HP di alamat pengiriman ditampilkan tersamar, hanya empat digit terakhir yang terlihat. Itulah empat digit yang diminta portal. Kalau nomor itu sudah tidak aktif, pakai username saja.",
    example: "2250",
  },
];

export default function HelpPage() {
  return (
    <main className="relative min-h-dvh bg-canvas">
      <div className="relative mx-auto w-full max-w-2xl px-4 pt-6 pb-[calc(env(safe-area-inset-bottom)+3rem)] sm:px-6 sm:py-10">
        <div className="mb-6 flex items-center justify-between">
          <Link
            href="/"
            className="text-[13px] font-medium text-ink-600 underline decoration-line underline-offset-2 hover:text-ink-950"
          >
            ← Kembali ke portal klaim
          </Link>
          <span className="text-[11.5px] text-ink-500">claim.example.com</span>
        </div>

        <h1 className="text-[26px] font-semibold leading-tight tracking-tight text-ink-950">
          Cara melihat detail pesanan Shopee
        </h1>
        <p className="mt-2 text-[14px] leading-relaxed text-ink-600">
          Portal klaim meminta tiga hal supaya produk tidak bisa diambil orang
          lain. Semuanya ada di aplikasi Shopee Anda, tidak perlu menghubungi
          penjual.
        </p>

        <div className="mt-6 space-y-3">
          {steps.map((step, index) => (
            <section
              key={step.title}
              className="rounded-2xl bg-surface p-4 shadow-card ring-1 ring-line sm:p-5"
            >
              <div className="flex items-start gap-3">
                <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-700 text-[12.5px] font-semibold text-white">
                  {index + 1}
                </span>
                <div className="min-w-0">
                  <h2 className="text-[15px] font-semibold text-ink-950">
                    {step.title}
                  </h2>
                  <p className="mt-1 text-[12.5px] font-medium text-brand-800">
                    {step.where}
                  </p>
                  <p className="mt-1.5 text-[13px] leading-relaxed text-ink-600">
                    {step.body}
                  </p>
                  <p className="mt-2 inline-block rounded-lg bg-canvas px-2.5 py-1 font-mono text-[12.5px] text-ink-800 ring-1 ring-inset ring-line">
                    contoh: {step.example}
                  </p>
                </div>
              </div>
            </section>
          ))}
        </div>

        <section className="mt-6 rounded-2xl bg-surface p-4 shadow-card ring-1 ring-line sm:p-5">
          <h2 className="text-[15px] font-semibold text-ink-950">
            Kalau lupa salah satunya
          </h2>
          <ul className="mt-2 space-y-2 text-[13px] leading-relaxed text-ink-600">
            <li>
              <strong className="font-medium text-ink-800">
                Cukup salah satu.
              </strong>{" "}
              Portal menerima username, atau 4 digit terakhir nomor HP. Tidak
              harus dua-duanya.
            </li>
            <li>
              <strong className="font-medium text-ink-800">
                Nomor HP sudah tidak aktif?
              </strong>{" "}
              Pakai username. Nomor yang tercatat di pesanan tetap nomor lama,
              jadi jangan bingung kalau nomor Anda sekarang berbeda.
            </li>
            <li>
              <strong className="font-medium text-ink-800">
                Lupa dua-duanya?
              </strong>{" "}
              Kirim nomor pesanan dan bukti pembelian ke{" "}
              <a
                className="underline decoration-line underline-offset-2 hover:text-ink-950"
                href="mailto:support@example.com"
              >
                support@example.com
              </a>
              . Kami cocokkan manual, biasanya di hari yang sama.
            </li>
          </ul>
        </section>

        <section className="mt-6 rounded-2xl bg-surface p-4 shadow-card ring-1 ring-line sm:p-5">
          <h2 className="text-[15px] font-semibold text-ink-950">
            Yang tidak pernah kami minta
          </h2>
          <ul className="mt-2 space-y-1.5 text-[13px] leading-relaxed text-ink-600">
            <li>
              Kata sandi Shopee, PIN, atau kode OTP. Portal ini tidak punya
              kolom untuk itu.
            </li>
            <li>
              Nomor HP lengkap. Kami hanya mencocokkan empat digit terakhir.
            </li>
            <li>Nomor kartu, rekening, atau bukti transfer lewat chat.</li>
          </ul>
          <p className="mt-3 text-[12px] leading-relaxed text-ink-500">
            Alamat resmi portal ini hanya claim.example.com. Tautan lain yang
            mengaku portal klaim Serah Terima bukan milik kami.
          </p>
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
