"use client";

import { useState } from "react";
import Link from "next/link";
import {
  MoreHorizontal,
  Plus,
  RefreshCw,
  Store,
  Trash2,
  Zap,
} from "lucide-react";
import { ApiError, api } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { useAuth } from "@/lib/auth";
import {
  LoadingRows,
  SectionCard,
  TableShell,
  Td,
  Th,
  Tr,
} from "@/components/admin/kit";
import {
  Alert,
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Select,
  Skeleton,
  useToast,
} from "@/components/ui";
import { formatDateTime, relativeTime, type Tone } from "@/lib/format";

interface StoreRow {
  id: string;
  shopId: number;
  label: string;
  shopName: string | null;
  region: string | null;
  environment: "SANDBOX" | "PRODUCTION";
  status: "PENDING" | "CONNECTED" | "ERROR" | "DISCONNECTED";
  brandName: string | null;
  verificationPolicy: string;
  lastProductSyncAt: string | null;
  lastOrderSyncAt: string | null;
  lastError: string | null;
  tokenExpiresAt: string | null;
  orders: number;
}

const statusTone: Record<string, Tone> = {
  CONNECTED: "success",
  PENDING: "warning",
  ERROR: "danger",
  DISCONNECTED: "neutral",
};
const statusLabel: Record<string, string> = {
  CONNECTED: "Terhubung",
  PENDING: "Belum otorisasi",
  ERROR: "Bermasalah",
  DISCONNECTED: "Terputus",
};

export default function StoresPage() {
  const { can } = useAuth();
  const { toast } = useToast();
  const { data, loading, error, refresh } = useApi<{
    data: StoreRow[];
    gatewayMode: "live" | "fixture";
  }>("/admin/stores");
  const [createOpen, setCreateOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [disconnectTarget, setDisconnectTarget] = useState<StoreRow | null>(
    null,
  );

  const [form, setForm] = useState({
    label: "",
    shopId: "",
    environment: "SANDBOX",
    verificationPolicy: "USERNAME",
  });
  const [formError, setFormError] = useState<string | null>(null);

  const create = async () => {
    setBusy("create");
    setFormError(null);
    try {
      await api.post("/admin/stores", {
        label: form.label,
        shopId: Number(form.shopId),
        environment: form.environment,
        verificationPolicy: form.verificationPolicy,
      });
      toast({
        title: "Toko ditambahkan",
        description: "Lanjutkan dengan otorisasi Shopee.",
      });
      setCreateOpen(false);
      setForm({
        label: "",
        shopId: "",
        environment: "SANDBOX",
        verificationPolicy: "USERNAME",
      });
      refresh();
    } catch (caught) {
      setFormError(
        caught instanceof ApiError ? caught.message : "Gagal menambah toko",
      );
    } finally {
      setBusy(null);
    }
  };

  const connect = async (store: StoreRow) => {
    setBusy(`connect-${store.id}`);
    try {
      const result = await api.post<{ url: string; simulated: boolean }>(
        `/admin/stores/${store.id}/authorize`,
      );
      if (result.simulated) {
        await api.post(`/admin/stores/${store.id}/authorize/simulate`);
        toast({
          title: "Toko tersambung (simulasi)",
          description: "Mode fixture: data berasal dari contoh, bukan Shopee.",
        });
      } else {
        window.open(result.url, "_blank", "noopener,noreferrer");
        toast({
          title: "Jendela otorisasi dibuka",
          description:
            "Selesaikan persetujuan di Shopee, lalu kembali ke halaman ini.",
        });
      }
      refresh();
    } catch (caught) {
      toast({
        title: "Otorisasi gagal",
        description:
          caught instanceof ApiError ? caught.message : "Terjadi kesalahan",
        tone: "danger",
      });
    } finally {
      setBusy(null);
    }
  };

  const sync = async (store: StoreRow, type: "products" | "orders") => {
    setBusy(`sync-${type}-${store.id}`);
    try {
      const result = await api.post<{ queued: boolean; message?: string }>(
        `/admin/stores/${store.id}/sync/${type}`,
      );
      toast({
        title: result.queued ? "Sinkronisasi diantrikan" : "Sudah berjalan",
        description:
          result.message ?? "Worker akan memproses dalam beberapa detik.",
        tone: result.queued ? "success" : "info",
      });
      setTimeout(refresh, 1500);
    } catch (caught) {
      toast({
        title: "Gagal memulai sinkronisasi",
        description: caught instanceof ApiError ? caught.message : "",
        tone: "danger",
      });
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async () => {
    if (!disconnectTarget) return;
    setBusy("disconnect");
    try {
      await api.post(`/admin/stores/${disconnectTarget.id}/disconnect`);
      toast({
        title: "Toko diputus",
        description: "Token dihapus dari server.",
      });
      setDisconnectTarget(null);
      refresh();
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <PageHeader
        title="Toko Shopee"
        description="Setiap toko punya token sendiri. Token disimpan terenkripsi dan tidak pernah dikirim ke browser."
        actions={
          can("store:write") ? (
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" /> Tambah toko
            </Button>
          ) : null
        }
      />

      {error ? (
        <Alert tone="danger" title="Tidak bisa memuat daftar toko">
          {error.message}
        </Alert>
      ) : null}

      <SectionCard
        title="Daftar toko"
        description="Status koneksi, kesehatan token, dan aktivitas sinkronisasi."
      >
        <TableShell>
          <thead>
            <tr>
              <Th>Toko</Th>
              <Th>Shop ID</Th>
              <Th>Status</Th>
              <Th>Token</Th>
              <Th>Sinkron terakhir</Th>
              <Th>Pesanan</Th>
              <Th className="text-right">Aksi</Th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <LoadingRows rows={3} cols={7} />
            ) : data && data.data.length > 0 ? (
              data.data.map((store) => (
                <Tr key={store.id}>
                  <Td>
                    <Link
                      href={`/admin/stores/${store.id}`}
                      className="flex items-center gap-2.5"
                    >
                      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-50 text-brand-700">
                        <Store className="h-4 w-4" />
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-[13px] font-medium text-ink-950">
                          {store.brandName ?? store.label}
                        </span>
                        <span className="block truncate text-[11.5px] text-ink-400">
                          {store.shopName ?? store.label} ·{" "}
                          {store.environment.toLowerCase()}
                        </span>
                      </span>
                    </Link>
                  </Td>
                  <Td className="font-mono text-[12px] text-ink-500">
                    {store.shopId}
                  </Td>
                  <Td>
                    <Badge tone={statusTone[store.status] ?? "neutral"} dot>
                      {statusLabel[store.status] ?? store.status}
                    </Badge>
                    {store.lastError ? (
                      <p className="mt-1 max-w-[220px] truncate text-[11px] text-rose-700">
                        {store.lastError}
                      </p>
                    ) : null}
                  </Td>
                  <Td className="text-[12px] text-ink-500">
                    {store.tokenExpiresAt ? (
                      <>
                        <span className="block">
                          {formatDateTime(store.tokenExpiresAt)}
                        </span>
                        <span className="text-[11px] text-ink-400">
                          {relativeTime(store.tokenExpiresAt)}
                        </span>
                      </>
                    ) : (
                      <span className="text-ink-300">belum ada</span>
                    )}
                  </Td>
                  <Td className="text-[12px] text-ink-500">
                    <span className="block">
                      Produk:{" "}
                      {store.lastProductSyncAt
                        ? relativeTime(store.lastProductSyncAt)
                        : "—"}
                    </span>
                    <span className="block text-[11px] text-ink-400">
                      Pesanan:{" "}
                      {store.lastOrderSyncAt
                        ? relativeTime(store.lastOrderSyncAt)
                        : "—"}
                    </span>
                  </Td>
                  <Td className="tabular-nums text-ink-600">{store.orders}</Td>
                  <Td>
                    <div className="flex items-center justify-end gap-1.5">
                      {store.status !== "CONNECTED" ? (
                        <Button
                          size="sm"
                          onClick={() => void connect(store)}
                          loading={busy === `connect-${store.id}`}
                        >
                          <Zap className="h-3.5 w-3.5" />{" "}
                          {data.gatewayMode === "fixture"
                            ? "Sambungkan (simulasi)"
                            : "Otorisasi"}
                        </Button>
                      ) : (
                        <>
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => void sync(store, "products")}
                            loading={busy === `sync-products-${store.id}`}
                          >
                            <RefreshCw className="h-3.5 w-3.5" /> Produk
                          </Button>
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => void sync(store, "orders")}
                            loading={busy === `sync-orders-${store.id}`}
                          >
                            <RefreshCw className="h-3.5 w-3.5" /> Pesanan
                          </Button>
                        </>
                      )}
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => setDisconnectTarget(store)}
                        aria-label="Putus toko"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </Td>
                </Tr>
              ))
            ) : null}
          </tbody>
        </TableShell>
        {!loading && data && data.data.length === 0 ? (
          <div className="p-5">
            <EmptyState
              title="Belum ada toko"
              description="Tambahkan shop id dari Seller Center, lalu selesaikan otorisasi agar sistem bisa membaca pesanan dan katalog."
              icon={<Store className="h-5 w-5" />}
              action={
                can("store:write") ? (
                  <Button onClick={() => setCreateOpen(true)}>
                    <Plus className="h-4 w-4" /> Tambah toko pertama
                  </Button>
                ) : null
              }
            />
          </div>
        ) : null}
      </SectionCard>

      <Dialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        title="Tambah toko Shopee"
        description="Shop id terlihat di Seller Center atau pada URL toko Anda."
        footer={
          <>
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>
              Batal
            </Button>
            <Button
              onClick={() => void create()}
              loading={busy === "create"}
              disabled={form.label.length < 2 || !form.shopId}
            >
              Simpan toko
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Nama internal" htmlFor="label">
            <Input
              id="label"
              value={form.label}
              onChange={(event) =>
                setForm({ ...form, label: event.target.value })
              }
              placeholder="pixelbloomid"
            />
          </Field>
          <Field label="Shop ID" htmlFor="shopId" hint="angka dari Shopee">
            <Input
              id="shopId"
              value={form.shopId}
              inputMode="numeric"
              onChange={(event) =>
                setForm({
                  ...form,
                  shopId: event.target.value.replace(/\D/g, ""),
                })
              }
              placeholder="771001"
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Environment">
              <Select
                value={form.environment}
                onValueChange={(value) =>
                  setForm({ ...form, environment: value })
                }
                options={[
                  { value: "SANDBOX", label: "Sandbox" },
                  { value: "PRODUCTION", label: "Production" },
                ]}
                className="w-full"
              />
            </Field>
            <Field label="Verifikasi pembeli">
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
                ]}
                className="w-full"
              />
            </Field>
          </div>
          {formError ? (
            <p className="text-[12.5px] text-rose-700">{formError}</p>
          ) : null}
        </div>
      </Dialog>

      <ConfirmDialog
        open={disconnectTarget !== null}
        onOpenChange={(open) => !open && setDisconnectTarget(null)}
        title="Putuskan toko ini?"
        description="Token akan dihapus. Pesanan dan klaim yang sudah ada tetap tersimpan, tetapi sinkronisasi berhenti sampai toko diotorisasi ulang."
        confirmLabel="Putus toko"
        destructive
        loading={busy === "disconnect"}
        onConfirm={() => void disconnect()}
      >
        {disconnectTarget ? (
          <p className="rounded-lg bg-canvas px-3 py-2 text-[12.5px] text-ink-600 ring-1 ring-inset ring-line">
            {disconnectTarget.brandName ?? disconnectTarget.label} · shop{" "}
            {disconnectTarget.shopId}
          </p>
        ) : null}
      </ConfirmDialog>

      {loading ? (
        <div className="mt-4">
          <Skeleton className="h-16" />
        </div>
      ) : null}
    </>
  );
}
