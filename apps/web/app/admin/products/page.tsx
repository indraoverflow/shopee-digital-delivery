"use client";

import { useState } from "react";
import Link from "next/link";
import {
  FileText,
  KeyRound,
  Link2,
  ListChecks,
  Package,
  Pencil,
  Plus,
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
  Dialog,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Pagination,
  Select,
  Textarea,
  useToast,
} from "@/components/ui";
import { DELIVERY_KIND, formatDateTime, type Tone } from "@/lib/format";

interface DigitalProductRow {
  id: string;
  name: string;
  deliveryKind: string;
  status: "DRAFT" | "ACTIVE" | "ARCHIVED";
  claimExpiryDays: number;
  maxDeliveries: number;
  mappingCount: number;
  availableCodes: number;
  asset: { fileName: string; sizeBytes: number } | null;
  createdAt: string;
}

const statusTone: Record<string, Tone> = {
  ACTIVE: "success",
  DRAFT: "warning",
  ARCHIVED: "neutral",
};
const kindIcon = {
  FILE: FileText,
  LINK: Link2,
  CODE: KeyRound,
  CREDENTIALS: KeyRound,
  INSTRUCTIONS: ListChecks,
} as const;

export default function DigitalProductsPage() {
  const { can } = useAuth();
  const { toast } = useToast();
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    name: "",
    deliveryKind: "CODE",
    status: "DRAFT",
    description: "",
    externalUrl: "",
    meteraiEnabled: false,
  });
  const [formError, setFormError] = useState<string | null>(null);
  /** Set when the dialog is editing an existing product instead of creating one. */
  const [editingId, setEditingId] = useState<string | null>(null);

  const list = useApi<{
    data: DigitalProductRow[];
    total: number;
    page: number;
    pageSize: number;
  }>(`/admin/digital-products?page=${page}&pageSize=20`);

  /**
   * "Produk e-Meterai" is a property of an existing product too, and until now the only
   * way to set it was to create a new product: the form was create-only. Edit mode reads
   * the product detail and saves through PATCH, which already existed.
   */
  const openEdit = async (id: string) => {
    setFormError(null);
    try {
      const { product } = await api.get<{
        product: {
          name: string;
          deliveryKind: string;
          status: string;
          description: string | null;
          externalUrl: string | null;
          meteraiEnabled: boolean;
        };
      }>(`/admin/digital-products/${id}`);
      setForm({
        name: product.name,
        deliveryKind: product.deliveryKind,
        status: product.status === "ARCHIVED" ? "DRAFT" : product.status,
        description: product.description ?? "",
        externalUrl: product.externalUrl ?? "",
        meteraiEnabled: product.meteraiEnabled,
      });
      setEditingId(id);
      setOpen(true);
    } catch (caught) {
      toast({
        title: "Gagal memuat produk",
        description: caught instanceof ApiError ? caught.message : "",
        tone: "danger",
      });
    }
  };

  const save = async () => {
    setBusy(true);
    setFormError(null);
    try {
      if (editingId) {
        await api.patch(`/admin/digital-products/${editingId}`, {
          name: form.name,
          deliveryKind: form.deliveryKind,
          ...(form.status === "ARCHIVED" ? {} : { status: form.status }),
          description: form.description || null,
          ...(form.deliveryKind === "LINK"
            ? { externalUrl: form.externalUrl }
            : {}),
          meteraiEnabled: form.meteraiEnabled,
        });
        toast({
          title: "Produk diperbarui",
          description: "Perubahan tersimpan dan tercatat di audit log.",
        });
        setOpen(false);
        setEditingId(null);
        list.refresh();
        return;
      }
      await create();
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    setFormError(null);
    try {
      const result = await api.post<{ product: { id: string } }>(
        "/admin/digital-products",
        {
          name: form.name,
          deliveryKind: form.deliveryKind,
          status: form.status,
          ...(form.description ? { description: form.description } : {}),
          ...(form.deliveryKind === "LINK"
            ? { externalUrl: form.externalUrl }
            : {}),
          meteraiEnabled: form.meteraiEnabled,
        },
      );
      toast({
        title: "Produk digital dibuat",
        description: "Lengkapi berkas atau kode sebelum diaktifkan.",
      });
      setOpen(false);
      setForm({
        name: "",
        deliveryKind: "CODE",
        status: "DRAFT",
        description: "",
        externalUrl: "",
        meteraiEnabled: false,
      });
      list.refresh();
      window.location.href = `/admin/products/${result.product.id}`;
    } catch (caught) {
      setFormError(
        caught instanceof ApiError ? caught.message : "Gagal membuat produk",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Produk Digital"
        description="Apa yang diterima pembeli: berkas, tautan, kode aktivasi, kredensial, atau instruksi."
        actions={
          can("product:write") ? (
            <Button
              onClick={() => {
                setEditingId(null);
                setForm({
                  name: "",
                  deliveryKind: "CODE",
                  status: "DRAFT",
                  description: "",
                  externalUrl: "",
                  meteraiEnabled: false,
                });
                setOpen(true);
              }}
            >
              <Plus className="h-4 w-4" /> Produk baru
            </Button>
          ) : null
        }
      />

      {list.error ? (
        <Alert tone="danger" title="Gagal memuat produk">
          {list.error.message}
        </Alert>
      ) : null}

      <SectionCard
        title="Daftar produk"
        description="Stok kode dan jumlah mapping terlihat sekilas."
      >
        <TableShell>
          <thead>
            <tr>
              <Th>Produk</Th>
              <Th>Tipe</Th>
              <Th>Status</Th>
              <Th>Mapping</Th>
              <Th>Stok kode</Th>
              <Th>Masa klaim</Th>
              <Th className="text-right">Dibuat</Th>
              <Th className="text-right">Aksi</Th>
            </tr>
          </thead>
          <tbody>
            {list.loading ? (
              <LoadingRows rows={4} cols={8} />
            ) : list.data && list.data.data.length > 0 ? (
              list.data.data.map((product) => {
                const Icon =
                  kindIcon[product.deliveryKind as keyof typeof kindIcon] ??
                  Package;
                return (
                  <Tr key={product.id}>
                    <Td>
                      <Link
                        href={`/admin/products/${product.id}`}
                        className="flex items-center gap-2.5"
                      >
                        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-50 text-brand-700">
                          <Icon className="h-4 w-4" />
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate text-[13px] font-medium text-ink-950">
                            {product.name}
                          </span>
                          <span className="block truncate text-[11.5px] text-ink-400">
                            {product.asset
                              ? product.asset.fileName
                              : product.deliveryKind === "CODE"
                                ? `${product.availableCodes} kode tersedia`
                                : DELIVERY_KIND[product.deliveryKind]}
                          </span>
                        </span>
                      </Link>
                    </Td>
                    <Td className="text-[12px] text-ink-500">
                      {DELIVERY_KIND[product.deliveryKind]}
                    </Td>
                    <Td>
                      <Badge tone={statusTone[product.status] ?? "neutral"} dot>
                        {product.status}
                      </Badge>
                    </Td>
                    <Td className="tabular-nums text-ink-600">
                      {product.mappingCount}
                    </Td>
                    <Td className="tabular-nums text-ink-600">
                      {["CODE", "CREDENTIALS"].includes(
                        product.deliveryKind,
                      ) ? (
                        <span
                          className={
                            product.availableCodes === 0 ? "text-rose-700" : ""
                          }
                        >
                          {product.availableCodes}
                        </span>
                      ) : (
                        "—"
                      )}
                    </Td>
                    <Td className="text-[12px] text-ink-500">
                      {product.claimExpiryDays} hari · {product.maxDeliveries}×
                    </Td>
                    <Td className="text-right text-[12px] text-ink-400">
                      {formatDateTime(product.createdAt)}
                    </Td>
                    <Td className="text-right">
                      {can("product:write") ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => void openEdit(product.id)}
                        >
                          <Pencil className="h-3.5 w-3.5" /> Ubah
                        </Button>
                      ) : null}
                    </Td>
                  </Tr>
                );
              })
            ) : null}
          </tbody>
        </TableShell>
        {!list.loading && list.data && list.data.data.length === 0 ? (
          <div className="p-5">
            <EmptyState
              title="Belum ada produk digital"
              description="Buat produk lebih dulu, unggah berkas atau isi kode, lalu petakan ke variasi Shopee."
              icon={<Package className="h-5 w-5" />}
              action={
                can("product:write") ? (
                  <Button onClick={() => setOpen(true)}>
                    <Plus className="h-4 w-4" /> Produk pertama
                  </Button>
                ) : null
              }
            />
          </div>
        ) : null}
        {list.data ? (
          <Pagination
            page={list.data.page}
            pageSize={list.data.pageSize}
            total={list.data.total}
            onPage={setPage}
          />
        ) : null}
      </SectionCard>

      <Dialog
        open={open}
        onOpenChange={setOpen}
        title={editingId ? "Ubah produk digital" : "Produk digital baru"}
        description={
          editingId
            ? "Perubahan berlaku untuk pesanan berikutnya dan tercatat di audit log."
            : "Bisa diubah kapan saja sebelum diaktifkan."
        }
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Batal
            </Button>
            <Button
              onClick={() => void save()}
              loading={busy}
              disabled={form.name.trim().length < 2}
            >
              {editingId ? "Simpan perubahan" : "Buat produk"}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Nama produk" htmlFor="name">
            <Input
              id="name"
              value={form.name}
              onChange={(event) =>
                setForm({ ...form, name: event.target.value })
              }
              placeholder="E-Meterai 1 Lembar"
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Tipe pengiriman">
              <Select
                value={form.deliveryKind}
                onValueChange={(value) =>
                  setForm({ ...form, deliveryKind: value })
                }
                options={Object.entries(DELIVERY_KIND).map(
                  ([value, label]) => ({ value, label }),
                )}
                className="w-full"
              />
            </Field>
            <Field label="Status awal">
              <Select
                value={form.status}
                onValueChange={(value) => setForm({ ...form, status: value })}
                options={[
                  { value: "DRAFT", label: "Draft" },
                  { value: "ACTIVE", label: "Aktif" },
                ]}
                className="w-full"
              />
            </Field>
          </div>
          {form.deliveryKind === "LINK" ? (
            <Field label="Tautan produk" htmlFor="url">
              <Input
                id="url"
                value={form.externalUrl}
                onChange={(event) =>
                  setForm({ ...form, externalUrl: event.target.value })
                }
                placeholder="https://drive.google.com/..."
              />
            </Field>
          ) : null}
          <label className="flex items-start gap-2.5 rounded-lg bg-canvas px-3 py-2.5 ring-1 ring-inset ring-line">
            <input
              type="checkbox"
              checked={form.meteraiEnabled}
              onChange={(event) =>
                setForm({ ...form, meteraiEnabled: event.target.checked })
              }
              className="mt-0.5 h-3.5 w-3.5 rounded border-line text-brand-700"
            />
            <span>
              <span className="block text-[12.5px] font-medium text-ink-800">
                Produk e-Meterai
              </span>
              <span className="block text-[11.5px] text-ink-500">
                Tautan dibuat per pesanan lewat akun e-Meterai, bukan dari stok
                kode.
              </span>
            </span>
          </label>
          <Field label="Deskripsi singkat" hint="opsional">
            <Textarea
              value={form.description}
              onChange={(event) =>
                setForm({ ...form, description: event.target.value })
              }
              placeholder="Tampil di portal klaim sebelum pembeli membuka produk."
            />
          </Field>
          {formError ? (
            <p className="text-[12.5px] text-rose-700">{formError}</p>
          ) : null}
        </div>
      </Dialog>
    </>
  );
}
