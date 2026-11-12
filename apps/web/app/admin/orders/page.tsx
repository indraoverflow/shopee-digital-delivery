"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Search } from "lucide-react";
import { useApi } from "@/lib/hooks";
import { LoadingRows, SectionCard, StatusBadge, TableShell, Td, Th, Tr } from "@/components/admin/kit";
import { Alert, Badge, Input, PageHeader, Pagination, Select, useDebounced } from "@/components/ui";
import { ORDER_STATE, formatNumber, formatRupiah, relativeTime } from "@/lib/format";

interface OrderRow {
  id: string;
  orderSn: string;
  buyerUsername: string | null;
  shopeeStatus: string | null;
  state: string;
  totalAmount: string | null;
  storeLabel: string;
  items: number;
  unmappedItems: number;
  fulfillments: number;
  claimable: number;
  claimed: number;
  syncedAt: string;
}

export default function OrdersPage() {
  const [page, setPage] = useState(1);
  const [state, setState] = useState("all");
  const [storeId, setStoreId] = useState("all");
  const [search, setSearch] = useState("");
  const [mapping, setMapping] = useState("all");
  const debounced = useDebounced(search);

  const stores = useApi<{ data: Array<{ id: string; label: string }> }>("/admin/stores");

  const query = useMemo(() => {
    const params = new URLSearchParams({ page: String(page), pageSize: "20", mapping });
    if (state !== "all") params.set("state", state);
    if (storeId !== "all") params.set("storeId", storeId);
    if (debounced.trim()) params.set("query", debounced.trim());
    return `/admin/orders?${params.toString()}`;
  }, [page, state, storeId, debounced, mapping]);

  const orders = useApi<{ data: OrderRow[]; total: number; page: number; pageSize: number }>(query);

  useEffect(() => {
    setPage(1);
  }, [state, storeId, debounced, mapping]);

  return (
    <>
      <PageHeader title="Pesanan" description="Pesanan yang tersinkron dari Shopee, lengkap dengan status pemetaan dan pemenuhan." />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-300" />
          <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Cari nomor pesanan atau pembeli" className="h-9 pl-9 text-[13px]" />
        </div>
        <Select
          value={storeId}
          onValueChange={setStoreId}
          options={[{ value: "all", label: "Semua toko" }, ...(stores.data?.data ?? []).map((store) => ({ value: store.id, label: store.label }))]}
          className="min-w-40"
        />
        <Select
          value={state}
          onValueChange={setState}
          options={[{ value: "all", label: "Semua status" }, ...Object.entries(ORDER_STATE).map(([value, meta]) => ({ value, label: meta.label }))]}
          className="min-w-40"
        />
        <Select
          value={mapping}
          onValueChange={setMapping}
          options={[
            { value: "all", label: "Semua mapping" },
            { value: "unmapped", label: "Ada item tanpa mapping" },
            { value: "mapped", label: "Semua item terpetakan" },
          ]}
          className="min-w-48"
        />
      </div>

      {orders.error ? (
        <Alert tone="danger" title="Gagal memuat pesanan">
          {orders.error.message}
        </Alert>
      ) : null}

      <SectionCard title="Daftar pesanan" description={orders.data ? `${formatNumber(orders.data.total)} pesanan` : undefined}>
        <TableShell>
          <thead>
            <tr>
              <Th>Nomor</Th>
              <Th>Toko</Th>
              <Th>Pembeli</Th>
              <Th>Nilai</Th>
              <Th>Status</Th>
              <Th>Item</Th>
              <Th>Klaim</Th>
              <Th className="text-right">Sinkron</Th>
            </tr>
          </thead>
          <tbody>
            {orders.loading ? (
              <LoadingRows rows={8} cols={8} />
            ) : orders.data && orders.data.data.length > 0 ? (
              orders.data.data.map((order) => (
                <Tr key={order.id}>
                  <Td>
                    <Link href={`/admin/orders/${order.id}`} className="font-mono text-[12.5px] font-medium text-ink-900 hover:text-brand-700">
                      {order.orderSn}
                    </Link>
                    {order.shopeeStatus ? <p className="text-[10.5px] uppercase tracking-wide text-ink-300">{order.shopeeStatus}</p> : null}
                  </Td>
                  <Td className="text-[12px] text-ink-500">{order.storeLabel}</Td>
                  <Td className="text-[12.5px] text-ink-600">{order.buyerUsername ?? "—"}</Td>
                  <Td className="tabular-nums text-ink-700">{formatRupiah(order.totalAmount)}</Td>
                  <Td>
                    <StatusBadge map={ORDER_STATE} value={order.state} />
                  </Td>
                  <Td className="tabular-nums text-[12px] text-ink-500">
                    {order.items}
                    {order.unmappedItems > 0 ? (
                      <span className="ml-1.5 inline-flex items-center gap-0.5 text-amber-600" title={`${order.unmappedItems} item tanpa mapping`}>
                        <AlertTriangle className="h-3 w-3" />
                      </span>
                    ) : null}
                  </Td>
                  <Td>
                    {order.fulfillments === 0 ? (
                      <span className="text-[12px] text-ink-300">belum ada</span>
                    ) : (
                      <span className="text-[12px] text-ink-600">
                        {order.claimed}/{order.fulfillments} diambil
                        {order.claimable > 0 ? <Badge tone="success" className="ml-1.5">{order.claimable} siap</Badge> : null}
                      </span>
                    )}
                  </Td>
                  <Td className="text-right text-[12px] text-ink-400">{relativeTime(order.syncedAt)}</Td>
                </Tr>
              ))
            ) : null}
          </tbody>
        </TableShell>
        {orders.data ? <Pagination page={orders.data.page} pageSize={orders.data.pageSize} total={orders.data.total} onPage={setPage} /> : null}
      </SectionCard>
    </>
  );
}
