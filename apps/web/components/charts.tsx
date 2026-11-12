"use client";

import { useId } from "react";
import { cn } from "@/lib/cn";

/**
 * Charts are hand drawn SVG: two shapes cover the whole console, they render on
 * the server, and there is no charting dependency to keep current.
 */

export interface SeriesPoint {
  label: string;
  value: number;
}

export function AreaChart({ data, height = 96, tone = "brand", className, valueLabel }: { data: SeriesPoint[]; height?: number; tone?: "brand" | "ink"; className?: string; valueLabel?: string }) {
  const gradientId = useId();
  const width = 320;
  const max = Math.max(1, ...data.map((point) => point.value));
  const step = data.length > 1 ? width / (data.length - 1) : width;
  const points = data.map((point, index) => {
    const x = index * step;
    const y = height - (point.value / max) * (height - 12) - 6;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const line = points.length > 0 ? `M0,${height} L${points.join(" L")} L${width},${height} Z` : "";
  const stroke = tone === "brand" ? "var(--color-brand-600)" : "var(--color-ink-600)";

  return (
    <div className={cn("w-full", className)}>
      <svg viewBox={`0 0 ${width} ${height}`} className="h-24 w-full overflow-visible" role="img" aria-label={valueLabel ?? "Grafik tren"}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity="0.22" />
            <stop offset="100%" stopColor={stroke} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={line} fill={`url(#${gradientId})`} />
        <polyline points={points.join(" ")} fill="none" stroke={stroke} strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
        {data.length > 0 ? (
          <circle cx={Number(points[points.length - 1]?.split(",")[0] ?? 0)} cy={Number(points[points.length - 1]?.split(",")[1] ?? 0)} r="2.6" fill={stroke} />
        ) : null}
      </svg>
      <div className="mt-1 flex justify-between text-[10.5px] text-ink-300">
        <span>{data[0]?.label ?? ""}</span>
        <span>{data[data.length - 1]?.label ?? ""}</span>
      </div>
    </div>
  );
}

export function BarList({ data, emptyLabel = "Belum ada data", formatValue }: { data: SeriesPoint[]; emptyLabel?: string; formatValue?: (value: number) => string }) {
  const max = Math.max(1, ...data.map((point) => point.value));
  if (data.length === 0) return <p className="py-6 text-center text-[12.5px] text-ink-400">{emptyLabel}</p>;

  return (
    <ul className="space-y-2.5">
      {data.map((point) => (
        <li key={point.label}>
          <div className="mb-1 flex items-baseline justify-between gap-3 text-[12.5px]">
            <span className="truncate text-ink-600">{point.label}</span>
            <span className="tabular-nums font-medium text-ink-800">{formatValue ? formatValue(point.value) : point.value}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-ink-950/[0.06]">
            <div className="h-full rounded-full bg-brand-600/80 transition-[width] duration-500" style={{ width: `${Math.max(3, (point.value / max) * 100)}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

export function Sparkline({ values, className }: { values: number[]; className?: string }) {
  const max = Math.max(1, ...values);
  const height = 32;
  const width = 88;
  const step = values.length > 1 ? width / (values.length - 1) : width;
  const points = values.map((value, index) => `${(index * step).toFixed(1)},${(height - (value / max) * (height - 6) - 3).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className={cn("h-8 w-[88px]", className)} aria-hidden>
      <polyline points={points} fill="none" stroke="var(--color-brand-600)" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
