"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  ClipboardCheck,
  RefreshCw,
  ShieldCheck,
  Zap,
} from "lucide-react";
import { ApiError, api } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { useAuth } from "@/lib/auth";
import {
  DetailRow,
  KeyValue,
  SectionCard,
  StatusBadge,
  TableShell,
  Td,
  Th,
  Tr,
} from "@/components/admin/kit";
import {
  Alert,
  Badge,
  Button,
  Field,
  Input,
  PageHeader,
  Select,
  Skeleton,
  useToast,
} from "@/components/ui";
import {
  JOB_STATUS,
  ORDER_STATE,
  formatDateTime,
  relativeTime,
} from "@/lib/format";

interface StoreDetail {
  store: {
    id: string;
    shopId: number;
    label: string;
    shopName: string | null;
    region: string | null;
    environment: "SANDBOX" | "PRODUCTION";
    status: string;
    brandName: string | null;
    supportEmail: string | null;
    supportWhatsapp: string | null;
    verificationPolicy:
      "USERNAME" | "USERNAME_PHONE" | "USERNAME_OR_PHONE" | "MANUAL";
    eligibleStatuses: string[];
    lastProductSyncAt: string | null;
    lastOrderSyncAt: string | null;
    lastError: string | null;
  };
  token: { expiresAt: string; updatedAt: string } | null;
  ordersByState: Record<string, number>;
  products: number;
  gatewayMode: "live" | "fixture";
}

interface SyncJob {
  id: string;
  type: "PRODUCTS" | "ORDERS";
  status: string;
  stats: Record<string, unknown> | null;
  error: string | null;
  triggeredBy: string;
  createdAt: string;
  finishedAt: string | null;
  storeLabel: string;
}

const VERIFICATION_HINT: Record<string, string> = {
  USERNAME:
    "Pembeli memasukkan username Shopee-nya. Nomor pesanan saja tidak cukup.",
  USERNAME_PHONE:
    "Username plus empat digit terakhir nomor HP pada pesanan. Gagal tertutup bila Shopee tidak mengirim nomor.",
  MANUAL:
    "Klaim menunggu persetujuan operator; portal tidak memberi akses otomatis.",
};

export default function StoreDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const { can } = useAuth();
  const { toast } = useToast();

  /** Google Drive delivery: one account per store, consented once, revocable here. */
  const drive = useApi<{
    configured: boolean;
    connected: boolean;
    mode: "service_account" | "oauth" | "none";
    accountEmail: string | null;
    connectedAt: string | null;
    status: string | null;
    lastError: string | null;
  }>(`/admin/stores/${id}/drive`);
  const [driveBusy, setDriveBusy] = useState(false);

  const connectDrive = async () => {
    setDriveBusy(true);
    try {
      const { url } = await api.get<{ url: string }>(
        `/admin/stores/${id}/drive/connect`,
      );
      window.location.href = url;
    } catch (caught) {
      toast({
        title: "Tidak bisa membuka persetujuan Google",
        description: caught instanceof ApiError ? caught.message : "",
        tone: "danger",
      });
      setDriveBusy(false);
    }
  };

  const disconnectDrive = async () => {
    setDriveBusy(true);
    try {
      await api.delete(`/admin/stores/${id}/drive`);
      drive.refresh();
      toast({ title: "Google Drive diputuskan" });
    } catch (caught) {
      toast({
        title: "Gagal memutuskan",
        description: caught instanceof ApiError ? caught.message : "",
        tone: "danger",
      });
    } finally {
      setDriveBusy(false);
    }
  };
  const detail = useApi<StoreDetail>(`/admin/stores/${id}`);
  const jobs = useApi<{ data: SyncJob[] }>(
    `/admin/sync-jobs?storeId=${id}&pageSize=8`,
  );

  const [form, setForm] = useState({
    brandName: "",
    supportEmail: "",
    supportWhatsapp: "",
    verificationPolicy: "USERNAME",
  });
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!detail.data) return;
    setForm({
      brandName: detail.data.store.brandName ?? "",
      supportEmail: detail.data.store.supportEmail ?? "",
      supportWhatsapp: detail.data.store.supportWhatsapp ?? "",
      verificationPolicy: detail.data.store.verificationPolicy,
    });
  }, [detail.data]);

  const save = async () => {
    setSaving(true);
    try {
      await api.patch(`/admin/stores/${id}`, {
        brandName: form.brandName || null,
        supportEmail: form.supportEmail || null,
        supportWhatsapp: form.supportWhatsapp || null,
        verificationPolicy: form.verificationPolicy,
      });
      toast({ title: "Pengaturan toko disimpan" });
      detail.refresh();
    } catch (caught) {
      toast({
        title: "Gagal menyimpan",
        description: caught instanceof ApiError ? caught.message : "",
        tone: "danger",
      });
    } finally {
      setSaving(false);
    }
  };

  const act = async (path: string, label: string, body?: unknown) => {
    setBusy(path);
    try {
      await api.post(path, body);
      toast({ title: label });
      detail.refresh();
      jobs.refresh();
    } catch (caught) {
      toast({
        title: "Tindakan gagal",
        description: caught instanceof ApiError ? caught.message : "",
        tone: "danger",
      });
    } finally {
      setBusy(null);
    }
  };

  const store = detail.data?.store;

  return (
    <>
      <PageHeader
        breadcrumbs={[
          { label: "Toko Shopee", href: "/admin/stores" },
          { label: store?.label ?? "Detail" },
        ]}
        title={store?.brandName ?? store?.label ?? "Detail toko"}
        description={
          store
            ? `Shop ${store.shopId} · ${store.environment.toLowerCase()}${store.region ? ` · ${store.region}` : ""}`
            : undefined
        }
        actions={
          <div className="flex items-center gap-2">
            <Link
              href="/admin/stores"
              className="inline-flex items-center gap-1 text-[12.5px] text-ink-500 hover:text-ink-900"
            >
              <ArrowLeft className="h-3.5 w-3.5" /> Kembali
            </Link>
            {store ? (
              <Badge
                tone={
                  store.status === "CONNECTED"
                    ? "success"
                    : store.status === "ERROR"
                      ? "danger"
                      : "warning"
                }
                dot
              >
                {store.status}
              </Badge>
            ) : null}
          </div>
        }
      />

      {detail.error ? (
        <Alert tone="danger" title="Toko tidak ditemukan">
          {detail.error.message}
        </Alert>
      ) : null}

      {store?.lastError ? (
        <div className="mb-4">
          <Alert tone="warning" title="Kesalahan terakhir dari Shopee">
            {store.lastError}
          </Alert>
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <SectionCard
          className="lg:col-span-2"
          title="Koneksi Shopee"
          description="Otorisasi, token, dan sinkronisasi manual."
        >
          {detail.loading || !detail.data ? (
            <div className="space-y-3 p-5">
              <Skeleton className="h-10" />
              <Skeleton className="h-10" />
              <Skeleton className="h-24" />
            </div>
          ) : (
            <div className="p-5">
              <div className="grid gap-3 sm:grid-cols-2">
                <KeyValue
                  label="Access token"
                  value={
                    detail.data.token
                      ? `berakhir ${relativeTime(detail.data.token.expiresAt)}`
                      : "belum ada"
                  }
                />
                <KeyValue
                  label="Environment"
                  value={detail.data.store.environment.toLowerCase()}
                  mono
                />
                <KeyValue
                  label="Katalog tersinkron"
                  value={`${detail.data.products} produk`}
                />
                <KeyValue
                  label="Gateway"
                  value={
                    detail.data.gatewayMode === "fixture"
                      ? "fixture (simulasi)"
                      : "live"
                  }
                />
              </div>

              <div className="mt-4 flex flex-wrap gap-2">
                {detail.data.store.status !== "CONNECTED" ? (
                  <Button
                    size="sm"
                    loading={busy === `/admin/stores/${id}/authorize`}
                    onClick={async () => {
                      setBusy(`/admin/stores/${id}/authorize`);
                      try {
                        const result = await api.post<{
                          url: string;
                          simulated: boolean;
                        }>(`/admin/stores/${id}/authorize`);
                        if (result.simulated) {
                          await api.post(
                            `/admin/stores/${id}/authorize/simulate`,
                          );
                          toast({ title: "Toko tersambung (simulasi)" });
                          detail.refresh();
                        } else {
                          window.open(
                            result.url,
                            "_blank",
                            "noopener,noreferrer",
                          );
                          toast({
                            title: "Jendela otorisasi dibuka",
                            tone: "info",
                          });
                        }
                      } catch (caught) {
                        toast({
                          title: "Otorisasi gagal",
                          description:
                            caught instanceof ApiError ? caught.message : "",
                          tone: "danger",
                        });
                      } finally {
                        setBusy(null);
                      }
                    }}
                  >
                    <Zap className="h-3.5 w-3.5" />{" "}
                    {detail.data.gatewayMode === "fixture"
                      ? "Sambungkan (simulasi)"
                      : "Buka otorisasi Shopee"}
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="secondary"
                  loading={busy === `/admin/stores/${id}/refresh`}
                  onClick={() =>
                    void act(`/admin/stores/${id}/refresh`, "Token diperbarui")
                  }
                >
                  <ShieldCheck className="h-3.5 w-3.5" /> Perbarui token
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  loading={busy === `/admin/stores/${id}/sync/products`}
                  onClick={() =>
                    void act(
                      `/admin/stores/${id}/sync/products`,
                      "Sinkronisasi katalog diantrikan",
                    )
                  }
                >
                  <RefreshCw className="h-3.5 w-3.5" /> Sinkron produk
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  loading={busy === `/admin/stores/${id}/sync/orders`}
                  onClick={() =>
                    void act(
                      `/admin/stores/${id}/sync/orders`,
                      "Sinkronisasi pesanan diantrikan",
                    )
                  }
                >
                  <RefreshCw className="h-3.5 w-3.5" /> Sinkron pesanan
                </Button>
              </div>

              <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
                {Object.entries(detail.data.ordersByState).length > 0 ? (
                  Object.entries(detail.data.ordersByState).map(
                    ([state, total]) => (
                      <div
                        key={state}
                        className="rounded-lg bg-canvas px-3 py-2 ring-1 ring-inset ring-line"
                      >
                        <StatusBadge map={ORDER_STATE} value={state} />
                        <p className="mt-1.5 text-[16px] font-semibold tabular-nums text-ink-950">
                          {total}
                        </p>
                      </div>
                    ),
                  )
                ) : (
                  <p className="col-span-full text-[12.5px] text-ink-400">
                    Belum ada pesanan tersinkron.
                  </p>
                )}
              </div>
            </div>
          )}
        </SectionCard>

        <SectionCard
          title="Branding & verifikasi"
          description="Tampil di portal klaim untuk toko ini."
        >
          <div className="space-y-4 p-5">
            <Field label="Nama merek" htmlFor="brand">
              <Input
                id="brand"
                value={form.brandName}
                onChange={(event) =>
                  setForm({ ...form, brandName: event.target.value })
                }
                placeholder="Pixel Bloom"
              />
            </Field>
            <Field label="Email dukungan" htmlFor="email">
              <Input
                id="email"
                type="email"
                value={form.supportEmail}
                onChange={(event) =>
                  setForm({ ...form, supportEmail: event.target.value })
                }
              />
            </Field>
            <Field label="WhatsApp dukungan" htmlFor="wa">
              <Input
                id="wa"
                value={form.supportWhatsapp}
                onChange={(event) =>
                  setForm({ ...form, supportWhatsapp: event.target.value })
                }
                placeholder="+62..."
              />
            </Field>
            <Field label="Kebijakan verifikasi" hint="lihat catatan di bawah">
              <Select
                value={form.verificationPolicy}
                onValueChange={(value) =>
                  setForm({ ...form, verificationPolicy: value })
                }
                options={[
                  { value: "USERNAME", label: "Username Shopee" },
                  { value: "USERNAME_PHONE", label: "Username + 4 digit HP" },
                  {
                    value: "USERNAME_OR_PHONE",
                    label: "Username atau 4 digit HP",
                  },
                  { value: "MANUAL", label: "Manual oleh operator" },
                ]}
                className="w-full"
              />
            </Field>
            <p className="rounded-lg bg-canvas px-3 py-2 text-[11.5px] leading-relaxed text-ink-500 ring-1 ring-inset ring-line">
              {VERIFICATION_HINT[form.verificationPolicy]}
            </p>
            {can("store:write") ? (
              <Button
                className="w-full"
                onClick={() => void save()}
                loading={saving}
              >
                <ClipboardCheck className="h-4 w-4" /> Simpan pengaturan
              </Button>
            ) : null}
          </div>
        </SectionCard>
      </div>

      <div className="mt-4">
        <SectionCard
          title="Riwayat sinkronisasi"
          description="Delapan job terakhir untuk toko ini."
        >
          <TableShell>
            <thead>
              <tr>
                <Th>Jenis</Th>
                <Th>Status</Th>
                <Th>Hasil</Th>
                <Th>Pemicu</Th>
                <Th className="text-right">Waktu</Th>
              </tr>
            </thead>
            <tbody>
              {jobs.data && jobs.data.data.length > 0 ? (
                jobs.data.data.map((job) => (
                  <Tr key={job.id}>
                    <Td className="text-[12.5px] text-ink-700">
                      {job.type === "PRODUCTS" ? "Katalog" : "Pesanan"}
                    </Td>
                    <Td>
                      <StatusBadge map={JOB_STATUS} value={job.status} />
                    </Td>
                    <Td className="max-w-[280px] truncate font-mono text-[11.5px] text-ink-500">
                      {job.error ??
                        (job.stats ? JSON.stringify(job.stats) : "—")}
                    </Td>
                    <Td className="text-[12px] text-ink-500">
                      {job.triggeredBy}
                    </Td>
                    <Td className="text-right text-[12px] text-ink-400">
                      {formatDateTime(job.createdAt)}
                    </Td>
                  </Tr>
                ))
              ) : (
                <tr>
                  <Td className="text-[12.5px] text-ink-400">
                    Belum ada sinkronisasi.
                  </Td>
                  <Td /> <Td /> <Td /> <Td />
                </tr>
              )}
            </tbody>
          </TableShell>
        </SectionCard>
      </div>

      <div className="mt-4">
        <SectionCard
          title="Google Drive"
          description="Produk bertipe Drive dibagikan ke akun Google pembeli, satu akun per pesanan."
        >
          <div className="flex flex-wrap items-center justify-between gap-3 p-5">
            <div className="min-w-0">
              {drive.loading ? (
                <Skeleton className="h-4 w-44" />
              ) : drive.data?.connected ? (
                <>
                  <p className="text-[13px] font-medium text-ink-950">
                    {drive.data.accountEmail}
                  </p>
                  <p className="mt-0.5 text-[11.5px] leading-relaxed text-ink-500">
                    {drive.data.mode === "service_account"
                      ? "Dikelola service account server. Pembeli ditambahkan sebagai viewer."
                      : "Terhubung "}
                    {drive.data.mode !== "service_account" &&
                    drive.data.connectedAt
                      ? formatDateTime(drive.data.connectedAt)
                      : ""}
                    {drive.data.status === "ERROR"
                      ? ` · perlu dihubungkan ulang: ${drive.data.lastError ?? "izin ditolak Google"}`
                      : ""}
                  </p>
                </>
              ) : (
                <p className="text-[12.5px] leading-relaxed text-ink-500">
                  {drive.data?.configured
                    ? "Belum ada akun Google yang terhubung. Hubungkan akun pemilik folder produk."
                    : "Server belum punya kredensial OAuth Google (GOOGLE_OAUTH_CLIENT_ID)."}
                </p>
              )}
            </div>
            {can("store:write") && drive.data?.mode !== "service_account" ? (
              drive.data?.connected ? (
                <Button
                  variant="secondary"
                  loading={driveBusy}
                  onClick={() => void disconnectDrive()}
                >
                  Putuskan
                </Button>
              ) : (
                <Button
                  loading={driveBusy}
                  disabled={!drive.data?.configured}
                  onClick={() => void connectDrive()}
                >
                  Hubungkan Google Drive
                </Button>
              )
            ) : null}
          </div>
        </SectionCard>
      </div>

      <div className="mt-4">
        <SectionCard
          title="Kebijakan status yang boleh diklaim"
          description="Pesanan hanya bisa diklaim bila status Shopee ada di daftar ini."
        >
          <div className="flex flex-wrap gap-2 p-5">
            {(store?.eligibleStatuses ?? []).map((status) => (
              <Badge key={status} tone="neutral">
                {status}
              </Badge>
            ))}
          </div>
        </SectionCard>
      </div>
    </>
  );
}
