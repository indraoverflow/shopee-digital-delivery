"use client";

import { use, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Eye, Hash, Save, Trash2, Upload } from "lucide-react";
import { ApiError, api } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { useAuth } from "@/lib/auth";
import { DetailRow, KeyValue, SectionCard, StatusBadge } from "@/components/admin/kit";
import { Alert, Badge, Button, Field, Input, PageHeader, Select, Skeleton, Textarea, useToast } from "@/components/ui";
import { DELIVERY_KIND, fileSize, formatDateTime } from "@/lib/format";

interface ProductDetail {
  product: {
    id: string;
    name: string;
    slug: string;
    description: string | null;
    deliveryKind: string;
    instructions: string | null;
    externalUrl: string | null;
    status: "DRAFT" | "ACTIVE" | "ARCHIVED";
    claimExpiryDays: number;
    maxDeliveries: number;
    createdAt: string;
    archivedAt: string | null;
  };
  assets: Array<{ id: string; fileName: string; sizeBytes: number; mimeType: string; createdAt: string }>;
  mappings: Array<{ id: string; productName: string; variationName: string | null; storeLabel: string; quantityMultiplier: number }>;
  codes: { total: number; available: number };
}

interface PreviewResponse {
  product: { name: string; deliveryKind: string; instructions: string | null; status: string };
  sample: Record<string, unknown>;
  warnings: string[];
}

export default function DigitalProductDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { can } = useAuth();
  const { toast } = useToast();
  const detail = useApi<ProductDetail>(`/admin/digital-products/${id}`);
  const codes = useApi<{ data: Array<{ id: string; label: string | null; assignedClaimId: string | null; assignedAt: string | null; createdAt: string }> }>(`/admin/digital-products/${id}/codes`);
  const preview = useApi<PreviewResponse>(`/admin/digital-products/${id}/preview`);
  const fileInput = useRef<HTMLInputElement>(null);

  const [form, setForm] = useState({ name: "", description: "", instructions: "", externalUrl: "", status: "DRAFT", claimExpiryDays: "30", maxDeliveries: "3" });
  const [busy, setBusy] = useState<string | null>(null);
  const [codesText, setCodesText] = useState("");

  useEffect(() => {
    if (!detail.data) return;
    const product = detail.data.product;
    setForm({
      name: product.name,
      description: product.description ?? "",
      instructions: product.instructions ?? "",
      externalUrl: product.externalUrl ?? "",
      status: product.status,
      claimExpiryDays: String(product.claimExpiryDays),
      maxDeliveries: String(product.maxDeliveries),
    });
  }, [detail.data]);

  const save = async () => {
    setBusy("save");
    try {
      await api.patch(`/admin/digital-products/${id}`, {
        name: form.name,
        description: form.description || undefined,
        instructions: form.instructions || undefined,
        externalUrl: form.externalUrl || undefined,
        status: form.status,
        claimExpiryDays: Number(form.claimExpiryDays),
        maxDeliveries: Number(form.maxDeliveries),
      });
      toast({ title: "Produk disimpan" });
      detail.refresh();
      preview.refresh();
    } catch (caught) {
      toast({ title: "Gagal menyimpan", description: caught instanceof ApiError ? caught.message : "", tone: "danger" });
    } finally {
      setBusy(null);
    }
  };

  const upload = async (file: File) => {
    setBusy("upload");
    const formData = new FormData();
    formData.append("file", file);
    try {
      await api.upload(`/admin/digital-products/${id}/assets`, formData);
      toast({ title: "Berkas diunggah", description: file.name });
      detail.refresh();
      preview.refresh();
    } catch (caught) {
      toast({ title: "Upload gagal", description: caught instanceof ApiError ? caught.message : "", tone: "danger" });
    } finally {
      setBusy(null);
    }
  };

  const addCodes = async () => {
    const list = codesText
      .split(/[\n,;]+/)
      .map((value) => value.trim())
      .filter(Boolean);
    if (list.length === 0) return;
    setBusy("codes");
    try {
      const result = await api.post<{ added: number }>(`/admin/digital-products/${id}/codes`, { codes: list });
      toast({ title: `${result.added} kode ditambahkan` });
      setCodesText("");
      codes.refresh();
      detail.refresh();
      preview.refresh();
    } catch (caught) {
      toast({ title: "Gagal menambah kode", description: caught instanceof ApiError ? caught.message : "", tone: "danger" });
    } finally {
      setBusy(null);
    }
  };

  const removeCode = async (codeId: string) => {
    try {
      await api.delete(`/admin/digital-products/${id}/codes/${codeId}`);
      codes.refresh();
      detail.refresh();
    } catch (caught) {
      toast({ title: "Tidak bisa menghapus", description: caught instanceof ApiError ? caught.message : "", tone: "danger" });
    }
  };

  const product = detail.data?.product;

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Produk Digital", href: "/admin/products" }, { label: product?.name ?? "Detail" }]}
        title={product?.name ?? "Detail produk"}
        description={product ? `${DELIVERY_KIND[product.deliveryKind]} · ${product.slug}` : undefined}
        actions={
          <div className="flex items-center gap-2">
            <Link href="/admin/products" className="inline-flex items-center gap-1 text-[12.5px] text-ink-500 hover:text-ink-900">
              <ArrowLeft className="h-3.5 w-3.5" /> Kembali
            </Link>
            {product ? <Badge tone={product.status === "ACTIVE" ? "success" : product.status === "DRAFT" ? "warning" : "neutral"} dot>{product.status}</Badge> : null}
          </div>
        }
      />

      {detail.error ? (
        <Alert tone="danger" title="Produk tidak ditemukan">
          {detail.error.message}
        </Alert>
      ) : null}

      {preview.data && preview.data.warnings.length > 0 ? (
        <div className="mb-4">
          <Alert tone="warning" title="Produk belum siap dijual">
            <ul className="list-inside list-disc space-y-0.5">
              {preview.data.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </Alert>
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <SectionCard title="Detail produk" description="Konten ini yang dilihat pembeli di portal klaim.">
            {detail.loading ? (
              <div className="space-y-3 p-5">
                <Skeleton className="h-10" />
                <Skeleton className="h-20" />
              </div>
            ) : (
              <div className="space-y-4 p-5">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Nama produk" htmlFor="pname">
                    <Input id="pname" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} disabled={!can("product:write")} />
                  </Field>
                  <Field label="Status">
                    <Select
                      value={form.status}
                      onValueChange={(value) => setForm({ ...form, status: value })}
                      options={[
                        { value: "DRAFT", label: "Draft (tidak bisa diklaim)" },
                        { value: "ACTIVE", label: "Aktif" },
                        { value: "ARCHIVED", label: "Arsip" },
                      ]}
                      className="w-full"
                      disabled={!can("product:write")}
                    />
                  </Field>
                </div>
                <Field label="Deskripsi" hint="tampil sebelum pembeli membuka produk">
                  <Textarea value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} disabled={!can("product:write")} />
                </Field>
                <Field label="Instruksi" hint="tampil setelah produk dibuka">
                  <Textarea value={form.instructions} onChange={(event) => setForm({ ...form, instructions: event.target.value })} disabled={!can("product:write")} />
                </Field>
                {product?.deliveryKind === "LINK" ? (
                  <Field label="Tautan produk" htmlFor="purl">
                    <Input id="purl" value={form.externalUrl} onChange={(event) => setForm({ ...form, externalUrl: event.target.value })} disabled={!can("product:write")} />
                  </Field>
                ) : null}
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Masa klaim (hari)" htmlFor="expiry">
                    <Input id="expiry" value={form.claimExpiryDays} inputMode="numeric" onChange={(event) => setForm({ ...form, claimExpiryDays: event.target.value.replace(/\D/g, "").slice(0, 3) })} disabled={!can("product:write")} />
                  </Field>
                  <Field label="Batas pengambilan" htmlFor="deliveries" hint="per klaim">
                    <Input id="deliveries" value={form.maxDeliveries} inputMode="numeric" onChange={(event) => setForm({ ...form, maxDeliveries: event.target.value.replace(/\D/g, "").slice(0, 2) })} disabled={!can("product:write")} />
                  </Field>
                </div>
                {can("product:write") ? (
                  <div className="flex justify-end">
                    <Button onClick={() => void save()} loading={busy === "save"}>
                      <Save className="h-4 w-4" /> Simpan perubahan
                    </Button>
                  </div>
                ) : null}
              </div>
            )}
          </SectionCard>

          {product?.deliveryKind === "FILE" ? (
            <SectionCard title="Berkas produk" description="Maksimal 50 MB. Berkas disimpan privat dan hanya keluar lewat tautan bertanda tangan.">
              <div className="p-5">
                {detail.data?.assets.length ? (
                  <div className="space-y-2">
                    {detail.data.assets.map((asset) => (
                      <div key={asset.id} className="flex items-center justify-between gap-3 rounded-lg bg-canvas px-3 py-2.5 ring-1 ring-inset ring-line">
                        <div className="min-w-0">
                          <p className="truncate text-[12.5px] text-ink-800">{asset.fileName}</p>
                          <p className="text-[11px] text-ink-400">
                            {fileSize(asset.sizeBytes)} · {asset.mimeType} · {formatDateTime(asset.createdAt)}
                          </p>
                        </div>
                        <Badge tone="success">siap</Badge>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-[12.5px] text-ink-400">Belum ada berkas. Pembeli tidak bisa mengambil produk sampai berkas diunggah.</p>
                )}

                {can("product:write") ? (
                  <div className="mt-3">
                    <input
                      ref={fileInput}
                      type="file"
                      className="hidden"
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file) void upload(file);
                      }}
                    />
                    <Button variant="secondary" onClick={() => fileInput.current?.click()} loading={busy === "upload"}>
                      <Upload className="h-4 w-4" /> {detail.data?.assets.length ? "Ganti berkas" : "Unggah berkas"}
                    </Button>
                  </div>
                ) : null}
              </div>
            </SectionCard>
          ) : null}

          {["CODE", "CREDENTIALS"].includes(product?.deliveryKind ?? "") ? (
            <SectionCard
              title="Stok kode"
              description={`${detail.data?.codes.available ?? 0} tersedia dari ${detail.data?.codes.total ?? 0}. Setiap klaim mengambil satu kode, tidak pernah dibagikan dua kali.`}
            >
              <div className="space-y-4 p-5">
                {can("product:write") ? (
                  <div>
                    <Field label="Tambah kode" hint="satu per baris, atau pisahkan dengan koma">
                      <Textarea value={codesText} onChange={(event) => setCodesText(event.target.value)} placeholder={"MTR-AAAA-1111\nMTR-BBBB-2222"} className="font-mono text-[12px]" />
                    </Field>
                    <div className="mt-2 flex justify-end">
                      <Button size="sm" onClick={() => void addCodes()} loading={busy === "codes"} disabled={codesText.trim().length === 0}>
                        <Hash className="h-3.5 w-3.5" /> Simpan kode
                      </Button>
                    </div>
                  </div>
                ) : null}

                <div className="max-h-64 space-y-1.5 overflow-y-auto">
                  {codes.data?.data.length ? (
                    codes.data.data.map((code) => (
                      <div key={code.id} className="flex items-center justify-between gap-2 rounded-lg bg-canvas px-3 py-1.5 ring-1 ring-inset ring-line">
                        <code className="font-mono text-[12px] text-ink-700">{code.label ?? "••••"}</code>
                        {code.assignedClaimId ? (
                          <Badge tone="brand">terkirim</Badge>
                        ) : (
                          <div className="flex items-center gap-1.5">
                            <Badge tone="neutral">tersedia</Badge>
                            {can("product:write") ? (
                              <button onClick={() => void removeCode(code.id)} className="text-ink-300 hover:text-rose-700" aria-label="Hapus kode">
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            ) : null}
                          </div>
                        )}
                      </div>
                    ))
                  ) : (
                    <p className="text-[12.5px] text-ink-400">Belum ada kode.</p>
                  )}
                </div>
              </div>
            </SectionCard>
          ) : null}
        </div>

        <div className="space-y-4">
          <SectionCard title="Pratinjau pembeli" description="Yang akan dilihat pembeli setelah verifikasi.">
            <div className="space-y-3 p-5">
              <div className="rounded-xl bg-canvas p-3 ring-1 ring-inset ring-line">
                <p className="text-[11px] uppercase tracking-wide text-ink-400">Tipe</p>
                <p className="text-[13px] font-medium text-ink-900">{DELIVERY_KIND[product?.deliveryKind ?? ""] ?? "—"}</p>
                <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-surface p-2 font-mono text-[11px] leading-relaxed text-ink-600 ring-1 ring-inset ring-line">
                  {preview.data ? JSON.stringify(preview.data.sample, null, 2) : "memuat…"}
                </pre>
              </div>
              <p className="flex items-start gap-1.5 text-[11.5px] leading-relaxed text-ink-400">
                <Eye className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                Pratinjau tidak mengambil kode dari stok dan tidak membuat klaim.
              </p>
            </div>
          </SectionCard>

          <SectionCard title="Mapping aktif" description="Variasi Shopee yang mengarah ke produk ini.">
            <div className="p-5">
              {detail.data?.mappings.length ? (
                <div className="space-y-2">
                  {detail.data.mappings.map((mapping) => (
                    <div key={mapping.id} className="rounded-lg bg-canvas px-3 py-2 ring-1 ring-inset ring-line">
                      <p className="truncate text-[12.5px] text-ink-800">{mapping.productName}</p>
                      <p className="truncate text-[11px] text-ink-400">
                        {mapping.variationName ?? "seluruh listing"} · {mapping.storeLabel} · ×{mapping.quantityMultiplier}
                      </p>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-[12.5px] text-ink-400">Belum dipetakan ke variasi mana pun.</p>
              )}
              <div className="mt-3">
                <Link href="/admin/catalog" className="text-[12.5px] font-medium text-brand-700 hover:text-brand-800">
                  Buka halaman mapping →
                </Link>
              </div>
            </div>
          </SectionCard>

          <SectionCard title="Metadata">
            <div className="px-5 py-2">
              <DetailRow label="Slug" mono>
                {product?.slug ?? "—"}
              </DetailRow>
              <DetailRow label="Dibuat">{product ? formatDateTime(product.createdAt) : "—"}</DetailRow>
              <DetailRow label="Diarsipkan">{product?.archivedAt ? formatDateTime(product.archivedAt) : "—"}</DetailRow>
              <div className="grid grid-cols-2 gap-2 py-3">
                <KeyValue label="Kode total" value={detail.data?.codes.total ?? 0} />
                <KeyValue label="Kode siap" value={detail.data?.codes.available ?? 0} />
              </div>
              <div className="pb-3">
                <StatusBadge map={{ ACTIVE: { label: "Aktif", tone: "success", description: "" }, DRAFT: { label: "Draft", tone: "warning", description: "" }, ARCHIVED: { label: "Arsip", tone: "neutral", description: "" } }} value={product?.status} />
              </div>
            </div>
          </SectionCard>
        </div>
      </div>
    </>
  );
}
