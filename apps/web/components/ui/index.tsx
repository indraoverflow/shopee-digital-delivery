"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as SelectPrimitive from "@radix-ui/react-select";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { AnimatePresence, motion } from "motion/react";
import { Check, ChevronDown, Loader2, X } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/cn";
import type { Tone } from "@/lib/format";

/* --------------------------------------------------------------- button */

const buttonStyles = cva(
  "inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-[background-color,color,box-shadow,transform] duration-150 disabled:pointer-events-none disabled:opacity-50 active:translate-y-px",
  {
    variants: {
      variant: {
        primary: "bg-brand-700 text-white shadow-sm hover:bg-brand-800",
        secondary: "bg-surface text-ink-800 ring-1 ring-inset ring-line hover:bg-canvas",
        ghost: "text-ink-600 hover:bg-ink-950/5 hover:text-ink-950",
        danger: "bg-rose-700 text-white hover:bg-rose-700/90",
        outline: "bg-transparent text-ink-800 ring-1 ring-inset ring-line-strong hover:bg-surface",
      },
      size: {
        sm: "h-8 px-3 text-[13px]",
        md: "h-10 px-4 text-sm",
        lg: "h-11 px-5 text-[15px]",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonStyles> {
  loading?: boolean;
}

export function Button({ className, variant, size, loading, children, disabled, ...props }: ButtonProps) {
  return (
    <button className={cn(buttonStyles({ variant, size }), className)} disabled={disabled || loading} {...props}>
      {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
      {children}
    </button>
  );
}

/* ---------------------------------------------------------------- inputs */

const fieldBase =
  "w-full rounded-lg bg-surface px-3 text-sm text-ink-800 shadow-sm ring-1 ring-inset ring-line transition-colors placeholder:text-ink-300 focus:ring-2 focus:ring-brand-500 disabled:opacity-60";

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(fieldBase, "h-10", className)} {...props} />;
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(fieldBase, "min-h-24 py-2 leading-relaxed", className)} {...props} />;
}

export function Label({ className, children, htmlFor, hint }: { className?: string; children: ReactNode; htmlFor?: string; hint?: string }) {
  return (
    <label htmlFor={htmlFor} className={cn("mb-1.5 flex items-baseline justify-between gap-3 text-[13px] font-medium text-ink-700", className)}>
      <span>{children}</span>
      {hint ? <span className="text-[11px] font-normal text-ink-400">{hint}</span> : null}
    </label>
  );
}

export function Field({ label, hint, error, htmlFor, children }: { label: string; hint?: string; error?: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div>
      <Label htmlFor={htmlFor} {...(hint ? { hint } : {})}>
        {label}
      </Label>
      {children}
      {error ? <p className="mt-1.5 text-[12px] text-rose-700">{error}</p> : null}
    </div>
  );
}

/* ----------------------------------------------------------------- cards */

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("rounded-xl bg-surface shadow-card ring-1 ring-line", className)}>{children}</div>;
}

export function CardHeader({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("border-b border-line px-5 py-4", className)}>{children}</div>;
}

export function CardTitle({ className, children }: { className?: string; children: ReactNode }) {
  return <h3 className={cn("text-[15px] font-semibold text-ink-950", className)}>{children}</h3>;
}

export function CardDescription({ className, children }: { className?: string; children: ReactNode }) {
  return <p className={cn("mt-1 text-[13px] leading-relaxed text-ink-500", className)}>{children}</p>;
}

export function CardContent({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("px-5 py-4", className)}>{children}</div>;
}

/* ---------------------------------------------------------------- badges */

const badgeTones: Record<Tone, string> = {
  neutral: "bg-ink-950/5 text-ink-600 ring-ink-950/10",
  success: "bg-brand-100 text-brand-800 ring-brand-200",
  brand: "bg-brand-700 text-white ring-brand-700",
  warning: "bg-amber-100 text-amber-600 ring-amber-600/20",
  danger: "bg-rose-100 text-rose-700 ring-rose-700/20",
  info: "bg-sky-100 text-sky-700 ring-sky-700/20",
};

export function Badge({ tone = "neutral", children, className, dot }: { tone?: Tone; children: ReactNode; className?: string; dot?: boolean }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11.5px] font-medium ring-1 ring-inset", badgeTones[tone], className)}>
      {dot ? <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" aria-hidden /> : null}
      {children}
    </span>
  );
}

/* ---------------------------------------------------------------- states */

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-md bg-ink-950/[0.06]", className)} aria-hidden />;
}

export function EmptyState({ title, description, action, icon }: { title: string; description?: string; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-line-strong bg-surface/60 px-6 py-14 text-center">
      {icon ? <div className="flex h-11 w-11 items-center justify-center rounded-full bg-brand-100 text-brand-700">{icon}</div> : null}
      <div>
        <p className="text-sm font-medium text-ink-950">{title}</p>
        {description ? <p className="mx-auto mt-1 max-w-sm text-[13px] leading-relaxed text-ink-500">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function Alert({ tone = "info", title, children, action }: { tone?: Tone; title: string; children?: ReactNode; action?: ReactNode }) {
  const tones: Record<Tone, string> = {
    neutral: "bg-canvas ring-line",
    success: "bg-brand-50 ring-brand-200",
    brand: "bg-brand-50 ring-brand-200",
    warning: "bg-amber-100/60 ring-amber-600/20",
    danger: "bg-rose-100/70 ring-rose-700/20",
    info: "bg-sky-100/60 ring-sky-700/20",
  };
  return (
    <div className={cn("flex items-start gap-3 rounded-xl px-4 py-3 ring-1 ring-inset", tones[tone])}>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold text-ink-950">{title}</p>
        {children ? <div className="mt-1 text-[12.5px] leading-relaxed text-ink-600">{children}</div> : null}
      </div>
      {action}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn("h-4 w-4 animate-spin text-ink-400", className)} aria-hidden />;
}

/* ---------------------------------------------------------------- dialog */

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children?: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-ink-950/40 backdrop-blur-[2px] data-[state=open]:animate-in data-[state=open]:fade-in" />
        <DialogPrimitive.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-xl bg-surface p-5 shadow-float ring-1 ring-line">
          <div className="flex items-start justify-between gap-4">
            <div>
              <DialogPrimitive.Title className="text-[15px] font-semibold text-ink-950">{title}</DialogPrimitive.Title>
              {description ? <DialogPrimitive.Description className="mt-1 text-[13px] text-ink-500">{description}</DialogPrimitive.Description> : null}
            </div>
            <DialogPrimitive.Close className="rounded-md p-1 text-ink-400 hover:bg-ink-950/5 hover:text-ink-800">
              <X className="h-4 w-4" />
              <span className="sr-only">Tutup</span>
            </DialogPrimitive.Close>
          </div>
          {children ? <div className="mt-4">{children}</div> : null}
          {footer ? <div className="mt-5 flex justify-end gap-2">{footer}</div> : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Lanjutkan",
  destructive,
  onConfirm,
  loading,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  confirmLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  loading?: boolean;
  children?: ReactNode;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      {...(description ? { description } : {})}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Batal
          </Button>
          <Button variant={destructive ? "danger" : "primary"} onClick={onConfirm} loading={loading}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </Dialog>
  );
}

/* ---------------------------------------------------------------- select */

export function Select({
  value,
  onValueChange,
  options,
  placeholder,
  className,
  disabled,
}: {
  value: string;
  onValueChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <SelectPrimitive.Root value={value} onValueChange={onValueChange} disabled={disabled}>
      <SelectPrimitive.Trigger
        className={cn(
          "inline-flex h-9 min-w-40 items-center justify-between gap-2 rounded-lg bg-surface px-3 text-[13px] text-ink-800 shadow-sm ring-1 ring-inset ring-line hover:bg-canvas",
          className,
        )}
      >
        <SelectPrimitive.Value placeholder={placeholder ?? "Pilih"} />
        <SelectPrimitive.Icon>
          <ChevronDown className="h-3.5 w-3.5 text-ink-400" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content className="z-50 overflow-hidden rounded-lg bg-surface shadow-float ring-1 ring-line" position="popper" sideOffset={4}>
          <SelectPrimitive.Viewport className="p-1">
            {options.map((option) => (
              <SelectPrimitive.Item
                key={option.value}
                value={option.value}
                className="relative flex cursor-default select-none items-center rounded-md py-1.5 pl-7 pr-3 text-[13px] text-ink-700 outline-none data-[highlighted]:bg-brand-50 data-[highlighted]:text-brand-800"
              >
                <SelectPrimitive.ItemIndicator className="absolute left-2">
                  <Check className="h-3.5 w-3.5" />
                </SelectPrimitive.ItemIndicator>
                <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

/* ---------------------------------------------------------------- switch */

export function Switch({ checked, onCheckedChange, label }: { checked: boolean; onCheckedChange: (value: boolean) => void; label?: string }) {
  return (
    <label className="flex items-center gap-2 text-[13px] text-ink-600">
      <SwitchPrimitive.Root
        checked={checked}
        onCheckedChange={onCheckedChange}
        className="relative h-5 w-9 rounded-full bg-ink-950/15 transition-colors data-[state=checked]:bg-brand-600"
      >
        <SwitchPrimitive.Thumb className="block h-4 w-4 translate-x-0.5 rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-[18px]" />
      </SwitchPrimitive.Root>
      {label}
    </label>
  );
}

/* ------------------------------------------------------------------ tabs */

export function Tabs({ tabs, value, onValueChange }: { tabs: Array<{ value: string; label: string; count?: number }>; value: string; onValueChange: (value: string) => void }) {
  return (
    <TabsPrimitive.Root value={value} onValueChange={onValueChange}>
      <TabsPrimitive.List className="no-scrollbar flex gap-1 overflow-x-auto border-b border-line">
        {tabs.map((tab) => (
          <TabsPrimitive.Trigger
            key={tab.value}
            value={tab.value}
            className="relative whitespace-nowrap px-3 py-2 text-[13px] font-medium text-ink-500 transition-colors hover:text-ink-800 data-[state=active]:text-ink-950"
          >
            {tab.label}
            {tab.count !== undefined ? <span className="ml-1.5 rounded-full bg-ink-950/5 px-1.5 py-0.5 text-[11px] text-ink-500">{tab.count}</span> : null}
            <span className="absolute inset-x-0 -bottom-px h-0.5 scale-x-0 bg-brand-700 transition-transform data-[state=active]:scale-x-100" />
          </TabsPrimitive.Trigger>
        ))}
      </TabsPrimitive.List>
    </TabsPrimitive.Root>
  );
}

/* ----------------------------------------------------------------- toast */

interface Toast {
  id: string;
  title: string;
  description?: string;
  tone: Tone;
}

interface ToastContextValue {
  toast: (input: { title: string; description?: string; tone?: Tone }) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);

  const remove = useCallback((id: string) => {
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  const toast = useCallback(
    (input: { title: string; description?: string; tone?: Tone }) => {
      const id = Math.random().toString(36).slice(2);
      setItems((current) => [...current.slice(-3), { id, tone: input.tone ?? "success", title: input.title, ...(input.description ? { description: input.description } : {}) }]);
      setTimeout(() => remove(id), 5000);
    },
    [remove],
  );

  const value = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[min(92vw,360px)] flex-col gap-2">
        <AnimatePresence initial={false}>
          {items.map((item) => (
            <motion.div
              key={item.id}
              layout
              initial={{ opacity: 0, y: 12, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.98 }}
              transition={{ duration: 0.18, ease: "easeOut" }}
              className="pointer-events-auto rounded-xl bg-ink-950 px-4 py-3 text-white shadow-float"
            >
              <div className="flex items-start gap-3">
                <span
                  className={cn("mt-1 h-2 w-2 shrink-0 rounded-full", {
                    "bg-emerald-400": item.tone === "success" || item.tone === "brand",
                    "bg-amber-400": item.tone === "warning",
                    "bg-rose-400": item.tone === "danger",
                    "bg-sky-400": item.tone === "info",
                    "bg-white/50": item.tone === "neutral",
                  })}
                />
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-medium">{item.title}</p>
                  {item.description ? <p className="mt-0.5 text-[12px] leading-relaxed text-white/70">{item.description}</p> : null}
                </div>
                <button onClick={() => remove(item.id)} className="rounded p-0.5 text-white/50 hover:text-white" aria-label="Tutup notifikasi">
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) throw new Error("useToast must be used inside ToastProvider");
  return context;
}

/* ------------------------------------------------------------- pagination */

export function Pagination({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (page: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total === 0) return null;

  return (
    <div className="flex items-center justify-between gap-3 border-t border-line px-5 py-3 text-[12.5px] text-ink-500">
      <span>
        Menampilkan {Math.min(total, (page - 1) * pageSize + 1)}–{Math.min(total, page * pageSize)} dari {total}
      </span>
      <div className="flex items-center gap-1">
        <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          Sebelumnya
        </Button>
        <span className="px-2 tabular-nums text-ink-600">
          {page} / {pages}
        </span>
        <Button variant="secondary" size="sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>
          Berikutnya
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ misc */

export function PageHeader({ title, description, actions, breadcrumbs }: { title: string; description?: string; actions?: ReactNode; breadcrumbs?: Array<{ label: string; href?: string }> }) {
  return (
    <div className="mb-6">
      {breadcrumbs && breadcrumbs.length > 0 ? (
        <nav className="mb-2 flex items-center gap-1.5 text-[12px] text-ink-400">
          {breadcrumbs.map((crumb, index) => (
            <span key={`${crumb.label}-${index}`} className="flex items-center gap-1.5">
              {index > 0 ? <span className="text-ink-300">/</span> : null}
              {crumb.href ? (
                <a href={crumb.href} className="hover:text-ink-700">
                  {crumb.label}
                </a>
              ) : (
                <span className="text-ink-600">{crumb.label}</span>
              )}
            </span>
          ))}
        </nav>
      ) : null}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-semibold text-ink-950">{title}</h1>
          {description ? <p className="mt-1 max-w-2xl text-[13.5px] leading-relaxed text-ink-500">{description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </div>
  );
}

export function useDebounced<T>(value: T, delay = 350): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}
