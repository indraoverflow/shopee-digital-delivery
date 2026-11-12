"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { motion } from "motion/react";
import {
  Boxes,
  ChevronLeft,
  ChevronsUpDown,
  Gauge,
  HeartPulse,
  LayoutGrid,
  ListOrdered,
  LogOut,
  Menu,
  PackageSearch,
  Settings,
  ShoppingBag,
  Sparkles,
  Store,
  Truck,
  X,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { useAuth } from "@/lib/auth";
import { Badge, Button, Skeleton } from "@/components/ui";

const NAV = [
  { href: "/admin", label: "Ringkasan", icon: Gauge, permission: "overview:read" },
  { href: "/admin/stores", label: "Toko Shopee", icon: Store, permission: "store:read" },
  { href: "/admin/catalog", label: "Katalog & Mapping", icon: Boxes, permission: "catalog:read" },
  { href: "/admin/products", label: "Produk Digital", icon: PackageSearch, permission: "product:read" },
  { href: "/admin/orders", label: "Pesanan", icon: ShoppingBag, permission: "order:read" },
  { href: "/admin/claims", label: "Klaim & Pengiriman", icon: Truck, permission: "claim:read" },
  { href: "/admin/monitoring", label: "Monitoring", icon: HeartPulse, permission: "monitoring:read" },
  { href: "/admin/settings", label: "Pengaturan", icon: Settings, permission: "overview:read" },
];

/** Collapsible console shell: sidebar, top bar, and the guard that keeps the console behind a session. */
export function AdminShell({ children }: { children: React.ReactNode }) {
  const { user, loading, logout, can } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [loading, user, router]);

  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  if (loading || !user) {
    return (
      <div className="mx-auto max-w-5xl space-y-4 p-6">
        <Skeleton className="h-8 w-56" />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-24" />
          ))}
        </div>
        <Skeleton className="h-64" />
      </div>
    );
  }

  const current = NAV.find((item) => (item.href === "/admin" ? pathname === "/admin" : pathname.startsWith(item.href)));

  return (
    <div className="flex min-h-dvh bg-canvas">
      <aside
        className={cn(
          "sticky top-0 hidden h-dvh shrink-0 flex-col border-r border-line bg-surface transition-[width] duration-200 lg:flex",
          collapsed ? "w-[68px]" : "w-[228px]",
        )}
      >
        <div className={cn("flex h-14 items-center gap-2.5 border-b border-line px-3", collapsed ? "justify-center" : "px-4")}>
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-700 text-[13px] font-semibold text-white">Q</span>
          {!collapsed ? (
            <div className="min-w-0 leading-tight">
              <p className="truncate text-[13px] font-semibold text-ink-950">Qansa</p>
              <p className="truncate text-[10.5px] text-ink-400">Digital Delivery</p>
            </div>
          ) : null}
        </div>

        <nav className="flex-1 space-y-0.5 overflow-y-auto p-2">
          {NAV.filter((item) => can(item.permission)).map((item) => {
            const active = item.href === "/admin" ? pathname === "/admin" : pathname.startsWith(item.href);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                title={collapsed ? item.label : undefined}
                className={cn(
                  "group relative flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] transition-colors",
                  active ? "bg-brand-50 font-medium text-brand-800" : "text-ink-600 hover:bg-canvas hover:text-ink-950",
                  collapsed ? "justify-center" : "",
                )}
              >
                {active ? <span className="absolute left-0 top-1.5 h-[calc(100%-12px)] w-0.5 rounded-full bg-brand-700" /> : null}
                <Icon className={cn("h-4 w-4 shrink-0", active ? "text-brand-700" : "text-ink-400 group-hover:text-ink-600")} />
                {!collapsed ? <span className="truncate">{item.label}</span> : null}
              </Link>
            );
          })}
        </nav>

        <div className="border-t border-line p-2">
          <button
            onClick={() => setCollapsed((value) => !value)}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-[12px] text-ink-400 hover:bg-canvas hover:text-ink-700"
          >
            <ChevronLeft className={cn("h-3.5 w-3.5 transition-transform", collapsed ? "rotate-180" : "")} />
            {!collapsed ? "Sembunyikan" : null}
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-line bg-surface/90 px-4 backdrop-blur">
          <button className="rounded-lg p-1.5 text-ink-500 hover:bg-canvas lg:hidden" onClick={() => setMobileOpen(true)} aria-label="Buka menu">
            <Menu className="h-5 w-5" />
          </button>

          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-medium text-ink-950">{current?.label ?? "Konsol"}</p>
            <p className="truncate text-[11px] text-ink-400">
              {new Date().toLocaleDateString("id-ID", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
            </p>
          </div>

          <div className="flex items-center gap-2">
            <span className="hidden sm:inline-flex">
              <Badge tone={user.role === "OWNER" ? "brand" : "neutral"}>{user.role}</Badge>
            </span>
            <div className="flex items-center gap-2 rounded-lg px-2 py-1.5 ring-1 ring-inset ring-line">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-ink-950/5 text-[11px] font-medium text-ink-700">
                {user.name.slice(0, 1).toUpperCase()}
              </span>
              <div className="hidden leading-tight sm:block">
                <p className="max-w-[140px] truncate text-[12px] font-medium text-ink-900">{user.name}</p>
                <p className="max-w-[140px] truncate text-[10.5px] text-ink-400">{user.email}</p>
              </div>
              <ChevronsUpDown className="hidden h-3 w-3 text-ink-300 sm:block" />
            </div>
            <Button variant="ghost" size="icon" onClick={() => void logout()} aria-label="Keluar">
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        </header>

        <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8">
          <motion.div key={pathname} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18, ease: "easeOut" }} className="mx-auto w-full max-w-[1180px]">
            {children}
          </motion.div>
        </main>

        <footer className="border-t border-line px-6 py-3 text-[11px] text-ink-300">
          Qansa Digital Delivery · gateway Shopee: {process.env.NEXT_PUBLIC_GATEWAY_LABEL ?? "sesuai konfigurasi"} · © {new Date().getFullYear()}
        </footer>
      </div>

      {mobileOpen ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-ink-950/40" onClick={() => setMobileOpen(false)} />
          <motion.div initial={{ x: -240 }} animate={{ x: 0 }} className="absolute inset-y-0 left-0 w-[248px] bg-surface p-3 shadow-float">
            <div className="mb-3 flex items-center justify-between">
              <span className="flex items-center gap-2 text-[13px] font-semibold text-ink-950">
                <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand-700 text-[11px] text-white">Q</span> Qansa
              </span>
              <button onClick={() => setMobileOpen(false)} aria-label="Tutup menu" className="rounded p-1 text-ink-400">
                <X className="h-4 w-4" />
              </button>
            </div>
            <nav className="space-y-0.5">
              {NAV.filter((item) => can(item.permission)).map((item) => {
                const active = item.href === "/admin" ? pathname === "/admin" : pathname.startsWith(item.href);
                const Icon = item.icon;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={cn("flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px]", active ? "bg-brand-50 font-medium text-brand-800" : "text-ink-600")}
                  >
                    <Icon className="h-4 w-4" /> {item.label}
                  </Link>
                );
              })}
            </nav>
          </motion.div>
        </div>
      ) : null}
    </div>
  );
}

export { LayoutGrid, ListOrdered, Sparkles };
