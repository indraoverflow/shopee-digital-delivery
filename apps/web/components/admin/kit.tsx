"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Badge, Card, Skeleton } from "@/components/ui";
import { meta, type StateMeta } from "@/lib/format";
import type { Tone } from "@/lib/format";

/** Small building blocks shared by every console page. */

export function StatCard({ label, value, hint, tone = "neutral", icon }: { label: string; value: ReactNode; hint?: string; tone?: Tone; icon?: ReactNode }) {
  const accents: Record<Tone, string> = {
    neutral: "text-ink-950",
    success: "text-brand-700",
    brand: "text-brand-700",
    warning: "text-amber-600",
    danger: "text-rose-700",
    info: "text-sky-700",
  };
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-2">
        <p className="text-[12px] font-medium text-ink-500">{label}</p>
        {icon ? <span className="text-ink-300">{icon}</span> : null}
      </div>
      <p className={cn("mt-2 text-[26px] font-semibold leading-none tabular-nums", accents[tone])}>{value}</p>
      {hint ? <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-400">{hint}</p> : null}
    </Card>
  );
}

export function StatusBadge({ map, value }: { map: Record<string, StateMeta>; value: string | null | undefined }) {
  const state = meta(map, value);
  return (
    <Badge tone={state.tone} dot>
      {state.label}
    </Badge>
  );
}

export function TableShell({ children, footer, className }: { children: ReactNode; footer?: ReactNode; className?: string }) {
  return (
    <Card className={cn("overflow-hidden", className)}>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] border-collapse text-left text-[13px]">{children}</table>
      </div>
      {footer}
    </Card>
  );
}

export function Th({ children, className }: { children?: ReactNode; className?: string }) {
  return <th className={cn("border-b border-line bg-canvas/50 px-4 py-2.5 text-[11.5px] font-medium uppercase tracking-wide text-ink-400", className)}>{children}</th>;
}

export function Td({ children, className, colSpan }: { children?: ReactNode; className?: string; colSpan?: number }) {
  return (
    <td colSpan={colSpan} className={cn("border-b border-line/70 px-4 py-3 align-middle text-ink-700", className)}>
      {children}
    </td>
  );
}

export function Tr({ children, onClick, className }: { children: ReactNode; onClick?: () => void; className?: string }) {
  return (
    <tr onClick={onClick} className={cn("transition-colors hover:bg-canvas/60", onClick ? "cursor-pointer" : "", className)}>
      {children}
    </tr>
  );
}

export function LoadingRows({ rows = 6, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <tr key={rowIndex} className="border-b border-line/70">
          {Array.from({ length: cols }).map((__, colIndex) => (
            <td key={colIndex} className="px-4 py-3.5">
              <Skeleton className={cn("h-3.5", colIndex === 0 ? "w-40" : colIndex === cols - 1 ? "w-16" : "w-24")} />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

export function SectionCard({ title, description, action, children, className }: { title: string; description?: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <Card className={cn("overflow-hidden", className)}>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4">
        <div>
          <h2 className="text-[14.5px] font-semibold text-ink-950">{title}</h2>
          {description ? <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-500">{description}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </Card>
  );
}

export function DetailRow({ label, children, mono }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-line/60 py-2.5 last:border-0">
      <span className="shrink-0 text-[12px] text-ink-400">{label}</span>
      <span className={cn("min-w-0 text-right text-[12.5px] text-ink-800", mono ? "font-mono" : "")}>{children}</span>
    </div>
  );
}

export function KeyValue({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="rounded-lg bg-canvas px-3 py-2.5 ring-1 ring-inset ring-line">
      <p className="text-[11px] uppercase tracking-wide text-ink-400">{label}</p>
      <p className={cn("mt-1 truncate text-[13px] text-ink-900", mono ? "font-mono" : "")}>{value}</p>
    </div>
  );
}

export function ProgressBar({ value, max, tone = "brand" }: { value: number; max: number; tone?: "brand" | "amber" | "rose" }) {
  const ratio = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  const colours = { brand: "bg-brand-600", amber: "bg-amber-600", rose: "bg-rose-700" };
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-ink-950/[0.07]">
      <div className={cn("h-full rounded-full transition-[width] duration-500", colours[tone])} style={{ width: `${Math.max(ratio, 2)}%` }} />
    </div>
  );
}
