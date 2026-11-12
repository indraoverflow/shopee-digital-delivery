import { LoginForm } from "@/components/admin/login-form";
import { AuthProvider } from "@/lib/auth";
import { ToastProvider } from "@/components/ui";

export const metadata = { title: "Masuk konsol" };

export default function LoginPage() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-canvas px-4 py-10">
      <div className="w-full max-w-[400px]">
        <div className="mb-8 flex flex-col items-center text-center">
          <span className="mb-4 flex h-11 w-11 items-center justify-center rounded-2xl bg-brand-700 text-[17px] font-semibold text-white">Q</span>
          <h1 className="text-[22px] font-semibold text-ink-950">Konsol Qansa</h1>
          <p className="mt-1.5 text-[13px] text-ink-500">Kelola toko Shopee, produk digital, dan klaim pembeli.</p>
        </div>
        <AuthProvider>
          <ToastProvider>
            <LoginForm />
          </ToastProvider>
        </AuthProvider>
        <p className="mt-6 text-center text-[11.5px] text-ink-400">
          Akses dibatasi untuk staf Qansa. Aktivitas administratif dicatat dalam audit log.
        </p>
      </div>
    </main>
  );
}
