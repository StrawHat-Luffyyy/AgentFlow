import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ApiError, api } from "../api.js";

export interface Principal { id: string; roles: string[]; username?: string }

interface SessionValue {
  principal: Principal | null;
  checking: boolean;
  /** Set when the API rejected the session; shown on the login page. */
  notice: string | null;
  signIn: (username: string, password: string) => Promise<void>;
  signOut: () => void;
  /** Call on any 401 from the API: clears the session and explains why. */
  expire: () => void;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [principal, setPrincipal] = useState<Principal | null>(null);
  const [checking, setChecking] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    api.me()
      .then((identity) => { if (active) setPrincipal(identity); })
      .catch(() => { if (active) setPrincipal(null); })
      .finally(() => { if (active) setChecking(false); });
    return () => { active = false; };
  }, []);

  const signIn = useCallback(async (username: string, password: string) => {
    const result = await api.login(username, password);
    setNotice(null);
    setPrincipal(result.user);
  }, []);
  const signOut = useCallback(() => {
    void api.logout().finally(() => { setPrincipal(null); setNotice(null); });
  }, []);
  const expire = useCallback(() => {
    setPrincipal(null);
    setNotice("Your session has expired. Sign in again to continue.");
  }, []);

  const value = useMemo(() => ({ principal, checking, notice, signIn, signOut, expire }), [principal, checking, notice, signIn, signOut, expire]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession must be used inside SessionProvider");
  return value;
}

export function errorMessage(cause: unknown, fallback = "Something went wrong"): string {
  if (cause instanceof ApiError) {
    if (cause.status === 0) return "The AgentFlow API is unreachable. Check that it is running.";
    return cause.message;
  }
  return cause instanceof Error ? cause.message : fallback;
}

export interface PollState<T> {
  data: T | null;
  error: string | null;
  /** True only until the first response (success or failure). */
  loading: boolean;
  /** True while a background refresh is in flight. */
  refreshing: boolean;
  updatedAt: number | null;
  refresh: () => Promise<void>;
}

/**
 * Loads data now and then every `intervalMs`, keeping the last good data on errors
 * (so the UI never blanks) and expiring the session on a 401.
 */
export function usePolling<T>(load: () => Promise<T>, deps: readonly unknown[], intervalMs = 1_500): PollState<T> {
  const { expire } = useSession();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const generation = useRef(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  const refresh = useCallback(async () => {
    const current = generation.current;
    setRefreshing(true);
    try {
      const next = await loadRef.current();
      if (current !== generation.current) return;
      setData(next);
      setError(null);
      setUpdatedAt(Date.now());
    } catch (cause) {
      if (current !== generation.current) return;
      if (cause instanceof ApiError && cause.status === 401) { expire(); return; }
      setError(errorMessage(cause));
    } finally {
      if (current === generation.current) { setLoading(false); setRefreshing(false); }
    }
  }, [expire]);

  useEffect(() => {
    generation.current += 1;
    setData(null);
    setLoading(true);
    void refresh();
    if (intervalMs <= 0) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, intervalMs);
    return () => window.clearInterval(timer);
    // deps identify *what* is loaded; a change starts a fresh load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, intervalMs, refresh]);

  return { data, error, loading, refreshing, updatedAt, refresh };
}

/** Re-renders every `intervalMs` so relative times stay current. */
export function useNow(intervalMs = 1_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}
