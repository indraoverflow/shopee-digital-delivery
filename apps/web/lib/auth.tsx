"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { ApiError, api } from "./api";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: "OWNER" | "ADMIN" | "OPERATOR" | "VIEWER";
  permissions: string[];
}

export interface MfaChallenge {
  mfaRequired: true;
  challengeToken: string;
  expiresAt: string;
}

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  /** Resolves to a challenge when the account needs a second factor. */
  login: (
    email: string,
    password: string,
  ) => Promise<MfaChallenge | { mfaRequired: false }>;
  completeMfa: (challengeToken: string, token: string) => Promise<void>;
  logout: () => Promise<void>;
  can: (permission: string) => boolean;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * The console shell is client-side: the API is the only source of truth about a
 * session, so a 401 anywhere sends the operator back to the login page instead
 * of showing an empty dashboard.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const result = await api.get<{ user: AuthUser }>("/auth/me");
      setUser(result.user);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const login = useCallback(
    async (email: string, password: string) => {
      const result = await api.post<{
        mfaRequired: boolean;
        user?: AuthUser;
        challengeToken?: string;
        expiresAt?: string;
      }>("/auth/login", { email, password });
      if (result.mfaRequired && result.challengeToken) {
        return {
          mfaRequired: true as const,
          challengeToken: result.challengeToken,
          expiresAt: result.expiresAt ?? "",
        };
      }
      if (result.user) setUser(result.user);
      router.push("/admin");
      return { mfaRequired: false as const };
    },
    [router],
  );

  const completeMfa = useCallback(
    async (challengeToken: string, token: string) => {
      const result = await api.post<{ user: AuthUser }>("/auth/2fa/challenge", {
        challengeToken,
        token,
      });
      setUser(result.user);
      router.push("/admin");
    },
    [router],
  );

  const logout = useCallback(async () => {
    await api.post("/auth/logout").catch(() => undefined);
    setUser(null);
    router.push("/login");
  }, [router]);

  const can = useCallback(
    (permission: string) => Boolean(user?.permissions.includes(permission)),
    [user],
  );

  const value = useMemo(
    () => ({ user, loading, login, completeMfa, logout, can, refresh }),
    [user, loading, login, completeMfa, logout, can, refresh],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside AuthProvider");
  return context;
}
