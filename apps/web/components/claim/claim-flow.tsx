"use client";

import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowRight,
  BadgeCheck,
  Copy,
  Download,
  ExternalLink,
  FileText,
  HardDrive,
  KeyRound,
  LifeBuoy,
  Loader2,
  Lock,
  PackageCheck,
  ShieldCheck,
  Sparkles,
  Terminal,
} from "lucide-react";
import Link from "next/link";
import { ApiError, api } from "@/lib/api";
import { DELIVERY_KIND, fileSize } from "@/lib/format";
import { useToast } from "@/components/ui";

/**
 * The buyer journey, in one component: enter the order, prove it is yours, see
 * what you bought, open it. The component never sees a secret before the API
 * decides the claim is valid, and it never caches one after the session ends.
 */

interface PublicConfig {
  branding: {
    brandName: string;
    tagline: string;
    supportEmail: string;
    supportWhatsapp: string;
    claimDomain: string;
  };
  claim: { sessionMinutes: number };
  gatewayMode: "live" | "fixture";
}

interface SessionView {
  orderSn: string;
  buyerUsernameMasked: string | null;
  storeLabel: string;
  storeBrandName: string | null;
  orderState: string;
  expiresAt: string;
  items: Array<{
    fulfillmentId: string;
    productName: string;
    productDescription: string | null;
    instructions: string | null;
    deliveryKind:
      "DRIVE" | "FILE" | "LINK" | "CODE" | "CREDENTIALS" | "INSTRUCTIONS";
    quantity: number;
    status: string;
    claimDeadline: string | null;
    deliveriesLeft: number;
    claimedAt: string | null;
  }>;
}

type Delivery =
  | {
      kind: "FILE";
      fileName: string;
      sizeBytes: number;
      url: string;
      expiresAt: string;
      instructions: string | null;
    }
  | {
      kind: "LINK";
      url: string;
      /** One entry per stamp; a five-meterai order arrives as five links. */
      links?: string[];
      instructions: string | null;
    }
  | { kind: "CODE"; code: string; instructions: string | null }
  | {
      kind: "CREDENTIALS";
      username: string;
      password: string;
      instructions: string | null;
    }
  | { kind: "INSTRUCTIONS"; instructions: string | null };

const kindIcon = {
  DRIVE: HardDrive,
  FILE: Download,
  LINK: ExternalLink,
  CODE: KeyRound,
  CREDENTIALS: Lock,
  INSTRUCTIONS: FileText,
} as const;

const errorTone = (code: string): "danger" | "warning" => {
  if (["TOO_MANY_ATTEMPTS", "RATE_LIMITED"].includes(code)) return "warning";
  return "danger";
};

export function ClaimFlow({ config }: { config: PublicConfig | null }) {
  const { toast } = useToast();
  const [step, setStep] = useState<"form" | "session">("form");
  const [orderSn, setOrderSn] = useState("");
  const [username, setUsername] = useState("");
  const [phoneSuffix, setPhoneSuffix] = useState("");
  const [session, setSession] = useState<SessionView | null>(null);
  const [deliveries, setDeliveries] = useState<Record<string, Delivery>>({});
  const [busy, setBusy] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(
    null,
  );
  const [manualOpen, setManualOpen] = useState(false);
  const [manualContact, setManualContact] = useState("");
  const [manualNote, setManualNote] = useState("");
  const [manualState, setManualState] = useState<
    "idle" | "sending" | "sent" | "failed"
  >("idle");
  const [manualMessage, setManualMessage] = useState<string | null>(null);

  const branding = config?.branding;
  const brandName = branding?.brandName ?? "Serah Terima";

  const loadSession = useCallback(async () => {
    try {
      const view = await api.get<SessionView>("/claim/session");
      setSession(view);
      setStep("session");
    } catch {
      setStep("form");
    }
  }, []);

  useEffect(() => {
    void loadSession();
  }, [loadSession]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      await api.post("/claim/verify", {
        orderSn: orderSn.trim(),
        buyerUsername: username.trim() || undefined,
        phoneSuffix: phoneSuffix.trim() || undefined,
      });
      await loadSession();
    } catch (caught) {
      if (caught instanceof ApiError)
        setError({ code: caught.code, message: caught.message });
      else
        setError({
          code: "NETWORK",
          message: "Tidak dapat menghubungi server. Periksa koneksi Anda.",
        });
    } finally {
      setBusy(false);
    }
  };

  /**
   * Shopee sometimes returns no phone at all. When the automatic factors cannot
   * be met, the buyer can ask an operator to check the order out of band instead
   * of being stuck with no path forward.
   */
  const requestManualReview = async (event: React.FormEvent) => {
    event.preventDefault();
    setManualState("sending");
    setManualMessage(null);
    try {
      const result = await api.post<{ message: string }>("/claim/request", {
        orderSn: orderSn.trim(),
        buyerUsername: username.trim(),
        contact: manualContact.trim(),
        ...(manualNote.trim() ? { note: manualNote.trim() } : {}),
      });
      setManualState("sent");
      setManualMessage(result.message);
    } catch (caught) {
      setManualState("failed");
      setManualMessage(
        caught instanceof ApiError
          ? caught.message
          : "Permintaan tidak terkirim. Coba lagi nanti.",
      );
    }
  };

  const reveal = async (item: SessionView["items"][number]) => {
    setOpening(item.fulfillmentId);
    try {
      const result = await api.post<{ delivery: Delivery }>(
        `/claim/fulfillments/${item.fulfillmentId}/access`,
      );
      setDeliveries((current) => ({
        ...current,
        [item.fulfillmentId]: result.delivery,
      }));
    } catch (caught) {
      if (caught instanceof ApiError) {
        if (caught.status === 401) {
          setStep("form");
          setSession(null);
        }
        toast({
          title: "Produk belum bisa dibuka",
          description: caught.message,
          tone: "danger",
        });
      }
    } finally {
      setOpening(null);
    }
  };

  const copy = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast({ title: `${label} disalin`, tone: "success" });
    } catch {
      toast({
        title: "Tidak bisa menyalin otomatis",
        description: "Pilih teks lalu salin manual.",
        tone: "warning",
      });
    }
  };

  return (
    <div className="mx-auto w-full max-w-[520px]">
      <AnimatePresence mode="wait">
        {step === "form" ? (
          <motion.div
            key="form"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.22, ease: "easeOut" }}
          >
            <div className="mb-6 text-center">
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-700 text-white shadow-card">
                <PackageCheck className="h-6 w-6" />
              </div>
              <h1 className="text-[26px] font-semibold leading-tight text-ink-950">
                Ambil produk digital Anda
              </h1>
              <p className="mx-auto mt-2 max-w-sm text-[13.5px] leading-relaxed text-ink-500">
                {branding?.tagline ??
                  "Masukkan nomor pesanan Shopee. Produk langsung tersedia, tanpa menunggu admin."}
              </p>
            </div>

            <form
              onSubmit={submit}
              className="rounded-2xl bg-surface p-5 shadow-card ring-1 ring-line sm:p-6"
            >
              <div className="space-y-4">
                <div>
                  <label
                    htmlFor="orderSn"
                    className="mb-1.5 flex items-baseline justify-between text-[13px] font-medium text-ink-700"
                  >
                    <span>Nomor pesanan Shopee</span>
                  </label>
                  <input
                    id="orderSn"
                    value={orderSn}
                    onChange={(event) =>
                      setOrderSn(
                        event.target.value
                          .toUpperCase()
                          .replace(/[^A-Z0-9]/g, ""),
                      )
                    }
                    placeholder="260101PXL0001"
                    autoComplete="off"
                    inputMode="text"
                    spellCheck={false}
                    maxLength={32}
                    required
                    className="h-12 w-full rounded-lg bg-canvas px-3.5 font-mono text-[15px] tracking-wide text-ink-950 shadow-sm ring-1 ring-inset ring-line placeholder:text-ink-500 focus:bg-surface focus:ring-2 focus:ring-brand-500"
                  />
                  <p className="mt-1.5 text-[11.5px] text-ink-500">
                    Ada di halaman Detail Pesanan Shopee, formatnya seperti
                    260101ABC1234.{" "}
                    <Link
                      href="/bantuan"
                      className="font-medium text-brand-800 underline decoration-line underline-offset-2 hover:text-ink-950"
                    >
                      Cara melihatnya
                    </Link>
                  </p>
                </div>

                <div>
                  <label
                    htmlFor="username"
                    className="mb-1.5 block text-[13px] font-medium text-ink-700"
                  >
                    Username Shopee Anda
                  </label>
                  <input
                    id="username"
                    value={username}
                    onChange={(event) => setUsername(event.target.value)}
                    placeholder="username pembeli"
                    autoComplete="username"
                    required
                    className="h-12 w-full rounded-lg bg-canvas px-3.5 text-[15px] text-ink-950 shadow-sm ring-1 ring-inset ring-line placeholder:text-ink-500 focus:bg-surface focus:ring-2 focus:ring-brand-500"
                  />
                  <p className="mt-1.5 text-[11.5px] text-ink-500">
                    Cukup salah satu: username atau 4 digit terakhir nomor HP
                    pada pesanan. Kami mencocokkannya dengan data pembeli,
                    supaya produk tidak bisa diambil orang lain.
                  </p>
                </div>

                <div>
                  <label
                    htmlFor="phone"
                    className="mb-1.5 flex items-baseline justify-between text-[13px] font-medium text-ink-700"
                  >
                    <span>4 digit terakhir nomor HP</span>
                    <span className="text-[11px] font-normal text-ink-500">
                      kalau username lupa
                    </span>
                  </label>
                  {/* Exactly the four digits the label promises. Six was allowed before and
                      it was a trap: Shopee masks all but the last four, so a buyer who typed
                      six could never match, and the field looked broken for no reason. */}
                  <input
                    id="phone"
                    value={phoneSuffix}
                    onChange={(event) =>
                      setPhoneSuffix(
                        event.target.value.replace(/\D/g, "").slice(0, 4),
                      )
                    }
                    maxLength={4}
                    placeholder="2250"
                    inputMode="numeric"
                    autoComplete="off"
                    className="h-12 w-full rounded-lg bg-canvas px-3.5 text-[15px] tracking-[0.2em] text-ink-950 shadow-sm ring-1 ring-inset ring-line placeholder:tracking-normal placeholder:text-ink-500 focus:bg-surface focus:ring-2 focus:ring-brand-500"
                  />
                </div>
              </div>

              <AnimatePresence>
                {error ? (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    className="overflow-hidden"
                  >
                    <div
                      className={`mt-4 rounded-lg px-3.5 py-3 text-[12.5px] leading-relaxed ring-1 ring-inset ${
                        errorTone(error.code) === "warning"
                          ? "bg-amber-100/70 text-amber-600 ring-amber-600/20"
                          : "bg-rose-100/70 text-rose-700 ring-rose-700/20"
                      }`}
                      role="alert"
                    >
                      {error.message}
                    </div>
                  </motion.div>
                ) : null}
              </AnimatePresence>

              {error && /^PHONE_|^ORDER_NOT_CLAIMABLE$/.test(error.code) ? (
                <div className="mt-4 rounded-xl bg-canvas p-4 ring-1 ring-inset ring-line">
                  {manualState === "sent" ? (
                    <p className="text-[12.5px] leading-relaxed text-ink-700">
                      <span className="font-medium text-brand-800">
                        Permintaan terkirim.
                      </span>{" "}
                      {manualMessage}
                    </p>
                  ) : manualOpen ? (
                    <form onSubmit={requestManualReview} className="space-y-3">
                      <p className="text-[12.5px] leading-relaxed text-ink-600">
                        Tuliskan kontak yang bisa kami hubungi untuk mencocokkan
                        pesanan Anda. Tim kami memeriksa manual, biasanya di
                        hari yang sama.
                      </p>
                      <input
                        required
                        value={manualContact}
                        onChange={(event) =>
                          setManualContact(event.target.value)
                        }
                        placeholder="Email atau nomor WhatsApp"
                        className="h-11 w-full rounded-lg bg-surface px-3.5 text-[14px] text-ink-950 shadow-sm ring-1 ring-inset ring-line placeholder:text-ink-500 focus:ring-2 focus:ring-brand-500"
                      />
                      <textarea
                        value={manualNote}
                        onChange={(event) => setManualNote(event.target.value)}
                        placeholder="Catatan tambahan (opsional)"
                        rows={2}
                        className="w-full rounded-lg bg-surface px-3.5 py-2.5 text-[14px] text-ink-950 shadow-sm ring-1 ring-inset ring-line placeholder:text-ink-500 focus:ring-2 focus:ring-brand-500"
                      />
                      {manualMessage ? (
                        <p className="text-[12px] text-rose-700">
                          {manualMessage}
                        </p>
                      ) : null}
                      <button
                        type="submit"
                        disabled={
                          manualState === "sending" ||
                          manualContact.trim().length < 5
                        }
                        className="flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-ink-950 text-[13.5px] font-medium text-white transition-colors hover:bg-ink-800 disabled:opacity-40"
                      >
                        {manualState === "sending" ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : null}
                        Kirim permintaan verifikasi
                      </button>
                    </form>
                  ) : (
                    <div className="flex items-start justify-between gap-3">
                      <p className="text-[12.5px] leading-relaxed text-ink-600">
                        Tidak bisa memenuhi verifikasi otomatis? Minta
                        pemeriksaan manual.
                      </p>
                      <button
                        type="button"
                        onClick={() => setManualOpen(true)}
                        className="shrink-0 rounded-lg bg-surface px-3 py-2 text-[12.5px] font-medium text-brand-700 ring-1 ring-inset ring-line hover:bg-brand-50"
                      >
                        Minta bantuan
                      </button>
                    </div>
                  )}
                </div>
              ) : null}

              <button
                type="submit"
                disabled={
                  busy ||
                  orderSn.length < 6 ||
                  (username.trim().length < 2 &&
                    phoneSuffix.replace(/\D/g, "").length < 4)
                }
                className="mt-5 flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-brand-700 text-[15px] font-medium text-white transition-colors hover:bg-brand-800 disabled:cursor-not-allowed disabled:border disabled:border-dashed disabled:border-ink-300 disabled:bg-surface disabled:text-ink-500"
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {busy ? "Memeriksa pesanan" : "Klaim produk saya"}
                {!busy ? <ArrowRight className="h-4 w-4" /> : null}
              </button>

              {!busy &&
              (orderSn.length < 6 ||
                (username.trim().length < 2 &&
                  phoneSuffix.replace(/\D/g, "").length < 4)) ? (
                <p className="mt-2 text-center text-[11.5px] text-ink-500">
                  Isi nomor pesanan, lalu username atau 4 digit terakhir nomor
                  HP.
                </p>
              ) : null}

              <div className="mt-4 flex items-center justify-center gap-4 text-[11.5px] text-ink-500">
                <span className="inline-flex items-center gap-1.5">
                  <ShieldCheck className="h-3.5 w-3.5 text-brand-600" />{" "}
                  Verifikasi dua langkah
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <Lock className="h-3.5 w-3.5 text-brand-600" /> Tanpa kata
                  sandi
                </span>
              </div>
            </form>

            <SupportBlock branding={branding} />
          </motion.div>
        ) : (
          <motion.div
            key="session"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.22 }}
          >
            <div className="mb-5 flex items-start justify-between gap-3">
              <div>
                <div className="mb-2 inline-flex items-center gap-1.5 rounded-full bg-brand-100 px-2.5 py-1 text-[11.5px] font-medium text-brand-800">
                  <BadgeCheck className="h-3.5 w-3.5" /> Terverifikasi
                </div>
                <h1 className="text-[22px] font-semibold leading-tight text-ink-950">
                  Produk Anda
                </h1>
                <p className="mt-1 font-mono text-[12.5px] text-ink-500">
                  {session?.orderSn}
                </p>
              </div>
              <button
                onClick={() => {
                  void api.post("/claim/logout").catch(() => undefined);
                  setStep("form");
                  setSession(null);
                  setDeliveries({});
                  setOrderSn("");
                  setUsername("");
                  setPhoneSuffix("");
                }}
                className="mt-1 rounded-lg px-2.5 py-1.5 text-[12px] text-ink-500 ring-1 ring-inset ring-line hover:bg-surface"
              >
                Keluar
              </button>
            </div>

            <div className="space-y-3">
              {session?.items.map((item, index) => {
                const delivery = deliveries[item.fulfillmentId];
                const Icon = kindIcon[item.deliveryKind];
                const disabled =
                  item.status === "REVOKED" ||
                  item.status === "EXPIRED" ||
                  item.status === "PENDING";

                return (
                  <motion.div
                    key={item.fulfillmentId}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.05 * index, duration: 0.2 }}
                    className="overflow-hidden rounded-2xl bg-surface shadow-card ring-1 ring-line"
                  >
                    <div className="flex items-start gap-3 p-4 sm:p-5">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-700 ring-1 ring-inset ring-brand-100">
                        <Icon className="h-5 w-5" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-2">
                          <h2 className="text-[14.5px] font-semibold leading-snug text-ink-950">
                            {item.productName}
                          </h2>
                          <span className="shrink-0 rounded-full bg-canvas px-2 py-0.5 text-[11px] font-medium text-ink-500 ring-1 ring-inset ring-line">
                            {item.quantity}×
                          </span>
                        </div>
                        <p className="mt-0.5 text-[12px] text-ink-400">
                          {DELIVERY_KIND[item.deliveryKind]}
                        </p>
                        {item.productDescription ? (
                          <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-600">
                            {item.productDescription}
                          </p>
                        ) : null}
                      </div>
                    </div>

                    <div className="border-t border-line bg-canvas/60 px-4 py-3.5 sm:px-5">
                      {disabled ? (
                        <p className="text-[12.5px] text-ink-500">
                          {item.status === "PENDING"
                            ? "Produk sedang disiapkan penjual. Coba lagi beberapa saat lagi."
                            : "Akses produk ini sudah tidak aktif. Hubungi dukungan bila menurut Anda ini keliru."}
                        </p>
                      ) : item.deliveryKind === "DRIVE" ? (
                        <DriveClaim
                          fulfillmentId={item.fulfillmentId}
                          instructions={item.instructions}
                        />
                      ) : delivery ? (
                        <DeliveryView delivery={delivery} onCopy={copy} />
                      ) : (
                        <button
                          onClick={() => void reveal(item)}
                          disabled={opening === item.fulfillmentId}
                          className="flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-brand-700 text-[14px] font-medium text-white transition-colors hover:bg-brand-800 disabled:opacity-60"
                        >
                          {opening === item.fulfillmentId ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Sparkles className="h-4 w-4" />
                          )}
                          {item.claimedAt
                            ? "Buka lagi produk"
                            : "Buka produk sekarang"}
                        </button>
                      )}
                      {!disabled && item.deliveriesLeft <= 1 && !delivery ? (
                        <p className="mt-2 text-center text-[11px] text-ink-400">
                          Sisa {item.deliveriesLeft} kali pengambilan
                        </p>
                      ) : null}
                    </div>
                  </motion.div>
                );
              })}
            </div>

            <div className="mt-4 rounded-xl bg-surface/70 px-4 py-3 text-[12px] leading-relaxed text-ink-500 ring-1 ring-line">
              <p className="flex items-start gap-2">
                <Terminal className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-400" />
                Simpan kode atau berkas Anda sekarang. Tautan unduhan bersifat
                sementara, dan sesi ini berakhir otomatis dalam{" "}
                {config?.claim.sessionMinutes ?? 30} menit.
              </p>
            </div>

            <SupportBlock branding={branding} />
          </motion.div>
        )}
      </AnimatePresence>

      {config?.gatewayMode === "fixture" ? (
        <p className="mt-8 text-center text-[11px] text-ink-500">
          Lingkungan demonstrasi: data toko berasal dari fixture, bukan dari
          Shopee.
        </p>
      ) : null}

      <p className="mt-6 text-center text-[11px] text-ink-500">
        {brandName} · Portal klaim resmi · Tidak pernah meminta kata sandi
        Shopee
      </p>
    </div>
  );
}

/**
 * A Drive product is delivered by sharing the file with the buyer's Google account, so
 * this asks for the address twice before anything is shared. After a successful share the
 * buyer can see which address got it, and fix a typo while the window is still open.
 */
function DriveClaim({
  fulfillmentId,
  instructions,
}: {
  fulfillmentId: string;
  instructions: string | null;
}) {
  const { toast } = useToast();
  const [email, setEmail] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{
    maskedEmail: string;
    fixUntil: string | null;
  } | null>(null);
  const [fixing, setFixing] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<{
        maskedEmail: string;
        fixUntil: string | null;
      }>(`/claim/fulfillments/${fulfillmentId}/drive`, {
        email,
        emailConfirm: confirm,
      });
      setDone({ maskedEmail: result.maskedEmail, fixUntil: result.fixUntil });
      setFixing(false);
      setEmail("");
      setConfirm("");
      toast({
        title: "File dibagikan",
        description: `Dikirim ke ${result.maskedEmail}`,
      });
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : "Gagal membagikan file. Coba lagi.",
      );
    } finally {
      setBusy(false);
    }
  };

  if (done && !fixing) {
    return (
      <div className="space-y-2">
        <div className="rounded-lg bg-emerald-50 px-3 py-2.5 ring-1 ring-inset ring-emerald-200">
          <p className="text-[12.5px] font-medium text-emerald-900">
            File dibagikan ke {done.maskedEmail}
          </p>
          <p className="mt-0.5 text-[11.5px] leading-relaxed text-emerald-800">
            Buka Google Drive akun itu, lalu lihat menu "Dibagikan kepada saya".
            Email dari Google juga dikirim ke alamat tersebut.
          </p>
        </div>
        {done.fixUntil ? (
          <button
            onClick={() => setFixing(true)}
            className="text-[12px] text-ink-500 underline underline-offset-2 hover:text-ink-800"
          >
            Alamatnya salah, saya mau perbaiki
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-[12.5px] leading-relaxed text-ink-600">
        Masukkan alamat Gmail yang ingin dipakai menerima file ini. Tulis dua
        kali supaya tidak salah kirim.
      </p>
      <input
        type="email"
        inputMode="email"
        autoComplete="email"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        placeholder="nama@gmail.com"
        className="h-11 w-full rounded-lg bg-surface px-3 text-[14px] text-ink-950 ring-1 ring-inset ring-line focus:outline-none focus:ring-2 focus:ring-brand-300"
      />
      <input
        type="email"
        inputMode="email"
        autoComplete="off"
        value={confirm}
        onChange={(event) => setConfirm(event.target.value)}
        placeholder="ulangi nama@gmail.com"
        className="h-11 w-full rounded-lg bg-surface px-3 text-[14px] text-ink-950 ring-1 ring-inset ring-line focus:outline-none focus:ring-2 focus:ring-brand-300"
      />
      {error ? <p className="text-[12px] text-rose-700">{error}</p> : null}
      <button
        onClick={() => void submit()}
        disabled={
          busy || !email || email.toLowerCase() !== confirm.toLowerCase()
        }
        className="flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-brand-700 text-[14px] font-medium text-white transition-colors hover:bg-brand-800 disabled:opacity-60"
      >
        {busy ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <HardDrive className="h-4 w-4" />
        )}
        Bagikan ke akun Google saya
      </button>
      {instructions ? (
        <p className="text-[11.5px] leading-relaxed text-ink-400">
          {instructions}
        </p>
      ) : null}
    </div>
  );
}

function DeliveryView({
  delivery,
  onCopy,
}: {
  delivery: Delivery;
  onCopy: (value: string, label: string) => void;
}) {
  if (delivery.kind === "CODE") {
    return (
      <div>
        <p className="mb-1.5 text-[11.5px] font-medium uppercase tracking-wide text-ink-400">
          Kode aktivasi
        </p>
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-lg bg-surface px-3 py-2.5 font-mono text-[13.5px] text-ink-950 ring-1 ring-inset ring-line">
            {delivery.code}
          </code>
          <button
            onClick={() => onCopy(delivery.code, "Kode")}
            className="flex h-10 w-10 items-center justify-center rounded-lg bg-surface text-ink-600 ring-1 ring-inset ring-line hover:bg-canvas"
            aria-label="Salin kode"
          >
            <Copy className="h-4 w-4" />
          </button>
        </div>
        {delivery.instructions ? (
          <p className="mt-2 text-[12px] leading-relaxed text-ink-500">
            {delivery.instructions}
          </p>
        ) : null}
      </div>
    );
  }

  if (delivery.kind === "CREDENTIALS") {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2 rounded-lg bg-surface px-3 py-2 ring-1 ring-inset ring-line">
          <span className="w-20 shrink-0 text-[11.5px] text-ink-500">
            Username
          </span>
          <code className="min-w-0 flex-1 truncate font-mono text-[13px] text-ink-950">
            {delivery.username}
          </code>
          <button
            onClick={() => onCopy(delivery.username, "Username")}
            className="text-ink-400 hover:text-ink-800"
            aria-label="Salin username"
          >
            <Copy className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="flex items-center gap-2 rounded-lg bg-surface px-3 py-2 ring-1 ring-inset ring-line">
          <span className="w-20 shrink-0 text-[11.5px] text-ink-500">
            Password
          </span>
          <code className="min-w-0 flex-1 truncate font-mono text-[13px] text-ink-950">
            {delivery.password}
          </code>
          <button
            onClick={() => onCopy(delivery.password, "Password")}
            className="text-ink-400 hover:text-ink-800"
            aria-label="Salin password"
          >
            <Copy className="h-3.5 w-3.5" />
          </button>
        </div>
        {delivery.instructions ? (
          <p className="text-[12px] leading-relaxed text-ink-500">
            {delivery.instructions}
          </p>
        ) : null}
      </div>
    );
  }

  if (delivery.kind === "LINK") {
    const links = delivery.links?.length ? delivery.links : [delivery.url];
    return (
      <div>
        {links.length > 1 ? (
          <>
            <p className="mb-1.5 text-[11.5px] font-medium uppercase tracking-wide text-ink-400">
              {links.length} tautan meterai
            </p>
            <div className="space-y-2">
              {links.map((url, index) => (
                <div key={url} className="flex items-center gap-2">
                  <a
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    className="flex h-10 min-w-0 flex-1 items-center justify-center gap-2 rounded-lg bg-brand-700 text-[13px] font-medium text-white hover:bg-brand-800"
                  >
                    <ExternalLink className="h-4 w-4" /> Meterai {index + 1}
                  </a>
                  <button
                    type="button"
                    onClick={() => onCopy(url, `Tautan meterai ${index + 1}`)}
                    aria-label={`Salin tautan meterai ${index + 1}`}
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-ink-600 ring-1 ring-inset ring-line hover:bg-canvas"
                  >
                    <Copy className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
            <p className="mt-2 text-center text-[11.5px] text-ink-500">
              Satu tautan untuk satu meterai. Jangan dibagikan.
            </p>
          </>
        ) : (
          <a
            href={links[0]}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-brand-700 text-[14px] font-medium text-white hover:bg-brand-800"
          >
            <ExternalLink className="h-4 w-4" /> Buka akses produk
          </a>
        )}
        {delivery.instructions ? (
          <p className="mt-2 text-[12px] leading-relaxed text-ink-500">
            {delivery.instructions}
          </p>
        ) : null}
      </div>
    );
  }

  if (delivery.kind === "FILE") {
    return (
      <div>
        <a
          href={delivery.url}
          className="flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-brand-700 text-[14px] font-medium text-white hover:bg-brand-800"
        >
          <Download className="h-4 w-4" /> Unduh {delivery.fileName}
        </a>
        <p className="mt-2 text-center text-[11px] text-ink-400">
          {fileSize(delivery.sizeBytes)} · tautan berlaku sampai{" "}
          {new Date(delivery.expiresAt).toLocaleTimeString("id-ID", {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </p>
        {delivery.instructions ? (
          <p className="mt-1.5 text-[12px] leading-relaxed text-ink-500">
            {delivery.instructions}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="prose prose-sm max-w-none text-[12.5px] leading-relaxed text-ink-600">
      <p className="whitespace-pre-line">
        {delivery.instructions || "Instruksi belum tersedia. Hubungi dukungan."}
      </p>
    </div>
  );
}

function SupportBlock({ branding }: { branding?: PublicConfig["branding"] }) {
  // No invented address: if the shop has not set one, the mail link is simply not offered.
  const email = branding?.supportEmail?.trim() ?? "";
  const whatsapp = branding?.supportWhatsapp?.trim() ?? "";

  return (
    <div className="mt-5 flex flex-col items-center justify-center gap-2 text-[12px] text-ink-400 sm:flex-row sm:gap-4">
      <span className="inline-flex items-center gap-1.5">
        <LifeBuoy className="h-3.5 w-3.5" /> Butuh bantuan?
      </span>
      {email ? (
        <a
          href={`mailto:${email}`}
          className="text-ink-600 underline decoration-line underline-offset-2 hover:text-ink-950"
        >
          {email}
        </a>
      ) : null}
      {whatsapp ? (
        <a
          href={`https://wa.me/${whatsapp.replace(/[^0-9]/g, "")}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-ink-600 underline decoration-line underline-offset-2 hover:text-ink-950"
        >
          WhatsApp
        </a>
      ) : null}
    </div>
  );
}
