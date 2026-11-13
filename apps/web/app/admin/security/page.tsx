"use client";

import { useState } from "react";
import {
  AlertTriangle,
  Copy,
  Database,
  KeyRound,
  RefreshCw,
  Send,
  ShieldCheck,
  ShieldOff,
} from "lucide-react";
import { ApiError, api } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { useAuth } from "@/lib/auth";
import { SectionCard } from "@/components/admin/kit";
import {
  Alert,
  Badge,
  Button,
  Field,
  Input,
  PageHeader,
  useToast,
} from "@/components/ui";
import { formatDateTime } from "@/lib/format";

interface TwoFactorStatus {
  enabled: boolean;
  recoveryCodesRemaining: number;
}

interface ChainResult {
  valid: boolean;
  checked: number;
  unhashed: number;
  brokenAt: number | null;
  reason: string | null;
  window: { from: number | null; to: number | null; limit: number };
  checkedAt: string;
}

interface RetentionCounts {
  claimSessions: number;
  sessions: number;
  loginChallenges: number;
  webhookEvents: number;
  jobs: number;
  expiredClaimRequests: number;
}

/**
 * Security operations in one place: the operator's own second factor, the
 * integrity of the audit trail, retention, key rotation and the notification
 * webhook. Everything here is one click away from a written runbook step so it
 * does not live only in someone's memory.
 */
export default function SecurityPage() {
  const { can } = useAuth();
  const { toast } = useToast();
  const twoFactor = useApi<TwoFactorStatus>("/auth/2fa");

  const [enrollment, setEnrollment] = useState<{
    secret: string;
    otpauth: string;
  } | null>(null);
  const [confirmCode, setConfirmCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [disablePassword, setDisablePassword] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const [chain, setChain] = useState<ChainResult | null>(null);
  const [retention, setRetention] = useState<RetentionCounts | null>(null);
  const [rotation, setRotation] = useState<{
    dryRun: boolean;
    counts: string;
  } | null>(null);

  const fail = (title: string) => (caught: unknown) =>
    toast({
      title,
      description: caught instanceof ApiError ? caught.message : "Coba lagi.",
      tone: "danger",
    });

  const startEnrollment = async () => {
    setBusy("enroll");
    try {
      const result = await api.post<{ secret: string; otpauth: string }>(
        "/auth/2fa/enroll",
      );
      setEnrollment(result);
      setRecoveryCodes(null);
    } catch (caught) {
      fail("Tidak bisa memulai 2FA")(caught);
    } finally {
      setBusy(null);
    }
  };

  const confirmEnrollment = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy("confirm");
    try {
      const result = await api.post<{ recoveryCodes: string[] }>(
        "/auth/2fa/enroll/confirm",
        { token: confirmCode.trim() },
      );
      setRecoveryCodes(result.recoveryCodes);
      setEnrollment(null);
      setConfirmCode("");
      twoFactor.refresh();
      toast({
        title: "2FA aktif",
        description: "Simpan kode pemulihan di tempat aman.",
        tone: "success",
      });
    } catch (caught) {
      fail("Kode tidak diterima")(caught);
    } finally {
      setBusy(null);
    }
  };

  const disable = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy("disable");
    try {
      await api.post("/auth/2fa/disable", { password: disablePassword });
      setDisablePassword("");
      twoFactor.refresh();
      toast({ title: "2FA dinonaktifkan", tone: "neutral" });
    } catch (caught) {
      fail("Tidak bisa menonaktifkan 2FA")(caught);
    } finally {
      setBusy(null);
    }
  };

  const verifyChain = async () => {
    setBusy("chain");
    try {
      setChain(
        await api.get<ChainResult>("/admin/security/audit-chain?limit=5000"),
      );
    } catch (caught) {
      fail("Gagal memeriksa audit log")(caught);
    } finally {
      setBusy(null);
    }
  };

  const previewRetention = async () => {
    setBusy("retention-preview");
    try {
      const result = await api.get<{ preview: RetentionCounts }>(
        "/admin/security/retention",
      );
      setRetention(result.preview);
    } catch (caught) {
      fail("Gagal menghitung retensi")(caught);
    } finally {
      setBusy(null);
    }
  };

  const runRetention = async () => {
    setBusy("retention-run");
    try {
      const result = await api.post<{ counts: RetentionCounts }>(
        "/admin/security/retention",
        { confirm: "HAPUS" },
      );
      setRetention(result.counts);
      toast({
        title: "Pembersihan selesai",
        description: "Baris operasional lama dihapus, data pesanan tetap utuh.",
        tone: "success",
      });
    } catch (caught) {
      fail("Gagal membersihkan data")(caught);
    } finally {
      setBusy(null);
    }
  };

  const dryRunRotation = async () => {
    setBusy("rotate");
    try {
      const result = await api.post<{
        shopeeTokens: number;
        activationCodes: number;
        totpSecrets: number;
        dryRun: boolean;
      }>("/admin/security/rotate-key", {
        confirm: "ROTASI",
        dryRun: true,
      });
      setRotation({
        dryRun: result.dryRun,
        counts: `${result.shopeeTokens} token toko, ${result.activationCodes} kode aktivasi, ${result.totpSecrets} secret 2FA`,
      });
    } catch (caught) {
      fail("Uji rotasi gagal")(caught);
    } finally {
      setBusy(null);
    }
  };

  const testNotification = async () => {
    setBusy("notify");
    try {
      const result = await api.post<{ delivered: boolean; reason?: string }>(
        "/admin/security/notify-test",
        {},
      );
      toast({
        title: result.delivered
          ? "Notifikasi terkirim"
          : "Notifikasi tidak terkirim",
        description: result.delivered
          ? "Webhook menjawab 2xx."
          : `Alasan: ${result.reason ?? "tidak diketahui"}`,
        tone: result.delivered ? "success" : "warning",
      });
    } catch (caught) {
      fail("Gagal menguji notifikasi")(caught);
    } finally {
      setBusy(null);
    }
  };

  const copy = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast({ title: `${label} disalin`, tone: "success" });
    } catch {
      toast({ title: "Tidak bisa menyalin otomatis", tone: "warning" });
    }
  };

  return (
    <>
      <PageHeader
        title="Keamanan"
        description="Faktor kedua untuk akun Anda, dan alat operasional untuk menjaga data serta kunci enkripsi."
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard
          title="Autentikasi dua faktor"
          description="Kode 6 digit dari aplikasi authenticator. Disarankan untuk semua akun konsol."
          action={
            twoFactor.data?.enabled ? (
              <Badge tone="success" dot>
                Aktif
              </Badge>
            ) : (
              <Badge tone="warning" dot>
                Belum aktif
              </Badge>
            )
          }
        >
          {recoveryCodes ? (
            <div className="space-y-3">
              <Alert tone="warning" title="Simpan kode pemulihan sekarang">
                Ditampilkan sekali. Setiap kode hanya bisa dipakai satu kali
                jika aplikasi authenticator Anda hilang.
              </Alert>
              <div className="grid grid-cols-2 gap-1.5 rounded-lg bg-canvas p-3 font-mono text-[12.5px] text-ink-900 ring-1 ring-inset ring-line">
                {recoveryCodes.map((code) => (
                  <span key={code}>{code}</span>
                ))}
              </div>
              <Button
                variant="secondary"
                className="w-full"
                onClick={() =>
                  void copy(recoveryCodes.join("\n"), "Kode pemulihan")
                }
              >
                <Copy className="h-4 w-4" /> Salin semua
              </Button>
            </div>
          ) : twoFactor.data?.enabled ? (
            <div className="space-y-3">
              <p className="text-[12.5px] text-ink-600">
                Kode pemulihan tersisa:{" "}
                <span className="font-medium text-ink-900">
                  {twoFactor.data.recoveryCodesRemaining}
                </span>
              </p>
              <form onSubmit={disable} className="space-y-2">
                <Field
                  label="Nonaktifkan 2FA"
                  htmlFor="disable-password"
                  hint="Perlu kata sandi Anda sebagai konfirmasi"
                >
                  <Input
                    id="disable-password"
                    type="password"
                    value={disablePassword}
                    onChange={(event) => setDisablePassword(event.target.value)}
                    placeholder="••••••••••"
                  />
                </Field>
                <Button
                  type="submit"
                  variant="secondary"
                  loading={busy === "disable"}
                  disabled={disablePassword.length === 0}
                >
                  <ShieldOff className="h-4 w-4" /> Nonaktifkan
                </Button>
              </form>
            </div>
          ) : enrollment ? (
            <form onSubmit={confirmEnrollment} className="space-y-3">
              <p className="text-[12.5px] leading-relaxed text-ink-600">
                Masukkan secret ini ke aplikasi authenticator (Google
                Authenticator, Authy, 1Password) secara manual, lalu ketik kode
                yang muncul.
              </p>
              <div className="rounded-lg bg-canvas p-3 ring-1 ring-inset ring-line">
                <p className="text-[11px] uppercase tracking-wide text-ink-400">
                  Secret
                </p>
                <p className="break-all font-mono text-[13px] text-ink-950">
                  {enrollment.secret}
                </p>
              </div>
              <Button
                type="button"
                variant="secondary"
                className="w-full"
                onClick={() => void copy(enrollment.secret, "Secret")}
              >
                <Copy className="h-4 w-4" /> Salin secret
              </Button>
              <Field label="Kode verifikasi" htmlFor="confirm-code">
                <Input
                  id="confirm-code"
                  value={confirmCode}
                  onChange={(event) => setConfirmCode(event.target.value)}
                  placeholder="123456"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  className="tracking-[0.25em]"
                />
              </Field>
              <Button
                type="submit"
                className="w-full"
                loading={busy === "confirm"}
                disabled={confirmCode.trim().length < 6}
              >
                <ShieldCheck className="h-4 w-4" /> Aktifkan 2FA
              </Button>
            </form>
          ) : (
            <div className="space-y-3">
              <p className="text-[12.5px] leading-relaxed text-ink-600">
                Dengan 2FA aktif, kata sandi saja tidak cukup untuk membuka
                konsol: setiap login meminta kode dari aplikasi authenticator
                Anda.
              </p>
              <Button
                onClick={() => void startEnrollment()}
                loading={busy === "enroll"}
              >
                <KeyRound className="h-4 w-4" /> Mulai pendaftaran
              </Button>
            </div>
          )}
        </SectionCard>

        <SectionCard
          title="Integritas audit log"
          description="Setiap entri audit dirantai dengan hash entri sebelumnya. Perubahan atau penghapusan satu baris akan terdeteksi."
          action={
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void verifyChain()}
              loading={busy === "chain"}
            >
              <RefreshCw className="h-3.5 w-3.5" /> Periksa
            </Button>
          }
        >
          {chain ? (
            <div className="space-y-2 text-[12.5px]">
              <div className="flex items-center gap-2">
                <Badge tone={chain.valid ? "success" : "danger"} dot>
                  {chain.valid ? "Rantai utuh" : `Rusak di #${chain.brokenAt}`}
                </Badge>
                <span className="text-ink-500">
                  {chain.checked} entri diperiksa
                  {chain.unhashed > 0
                    ? `, ${chain.unhashed} entri lama tanpa hash`
                    : ""}
                </span>
              </div>
              {!chain.valid && chain.reason ? (
                <p className="text-rose-700">{chain.reason}</p>
              ) : null}
              <p className="text-[11.5px] text-ink-400">
                Jendela #{chain.window.from ?? "-"} sampai #
                {chain.window.to ?? "-"}, {formatDateTime(chain.checkedAt)}
              </p>
            </div>
          ) : (
            <p className="text-[12.5px] leading-relaxed text-ink-500">
              Periksa berkala, misalnya setelah ada perubahan konfigurasi toko
              atau pencabutan klaim.
            </p>
          )}
        </SectionCard>

        {can("settings:write") ? (
          <>
            <SectionCard
              title="Retensi data"
              description="Menghapus data operasional yang sudah kedaluwarsa. Pesanan, klaim, dan audit tidak disentuh."
            >
              {retention ? (
                <ul className="mb-3 space-y-1 text-[12.5px] text-ink-700">
                  <li className="flex justify-between">
                    <span>Sesi klaim</span>{" "}
                    <span className="font-mono">{retention.claimSessions}</span>
                  </li>
                  <li className="flex justify-between">
                    <span>Sesi konsol</span>{" "}
                    <span className="font-mono">{retention.sessions}</span>
                  </li>
                  <li className="flex justify-between">
                    <span>Webhook</span>{" "}
                    <span className="font-mono">{retention.webhookEvents}</span>
                  </li>
                  <li className="flex justify-between">
                    <span>Job selesai</span>{" "}
                    <span className="font-mono">{retention.jobs}</span>
                  </li>
                  <li className="flex justify-between">
                    <span>Permintaan manual kedaluwarsa</span>{" "}
                    <span className="font-mono">
                      {retention.expiredClaimRequests}
                    </span>
                  </li>
                </ul>
              ) : (
                <p className="mb-3 text-[12.5px] text-ink-500">
                  Hitung dulu untuk melihat berapa baris yang akan dihapus.
                </p>
              )}
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  onClick={() => void previewRetention()}
                  loading={busy === "retention-preview"}
                >
                  <Database className="h-4 w-4" /> Hitung
                </Button>
                <Button
                  onClick={() => void runRetention()}
                  loading={busy === "retention-run"}
                >
                  Jalankan
                </Button>
              </div>
            </SectionCard>

            <SectionCard
              title="Rotasi kunci enkripsi"
              description="Dekripsi ulang token Shopee, kode aktivasi, dan secret 2FA ke kunci baru dalam satu transaksi."
            >
              <ol className="mb-3 list-decimal space-y-1 pl-4 text-[12.5px] leading-relaxed text-ink-600">
                <li>
                  Set APP_ENCRYPTION_KEY_OLD ke kunci yang sedang dipakai.
                </li>
                <li>
                  Set APP_ENCRYPTION_KEY ke kunci baru, jalankan uji kering di
                  bawah.
                </li>
                <li>
                  Jalankan rotasi tanpa uji kering, lalu restart api dan worker.
                </li>
                <li>Hapus APP_ENCRYPTION_KEY_OLD.</li>
              </ol>
              {rotation ? (
                <p className="mb-2 text-[12.5px] text-ink-700">
                  Uji kering: {rotation.counts}. Tidak ada perubahan tersimpan.
                </p>
              ) : null}
              <Button
                variant="secondary"
                onClick={() => void dryRunRotation()}
                loading={busy === "rotate"}
              >
                <AlertTriangle className="h-4 w-4" /> Uji kering
              </Button>
            </SectionCard>

            <SectionCard
              title="Notifikasi"
              description="Webhook keluar untuk klaim selesai, akses dicabut, stok habis, dan sinkronisasi gagal."
            >
              <p className="mb-3 text-[12.5px] leading-relaxed text-ink-600">
                Atur URL dan secret di halaman Pengaturan, bagian Notifikasi.
                Uji di sini untuk memastikan endpoint menjawab.
              </p>
              <Button
                variant="secondary"
                onClick={() => void testNotification()}
                loading={busy === "notify"}
              >
                <Send className="h-4 w-4" /> Kirim notifikasi uji
              </Button>
            </SectionCard>
          </>
        ) : null}
      </div>
    </>
  );
}
