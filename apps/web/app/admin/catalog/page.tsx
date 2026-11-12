"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Boxes, ChevronDown, Link2, Search, Trash2 } from "lucide-react";
import { ApiError, api } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { useAuth } from "@/lib/auth";
import { SectionCard } from "@/components/admin/kit";
import { Alert, Badge, Button, EmptyState, Input, PageHeader, Pagination, Select, Skeleton, useDebounced, useToast } from "@/components/ui";
import { formatNumber, formatRupiah } from "@/lib/format";

interface DigitalProductOption {
  id: string;
  name: string;
  deliveryKind: string;
  status: string;
}

interface MappingRef {
  id: string;
  digitalProductId: string;
  digitalProductName: string;
  digitalProductStatus: string;
  quantityMultiplier: number;
}

interface CatalogProduct {
  id: string;
  storeId: string;
  storeLabel: string;
  itemId: number;
  name: string;
  status: string | null;
  priceMin: string | null;
  priceMax: string | null;
  syncedAt: string;
  mapped: boolean;
  listingMapping: MappingRef | null;
  variations: Array<{ id: string; modelId: number; name: string; sku: string | null; price: string | null; stock: number | null; mapping: MappingRef | null }>;
}

export default function CatalogPage() {
  const { can } = useAuth();
  const { toast } = useToast();
  const [storeId, setStoreId] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [page, setPage] = useState(1);
  const debounced = useDebounced(search);

  const stores = useApi<{ data: Array<{ id: string; label: string }> }>("/admin/stores");
  const digital = useApi<{ data: DigitalProductOption[] }>("/admin/digital-products?pageSize=100&status=ACTIVE");

  useEffect(() => {
    if (!storeId && stores.data?.data?.[0]) setStoreId(stores.data.data[0].id);
  }, [stores.data, storeId]);

  const query = useMemo(() => {
    const params = new URLSearchParams({ page: String(page), pageSize: "12", mapped: filter });
    if (storeId) params.set("storeId", storeId);
    if (debounced.trim()) params.set("query", debounced.trim());
    return `/admin/catalog?${params.toString()}`;
  }, [storeId, debounced, filter, page]);

  const catalog = useApi<{ data: CatalogProduct[]; total: number; page: number; pageSize: number }>(storeId ? query : null, [storeId]);

  const refresh = () => {
    catalog.refresh();
    digital.refresh();
  };

  return (
    <>
      <PageHeader
        title="Katalog & Mapping"
        description="Setiap variasi Shopee harus dipetakan ke satu produk digital. Tanpa mapping, pesanan tetap tersimpan tetapi tidak bisa diklaim."
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Select
          value={storeId}
          onValueChange={(value) => {
            setStoreId(value);
            setPage(1);
          }}
          options={(stores.data?.data ?? []).map((store) => ({ value: store.id, label: store.label }))}
          placeholder="Pilih toko"
          className="min-w-44"
        />
        <div className="relative min-w-56 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-300" />
          <Input
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
            placeholder="Cari nama produk Shopee"
            className="h-9 pl-9 text-[13px]"
          />
        </div>
        <div className="flex rounded-lg bg-surface p-0.5 ring-1 ring-inset ring-line">
          {[
            { value: "all", label: "Semua" },
            { value: "unmapped", label: "Belum dipetakan" },
            { value: "mapped", label: "Sudah dipetakan" },
          ].map((option) => (
            <button
              key={option.value}
              onClick={() => {
                setFilter(option.value);
                setPage(1);
              }}
              className={`rounded-md px-2.5 py-1.5 text-[12px] font-medium transition-colors ${filter === option.value ? "bg-ink-950 text-white" : "text-ink-500 hover:text-ink-800"}`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {catalog.error ? (
        <Alert tone="danger" title="Gagal memuat katalog">
          {catalog.error.message}
        </Alert>
      ) : null}

      {catalog.loading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, index) => (
            <Skeleton key={index} className="h-40" />
          ))}
        </div>
      ) : catalog.data && catalog.data.data.length > 0 ? (
        <div className="space-y-3">
          {catalog.data.data.map((product) => (
            <CatalogCard key={product.id} product={product} digital={digital.data?.data ?? []} onChanged={refresh} canWrite={can("mapping:write")} toast={toast} />
          ))}
        </div>
      ) : (
        <EmptyState
          title="Katalog masih kosong"
          description="Jalankan sinkronisasi produk pada halaman toko, lalu kembali ke sini untuk memetakan variasi."
          icon={<Boxes className="h-5 w-5" />}
        />
      )}

      {catalog.data ? (
        <div className="mt-3 overflow-hidden rounded-xl bg-surface ring-1 ring-line">
          <Pagination page={catalog.data.page} pageSize={catalog.data.pageSize} total={catalog.data.total} onPage={setPage} />
        </div>
      ) : null}

      <div className="mt-4">
        <SectionCard title="Cara kerja mapping" description="Aturan yang dipakai mesin pemenuhan.">
          <ul className="space-y-2 p-5 text-[12.5px] leading-relaxed text-ink-600">
            <li>1. Mapping variasi menang atas mapping tingkat listing: pembeli mendapat produk sesuai paket yang dibeli.</li>
            <li>2. Multiplier mengalikan jumlah yang dibeli. Paket 5 lisensi dapat dipetakan dengan multiplier 5.</li>
            <li>3. Bila dua mapping aktif menunjuk variasi yang sama, sistem menandai pesanan sebagai ambigu dan tidak menyerahkan produk.</li>
            <li>4. Produk digital berstatus DRAFT atau ARCHIVED membuat fulfillment tertahan sampai diaktifkan.</li>
          </ul>
        </SectionCard>
      </div>
    </>
  );
}

function CatalogCard({
  product,
  digital,
  onChanged,
  canWrite,
  toast,
}: {
  product: CatalogProduct;
  digital: DigitalProductOption[];
  onChanged: () => void;
  canWrite: boolean;
  toast: (input: { title: string; description?: string; tone?: "success" | "danger" | "warning" | "info" }) => void;
}) {
  const [open, setOpen] = useState(!product.mapped);
  const [busy, setBusy] = useState(false);
  const options = [{ value: "", label: "— belum dipetakan —" }, ...digital.map((item) => ({ value: item.id, label: `${item.name} · ${item.deliveryKind}` }))];

  const save = async (variationId: string | null, digitalProductId: string, multiplier: number) => {
    setBusy(true);
    try {
      if (!digitalProductId) return;
      await api.post("/admin/mappings", {
        shopeeProductId: product.id,
        shopeeVariationId: variationId,
        digitalProductId,
        quantityMultiplier: multiplier,
      });
      toast({ title: "Mapping disimpan", description: product.name });
      onChanged();
    } catch (caught) {
      toast({ title: "Gagal menyimpan mapping", description: caught instanceof ApiError ? caught.message : "", tone: "danger" });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (mappingId: string) => {
    setBusy(true);
    try {
      await api.delete(`/admin/mappings/${mappingId}`);
      toast({ title: "Mapping dihapus" });
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const rows = product.variations.length > 0 ? product.variations : [{ id: "", modelId: 0, name: "Tanpa variasi (seluruh listing)", sku: null, price: product.priceMin, stock: null, mapping: product.listingMapping }];

  return (
    <div className={`overflow-hidden rounded-xl bg-surface shadow-card ring-1 ${product.mapped ? "ring-line" : "ring-amber-600/30"}`}>
      <button onClick={() => setOpen((value) => !value)} className="flex w-full items-start justify-between gap-3 px-5 py-4 text-left">
        <div className="flex min-w-0 items-start gap-3">
          <span className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${product.mapped ? "bg-brand-50 text-brand-700" : "bg-amber-100 text-amber-600"}`}>
            {product.mapped ? <Link2 className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
          </span>
          <div className="min-w-0">
            <p className="truncate text-[13.5px] font-medium text-ink-950">{product.name}</p>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-ink-400">
              <span className="font-mono">item {product.itemId}</span>
              <span>·</span>
              <span>{product.storeLabel}</span>
              <span>·</span>
              <span>{product.variations.length} variasi</span>
              <span>·</span>
              <span>{product.priceMin ? formatRupiah(product.priceMin) : "harga tidak tersedia"}</span>
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Badge tone={product.mapped ? "success" : "warning"}>{product.mapped ? "Siap" : "Perlu mapping"}</Badge>
          <ChevronDown className={`h-4 w-4 text-ink-400 transition-transform ${open ? "rotate-180" : ""}`} />
        </div>
      </button>

      {open ? (
        <div className="border-t border-line bg-canvas/40 px-5 py-3">
          <div className="space-y-2">
            {rows.map((row) => (
              <MappingRow
                key={row.id || `listing-${product.id}`}
                variationName={row.name}
                price={row.price}
                stock={row.stock}
                mapping={row.mapping}
                options={options}
                disabled={!canWrite || busy}
                onSave={(digitalProductId, multiplier) => void save(row.id || null, digitalProductId, multiplier)}
                onRemove={row.mapping ? () => void remove(row.mapping!.id) : undefined}
              />
            ))}
          </div>
          {digital.length === 0 ? (
            <p className="mt-2 text-[11.5px] text-amber-600">Belum ada produk digital ACTIVE. Buat dulu di menu Produk Digital.</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function MappingRow({
  variationName,
  price,
  stock,
  mapping,
  options,
  disabled,
  onSave,
  onRemove,
}: {
  variationName: string;
  price: string | null;
  stock: number | null;
  mapping: MappingRef | null;
  options: Array<{ value: string; label: string }>;
  disabled: boolean;
  onSave: (digitalProductId: string, multiplier: number) => void;
  onRemove?: () => void;
}) {
  const [selected, setSelected] = useState(mapping?.digitalProductId ?? "");
  const [multiplier, setMultiplier] = useState(String(mapping?.quantityMultiplier ?? 1));

  useEffect(() => {
    setSelected(mapping?.digitalProductId ?? "");
    setMultiplier(String(mapping?.quantityMultiplier ?? 1));
  }, [mapping]);

  const dirty = selected !== (mapping?.digitalProductId ?? "") || Number(multiplier) !== (mapping?.quantityMultiplier ?? 1);

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg bg-surface px-3 py-2 ring-1 ring-inset ring-line">
      <div className="min-w-0 flex-1">
        <p className="truncate text-[12.5px] text-ink-800">{variationName}</p>
        <p className="text-[11px] text-ink-400">
          {price ? formatRupiah(price) : "—"}
          {stock !== null ? ` · stok ${formatNumber(stock)}` : ""}
        </p>
      </div>
      <Select value={selected} onValueChange={setSelected} options={options} placeholder="Pilih produk digital" className="h-8 min-w-48 text-[12px]" disabled={disabled} />
      <Input
        value={multiplier}
        onChange={(event) => setMultiplier(event.target.value.replace(/\D/g, "").slice(0, 3))}
        className="h-8 w-16 text-center text-[12px]"
        aria-label="Multiplier jumlah"
        disabled={disabled}
      />
      <Button size="sm" variant={dirty ? "primary" : "secondary"} disabled={disabled || !selected || !dirty} onClick={() => onSave(selected, Math.max(1, Number(multiplier) || 1))}>
        Simpan
      </Button>
      {onRemove ? (
        <Button size="icon" variant="ghost" onClick={onRemove} disabled={disabled} aria-label="Hapus mapping">
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      ) : null}
    </div>
  );
}
