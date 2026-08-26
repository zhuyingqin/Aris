import React, { createContext, useCallback, useContext, useEffect, useState } from "react";

// The PWA under /remote/ owns the shared account-credential modules: both
// surfaces read the same localStorage keys and must renew them identically.
import { ACCOUNT_PROFILE_KEY, clearAccountSession } from "../../remote/src/account";
import {
  AccountSessionError,
  AccountTokenManager,
  accountRefreshUrl,
  extractAccessExpiry,
  extractAccessToken,
  extractAuthSessionId,
} from "../../remote/src/accountToken";
import { detectLang } from "../i18n";

export interface UserProfile {
  id: number;
  username: string;
  display_name?: string;
  email?: string;
  role: number;
  status: number;
  quota: number;
  used_quota: number;
  request_count?: number;
  created_at?: number;
  last_login_at?: number;
  group?: string;
  token?: string;
}

export interface UserLogItem {
  id: number;
  created_at: number;
  model_name: string;
  quota: number;
  prompt_tokens: number;
  completion_tokens: number;
  use_time: number;
}

export interface UserLogsData {
  total: number;
  items: UserLogItem[];
}

export interface FetchLogsParams {
  page?: number;
  pageSize?: number;
  startTimestamp?: number;
  endTimestamp?: number;
  modelName?: string;
}

export interface AuthContextType {
  user: UserProfile | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  authModalOpen: boolean;
  authModalMode: "login" | "register";
  dashboardOpen: boolean;
  login: (username: string, password: string) => Promise<{ success: boolean; message?: string }>;
  register: (username: string, password: string, email?: string) => Promise<{ success: boolean; message?: string }>;
  logout: () => void;
  refreshUser: () => Promise<void>;
  fetchUserLogs: (paramsOrPageSize?: number | FetchLogsParams) => Promise<UserLogsData | null>;
  openAuthModal: (mode?: "login" | "register") => void;
  closeAuthModal: () => void;
  openDashboard: () => void;
  closeDashboard: () => void;
  formatTokens: (quota: number, customUnit?: string) => string;
}

const AUTH_RETURN_TO_KEY = "somniq_auth_return_to_v1";

function localDashboardPreviewUser(): UserProfile | null {
  if (!import.meta.env.DEV || typeof window === "undefined") return null;
  if (window.location.hostname !== "127.0.0.1" && window.location.hostname !== "localhost") {
    return null;
  }
  if (new URLSearchParams(window.location.search).get("preview") !== "1") return null;
  return {
    id: -1,
    username: "local-preview",
    display_name: "本地预览",
    role: 1,
    status: 1,
    quota: 8_000_000,
    used_quota: 2_400_000,
    request_count: 128,
    created_at: Math.floor(Date.now() / 1000) - 30 * 86400,
    last_login_at: Math.floor(Date.now() / 1000),
    group: "开发预览",
  };
}

function consumeRemoteAuthReturnTo(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = sessionStorage.getItem(AUTH_RETURN_TO_KEY);
    sessionStorage.removeItem(AUTH_RETURN_TO_KEY);
    if (!stored) return null;
    const target = new URL(stored, window.location.href);
    return target.origin === window.location.origin && target.pathname.startsWith("/remote/")
      ? target.href
      : null;
  } catch {
    return null;
  }
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);


/**
 * One renewal state machine per document.
 *
 * new-api hands the browser a short-lived access token plus an HttpOnly,
 * rotating refresh cookie. Without renewal the dashboard simply stopped
 * working minutes after sign-in, which is what the expired-session banner was
 * reporting. Every panel shares this instance: two managers would rotate the
 * same cookie concurrently and invalidate each other.
 */
let tokenManager: AccountTokenManager | null = null;

export function accountTokens(): AccountTokenManager {
  if (!tokenManager) {
    tokenManager = new AccountTokenManager({
      // dashboard.html is served from the deployment root; the PWA resolves
      // the very same endpoint one directory up from its own base.
      refreshUrl: accountRefreshUrl(new URL("./", document.baseURI).href),
    });
  }
  return tokenManager;
}

/**
 * The cached profile is a convenience copy for first paint. The access token
 * is deliberately not mirrored into it: storage keeps exactly one copy of the
 * credential, under the keys the renewal manager owns.
 */
function persistProfile(profile: UserProfile): void {
  try {
    localStorage.setItem(ACCOUNT_PROFILE_KEY, JSON.stringify({ ...profile, token: undefined }));
  } catch {
    // ignore
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [authModalOpen, setAuthModalOpen] = useState<boolean>(false);
  const [authModalMode, setAuthModalMode] = useState<"login" | "register">("login");
  const [dashboardOpen, setDashboardOpen] = useState<boolean>(false);

  /**
   * Ends the local session after the account backend rejected the credential.
   * Leaving the cached profile in place would keep rendering a signed-in
   * shell whose every request fails.
   */
  const abandonSession = useCallback(() => {
    clearAccountSession();
    setUser(null);
  }, []);

  useEffect(() => {
    // Any panel can be the first to learn the credential died — the remote
    // device list polls on its own while pairing. Routing that verdict back
    // here is what turns it into a login prompt instead of an error banner on
    // a shell that still claims to be signed in.
    accountTokens().onExpired(abandonSession);
  }, [abandonSession]);

  const formatTokens = useCallback((quota: number, customUnit?: string): string => {
    let unit = customUnit;
    if (!unit) {
      const isEnglish =
        typeof window !== "undefined"
          ? detectLang() !== "zh"
          : typeof document !== "undefined" &&
            (document.documentElement.lang === "en" ||
              document.body?.classList?.contains("lang-en") ||
              document.querySelector(".lang-en") !== null);
      unit = isEnglish ? " Tokens" : " 词元";
    }
    if (!quota || quota <= 0) return `0${unit}`;
    if (quota >= 1_000_000) {
      return `${(quota / 1_000_000).toFixed(2)}M${unit}`;
    }
    if (quota >= 1_000) {
      return `${(quota / 1_000).toFixed(1)}k${unit}`;
    }
    return `${quota.toLocaleString()}${unit}`;
  }, []);

  const fetchSelf = useCallback(async () => {
    try {
      const res = await accountTokens().fetchWithSession((session) =>
        fetch("./v1/user/self", {
          method: "GET",
          cache: "no-store",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${session.accessToken}`,
            "New-Api-User": String(session.userId),
          },
        }),
      );
      if (!res.ok) return;
      const json = await res.json();
      if (json && json.success && json.data) {
        const rawUser = json.data;
        const u: UserProfile = {
          id: rawUser.id || 0,
          username: rawUser.username || "",
          display_name: rawUser.display_name || rawUser.username || "",
          email: rawUser.email || "",
          role: rawUser.role ?? 1,
          status: rawUser.status ?? 1,
          quota: rawUser.quota || 0,
          used_quota: rawUser.used_quota || 0,
          request_count: rawUser.request_count || 0,
          created_at: rawUser.created_at || (rawUser.request_count > 5000 ? 1782691674 : 0),
          last_login_at: rawUser.last_login_at || Math.floor(Date.now() / 1000),
          group: rawUser.group || "千研",
          token: accountTokens().peek()?.accessToken || "",
        };
        setUser(u);
        persistProfile(u);
      }
    } catch (error) {
      // Only a verdict from the account backend ends the session. Being
      // offline, or a renewal path the edge has not routed yet, must leave
      // the cached session alone.
      if (error instanceof AccountSessionError && error.reason !== "unavailable") {
        abandonSession();
      }
    }
  }, [abandonSession]);

  const fetchUserLogs = useCallback(
    async (paramsOrPageSize: number | FetchLogsParams = 50): Promise<UserLogsData | null> => {
      try {
        const p = typeof paramsOrPageSize === "number" ? 0 : (paramsOrPageSize.page ?? 0);
        const pageSize = typeof paramsOrPageSize === "number" ? paramsOrPageSize : (paramsOrPageSize.pageSize ?? 50);
        const startTimestamp = typeof paramsOrPageSize === "object" ? paramsOrPageSize.startTimestamp : undefined;
        const endTimestamp = typeof paramsOrPageSize === "object" ? paramsOrPageSize.endTimestamp : undefined;
        const modelName = typeof paramsOrPageSize === "object" ? paramsOrPageSize.modelName : undefined;

        let url = `./v1/user/logs?p=${p}&page_size=${pageSize}&type=2`;
        if (startTimestamp) url += `&start_timestamp=${startTimestamp}`;
        if (endTimestamp) url += `&end_timestamp=${endTimestamp}`;
        if (modelName && modelName !== "all") url += `&model_name=${encodeURIComponent(modelName)}`;

        const res = await accountTokens().fetchWithSession((session) =>
          fetch(url, {
            method: "GET",
            cache: "no-store",
            headers: {
              Accept: "application/json",
              Authorization: `Bearer ${session.accessToken}`,
              "New-Api-User": String(session.userId),
            },
          }),
        );

        if (res.ok) {
          const json = await res.json();
          if (json && json.success && json.data) {
            const rawData = json.data;
            const allItems: any[] = Array.isArray(rawData)
              ? rawData
              : Array.isArray(rawData.items)
              ? rawData.items
              : Array.isArray(rawData.list)
              ? rawData.list
              : [];

            const modelItems = allItems.filter(
              (item: any) => item.type === 2 || (item.model_name && item.model_name !== "")
            );
            const effectiveItems = modelItems.length > 0 ? modelItems : allItems;
            const total = typeof rawData.total === "number" ? rawData.total : (user?.request_count || effectiveItems.length);

            return {
              total,
              items: effectiveItems.map((item: any) => ({
                id: item.id || 0,
                created_at: item.created_at || 0,
                model_name: item.model_name || "MiniMax-M3",
                quota: item.quota || 0,
                prompt_tokens: item.prompt_tokens || 0,
                completion_tokens: item.completion_tokens || 0,
                use_time: item.use_time || 0,
              })),
            };
          }
        }
      } catch (error) {
        if (error instanceof AccountSessionError && error.reason !== "unavailable") {
          abandonSession();
        }
      }
      return null;
    },
    [abandonSession, user?.request_count]
  );

  // Initial load
  useEffect(() => {
    const previewUser = localDashboardPreviewUser();
    if (previewUser) {
      setUser(previewUser);
      setIsLoading(false);
      return;
    }
    try {
      const raw = localStorage.getItem(ACCOUNT_PROFILE_KEY);
      if (raw) {
        const cached = JSON.parse(raw);
        if (cached && cached.username) {
          setUser(cached);
        }
      }
    } catch {
      // ignore
    }

    fetchSelf().finally(() => setIsLoading(false));
  }, [fetchSelf]);

  const login = useCallback(
    async (username: string, password: string): Promise<{ success: boolean; message?: string }> => {
      try {
        const res = await fetch("./v1/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, password }),
        });

        const json = await res.json();
        if (res.ok && json && json.success) {
          const data = json.data ?? {};
          const accessToken = extractAccessToken(data);
          if (!accessToken) {
            // Without the short-lived token there is nothing to authorize the
            // dashboard, the remote gateway, or renewal itself with.
            return { success: false, message: "登录成功但未返回访问令牌，请联系管理员检查账号服务。" };
          }
          const rawUser = data.user || data;
          const u: UserProfile = {
            id: rawUser.id || 0,
            username: rawUser.username || username,
            display_name: rawUser.display_name || rawUser.username || username,
            email: rawUser.email || "",
            role: rawUser.role ?? 1,
            status: rawUser.status ?? 1,
            quota: rawUser.quota || 0,
            used_quota: rawUser.used_quota || 0,
            request_count: rawUser.request_count || 0,
            created_at: rawUser.created_at || (rawUser.request_count > 5000 ? 1782691674 : 0),
            group: rawUser.group || "千研",
            token: accessToken,
          };

          setUser(u);
          // The profile has to land before the credential: the renewal
          // manager reads the user id back out of it.
          persistProfile(u);
          accountTokens().rememberLogin({
            accessToken,
            expiresAt: extractAccessExpiry(data),
            authSessionId: extractAuthSessionId(data),
          });
          setAuthModalOpen(false);

          // Refresh in background to get complete profile & quota
          void fetchSelf();

          // A remote QR secret stays only in same-origin sessionStorage; it
          // never enters a return_to query parameter or a server access log.
          const remoteReturnTo = consumeRemoteAuthReturnTo();
          if (remoteReturnTo) {
            window.location.href = remoteReturnTo;
          } else if (typeof window !== "undefined" && !window.location.pathname.includes("dashboard")) {
            window.location.href = "./dashboard.html";
          }

          return { success: true };
        } else {
          return {
            success: false,
            message: json?.message || "Invalid username or password",
          };
        }
      } catch (err: any) {
        return {
          success: false,
          message: err?.message || "Network error. Please try again.",
        };
      }
    },
    [fetchSelf]
  );

  const register = useCallback(
    async (
      username: string,
      password: string,
      email?: string
    ): Promise<{ success: boolean; message?: string }> => {
      try {
        const payload: Record<string, string> = {
          username: username.trim(),
          password,
        };
        if (email && email.trim()) {
          payload.email = email.trim();
        }

        const res = await fetch("./v1/auth/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        const json = await res.json();
        if (res.ok && json && json.success) {
          // Immediately log in after successful registration
          const loginResult = await login(username, password);
          return {
            success: true,
            message: loginResult.message,
          };
        } else {
          return {
            success: false,
            message: json?.message || "Registration failed. Username may already exist.",
          };
        }
      } catch (err: any) {
        return {
          success: false,
          message: err?.message || "Network error. Please try again.",
        };
      }
    },
    [login]
  );

  const logout = useCallback(() => {
    setAuthModalOpen(false);
    setUser(null);
    setDashboardOpen(false);
    // Revoking the refresh session is what actually ends the sign-in now:
    // clearing local storage alone would leave a usable cookie behind. The
    // legacy `GET /v1/auth/logout` that used to run alongside this targeted
    // the pre-rc.25 cookie session, which no longer exists.
    void accountTokens().revoke();
    clearAccountSession();
    if (typeof window !== "undefined" && window.location.pathname.includes("dashboard")) {
      window.location.replace("./");
    }
  }, []);

  const openAuthModal = useCallback((mode: "login" | "register" = "login") => {
    setAuthModalMode(mode);
    setAuthModalOpen(true);
  }, []);

  const closeAuthModal = useCallback(() => {
    setAuthModalOpen(false);
  }, []);

  const openDashboard = useCallback(() => {
    setDashboardOpen(true);
  }, []);

  const closeDashboard = useCallback(() => {
    setDashboardOpen(false);
  }, []);

  const refreshUser = useCallback(async () => {
    await fetchSelf();
  }, [fetchSelf]);

  return (
    <AuthContext.Provider
      value={{
        user,
        isAuthenticated: !!user,
        isLoading,
        authModalOpen,
        authModalMode,
        dashboardOpen,
        login,
        register,
        logout,
        refreshUser,
        fetchUserLogs,
        openAuthModal,
        closeAuthModal,
        openDashboard,
        closeDashboard,
        formatTokens,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return ctx;
}
