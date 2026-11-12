"use client";

import Link from "next/link";
import { Activity, ArrowUpRight, Boxes, CircleDollarSign, PackageCheck, ShoppingBag, Store, Truck } from "lucide-react";
import { useApi } from "@/lib/hooks";
import { useAuth } from "@/lib/auth";
import { AreaChart } from "@/components/charts";
import { LoadingRows, SectionCard, StatCard, StatusBadge, TableShell, Td, Th, Tr } from "@/components/admin/kit";
import { Alert, Badge, Card, EmptyState, PageHeader, Skeleton } from "@/components/ui";
import { ORDER_STATE, formatNumber, formatRupiah, relativeTime } from "@/lib/format";

interface Overview {
  stores: { total: number; connected: number; errored: number };
  products: { shopee: number; digital: number; unmappedListings: number };
  orders: { total: number; paid: number; claimable: number; claimed: number; ineligible: number; awaitingSync: number; unmappedItems: number };
  claims: { successful: number; revoked: number; failedAttempts24h: number; attempts24h: number };
  pendingSync: number;
  series: { orders: Array<{ day: string; value: number }>; claims: Array<{ day: string; value: number }> };
  recentOrders: Array<{ id: string; orderSn: string; state: string; buyerUsername: string | null; totalAmount: string | null; syncedAt: string; storeLabel: string }>;
  activity: Array<{ id: string; action: string; actorLabel: string | null; targetType: string | null; createdAt: string }>;
  gatewayMode: "live" | "fixture";
}

const actionLabel: Record<string, string> = {
  "auth.login": "Masuk konsol",
  "store.create": "Menambah toko",
  "store.update": "Mengubah toko",
  "store.authorize_simulated": "Menyambungkan toko (simulasi)",
  "store.authorized": "Otorisasi toko selesai",
  "store.disconnect": "Memutus toko",
  "store.refresh_token": "Memperbarui token",
  "mapping.create": "Memetakan produk",
  "mapping.update": "Mengubah mapping",
  "mapping.delete": "Menghapus mapping",
  "digital_product.create": "Membuat produk digital",
  "digital_product.update": "Mengubah produk digital",
  "digital_product.archive": "Mengarsipkan produk",
  "digital_product.asset_upload": "Mengunggah berkas",
  "digital_product.codes_added": "Menambah kode",
  "claim.revoke": "Mencabut klaim",
  "fulfillment.reissue": "Menerbitkan ulang akses",
  "settings.update": "Mengubah pengaturan",
  "order.resync": "Memproses ulang pesanan",
};

export default function OverviewPage() {
  const { user } = useAuth();
  const { data, loading, error } = useApi<Overview>("/admin/overview");

  const series = (points: Array<{ day: string; value: number }> = []) =>
    points.map((point) => ({ label: point.day.slice(8), value: point.value }));

  return (
    <>
      <PageHeader
        title={`Selamat datang, ${user?.name.split(" ")[0] ?? "tim"}`}
        description="Ringkasan operasional hari ini: toko yang terhubung, pesanan yang menunggu klaim, dan aktivitas terakhir."
        actions={
          <Badge tone={data?.gatewayMode === "fixture" ? "warning" : "success"} dot>
            {data?.gatewayMode === "fixture" ? "Gateway: fixture" : "Gateway: live"}
          </Badge>
        }
      />

      {data?.gatewayMode === "fixture" ? (
        <div className="mb-5">
          <Alert tone="warning" title="Lingkungan simulasi aktif">
            Toko terhubung ke data contoh, bukan ke Shopee. Semua alur berjalan nyata: pemetaan, pesanan, dan klaim memakai data fixture.
            Untuk mode produksi, isi kredensial partner dan set <code className="font-mono text-[11.5px]">SHOPEE_GATEWAY_MODE=live</code>.
          </Alert>
        </div>
      ) : null}

      {error ? (
        <Alert tone="danger" title="Tidak bisa memuat ringkasan">
          {error.message}
        </Alert>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {loading || !data ? (
          Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} className="h-[104px]" />)
        ) : (
          <>
            <StatCard label="Toko terhubung" value={`${data.stores.connected}/${data.stores.total}`} hint={data.stores.errored > 0 ? `${data.stores.errored} toko bermasalah` : "Semua token sehat"} tone={data.stores.errored > 0 ? "warning" : "success"} icon={<Store className="h-4 w-4" />} />
            <StatCard label="Pesanan menunggu klaim" value={formatNumber(data.orders.claimable)} hint={`${formatNumber(data.orders.total)} pesanan tersinkron`} tone="brand" icon={<Truck className="h-4 w-4" />} />
            <StatCard label="Klaim berhasil" value={formatNumber(data.claims.successful)} hint={`${formatNumber(data.claims.attempts24h)} percobaan / 24 jam`} tone="success" icon={<PackageCheck className="h-4 w-4" />} />
            <StatCard label="Produk belum dipetakan" value={formatNumber(data.products.unmappedListings)} hint={`${formatNumber(data.orders.unmappedItems)} item pesanan tanpa mapping`} tone={data.products.unmappedListings > 0 ? "warning" : "neutral"} icon={<Boxes className="h-4 w-4" />} />
          </>
        )}
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <SectionCard
          className="lg:col-span-2"
          title="Tren 14 hari"
          description="Pesanan yang masuk dan klaim yang berhasil."
        >
          <div className="grid gap-5 px-5 py-4 sm:grid-cols-2">
            <div>
              <div className="mb-2 flex items-baseline justify-between">
                <p className="text-[12px] text-ink-500">Pesanan</p>
                <p className="text-[13px] font-medium tabular-nums text-ink-900">{data?.orders.total ?? 0}</p>
              </div>
              {data ? <AreaChart data={series(data.series.orders)} valueLabel="Pesanan per hari" /> : <Skeleton className="h-24" />}
            </div>
            <div>
              <div className="mb-2 flex items-baseline justify-between">
                <p className="text-[12px] text-ink-500">Klaim</p>
                <p className="text-[13px] font-medium tabular-nums text-ink-900">{data?.claims.successful ?? 0}</p>
              </div>
              {data ? <AreaChart data={series(data.series.claims)} valueLabel="Klaim per hari" /> : <Skeleton className="h-24" />}
            </div>
          </div>
          <div className="grid grid-cols-2 divide-x divide-line border-t border-line sm:grid-cols-4">
            {[
              { label: "Lunas", value: data?.orders.paid ?? 0 },
              { label: "Sudah diklaim", value: data?.orders.claimed ?? 0 },
              { label: "Belum lunas", value: data?.orders.ineligible ?? 0 },
              { label: "Sinkron tertunda", value: data?.pendingSync ?? 0 },
            ].map((item) => (
              <div key={item.label} className="px-5 py-3">
                <p className="text-[11.5px] text-ink-400">{item.label}</p>
                <p className="mt-0.5 text-[17px] font-semibold tabular-nums text-ink-950">{loading ? "—" : formatNumber(item.value)}</p>
              </div>
            ))}
          </div>
        </SectionCard>

        <SectionCard title="Aktivitas terakhir" description="Aksi admin dan peristiwa sistem.">
          <div className="px-2 py-2">
            {loading ? (
              <div className="space-y-3 p-3">
                {Array.from({ length: 5 }).map((_, index) => (
                  <Skeleton key={index} className="h-9" />
                ))}
              </div>
            ) : data && data.activity.length > 0 ? (
              <ul className="divide-y divide-line/70">
                {data.activity.map((entry) => (
                  <li key={entry.id} className="flex items-start gap-2.5 px-3 py-2.5">
                    <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-700">
                      <Activity className="h-3 w-3" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[12.5px] text-ink-800">{actionLabel[entry.action] ?? entry.action}</p>
                      <p className="truncate text-[11px] text-ink-400">
                        {entry.actorLabel ?? "sistem"} · {relativeTime(entry.createdAt)}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-3 py-6 text-center text-[12.5px] text-ink-400">Belum ada aktivitas.</p>
            )}
          </div>
        </SectionCard>
      </div>

      <div className="mt-4">
        <SectionCard
          title="Pesanan terbaru"
          description="Enam pesanan yang terakhir tersinkron dari Shopee."
          action={
            <Link href="/admin/orders" className="inline-flex items-center gap-1 text-[12.5px] font-medium text-brand-700 hover:text-brand-800">
              Semua pesanan <ArrowUpRight className="h-3.5 w-3.5" />
            </Link>
          }
        >
          <TableShell>
            <thead>
              <tr>
                <Th>Nomor pesanan</Th>
                <Th>Toko</Th>
                <Th>Pembeli</Th>
                <Th>Nilai</Th>
                <Th>Status</Th>
                <Th className="text-right">Sinkron</Th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <LoadingRows rows={4} cols={6} />
              ) : data && data.recentOrders.length > 0 ? (
                data.recentOrders.map((order) => (
                  <Tr key={order.id}>
                    <Td>
                      <Link href={`/admin/orders/${order.id}`} className="font-mono text-[12.5px] text-ink-900 hover:text-brand-700">
                        {order.orderSn}
                      </Link>
                    </Td>
                    <Td className="text-ink-500">{order.storeLabel}</Td>
                    <Td className="text-ink-500">{order.buyerUsername ?? "—"}</Td>
                    <Td className="tabular-nums">{formatRupiah(order.totalAmount)}</Td>
                    <Td>
                      <StatusBadge map={ORDER_STATE} value={order.state} />
                    </Td>
                    <Td className="text-right text-[12px] text-ink-400">{relativeTime(order.syncedAt)}</Td>
                  </Tr>
                ))
              ) : null}
            </tbody>
          </TableShell>
          {!loading && data && data.recentOrders.length === 0 ? (
            <div className="p-5">
              <EmptyState title="Belum ada pesanan" description="Hubungkan toko lalu jalankan sinkronisasi pesanan pertama." icon={<ShoppingBag className="h-5 w-5" />} />
            </div>
          ) : null}
        </SectionCard>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <Card className="p-4">
          <p className="text-[12px] text-ink-500">Produk Shopee tersinkron</p>
          <p className="mt-1 text-[22px] font-semibold tabular-nums text-ink-950">{formatNumber(data?.products.shopee ?? 0)}</p>
        </Card>
        <Card className="p-4">
          <p className="text-[12px] text-ink-500">Produk digital aktif</p>
          <p className="mt-1 text-[22px] font-semibold tabular-nums text-ink-950">{formatNumber(data?.products.digital ?? 0)}</p>
        </Card>
        <Card className="p-4">
          <p className="text-[12px] text-ink-500">Percobaan klaim gagal / 24 jam</p>
          <p className="mt-1 flex items-center gap-2 text-[22px] font-semibold tabular-nums text-ink-950">
            {formatNumber(data?.claims.failedAttempts24h ?? 0)}
            <CircleDollarSign className="h-4 w-4 text-ink-300" />
          </p>
        </Card>
      </div>
    </>
  );
}
