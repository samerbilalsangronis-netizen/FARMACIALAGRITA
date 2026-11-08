"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Catalog, Grant, Profile, QueuedSale, Receipt } from "./domain";
import { adjustedNow, enroll, expired, hasVault, persist, unlock, type Vault, type VaultSession } from "./vault";
import { rpc, signIn, supabase } from "./supabase";

export type Connection = "online" | "offline" | "syncing" | "error";
const accessError = (error: unknown) => error instanceof Error ? error.message : "No se pudo completar la operación.";
export { accessError };

export function useOperation() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [local, setLocal] = useState<Vault | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [connection, setConnection] = useState<Connection>("offline");
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [prepared, setPrepared] = useState(false);
  const [workerReady, setWorkerReady] = useState(false);
  const [syncProblem, setSyncProblem] = useState("");
  const historyLimit = useRef(500);
  const [historyTruncated, setHistoryTruncated] = useState(false);
  const session = useRef<VaultSession | null>(null);
  const active = useRef<Profile | null>(null);
  const actionQueue = useRef<Promise<unknown>>(Promise.resolve());
  const authenticated = useRef(false);
  const syncInFlight = useRef<Promise<void> | null>(null);

  const serialize = useCallback(<T,>(action: () => Promise<T>): Promise<T> => {
    const result = actionQueue.current.then(action, action);
    actionQueue.current = result.catch(() => undefined);
    return result;
  }, []);

  const refreshHistory = useCallback(async (limit = historyLimit.current, isCurrent = () => Boolean(active.current)) => {
    const rows: Receipt[] = [];
    let hasMore = false;
    for (let offset = 0; offset < limit; offset += 500) {
      const { data, error } = await supabase().from("sales")
        .select("id,occurred_at,cashier_name,customer_id,customer_name,total,discount,fiscal_status,reconciliation,sale_items(product_id,name,quantity,unit_price),sale_payments(currency,method,amount,change_amount,usd,rate),fiscal_transfers(invoice,fiscal_date,note)")
        .order("occurred_at", { ascending: false }).order("id", { ascending: false }).range(offset, offset + 500);
      if (error) throw new Error(error.message);
      if (!isCurrent()) return;
      rows.push(...data.slice(0, 500) as unknown as Receipt[]);
      hasMore = data.length > 500;
      if (!hasMore) break;
    }
    if (!isCurrent()) return;
    historyLimit.current = limit;
    setReceipts(rows);
    setHistoryTruncated(hasMore);
  }, []);

  const loadMoreHistory = useCallback(() => serialize(async () => {
    if (!authenticated.current) throw new Error("Conéctate para cargar más operaciones.");
    await refreshHistory(historyLimit.current + 500);
  }), [refreshHistory, serialize]);

  async function obtainProfile() {
    const { data: identity, error: identityError } = await supabase().auth.getUser();
    if (identityError || !identity.user) throw new Error("Vuelve a iniciar sesión para sincronizar.");
    const { data, error } = await supabase().from("profiles").select("id,username,role").eq("id", identity.user.id).eq("active", true).single();
    if (error || !data) throw new Error("El usuario no tiene acceso activo.");
    return data as Profile;
  }

  async function updateVault(next: Vault) {
    const current = session.current;
    if (!current) throw new Error("Desbloquea primero el dispositivo.");
    session.current = await persist(current, { ...next, lastActivity: Date.now() });
    setLocal(session.current.vault);
  }

  const sync = useCallback((renew = false): Promise<void> => {
    if (syncInFlight.current) {
      return renew ? syncInFlight.current.then(() => sync(renew)) : syncInFlight.current;
    }
    const user = active.current;
    const sameSession = () => active.current === user && authenticated.current;
    if (!user) return Promise.resolve();
    if (!authenticated.current || !navigator.onLine) {
      setConnection("offline");
      return Promise.resolve();
    }
    const operation = (async () => {
      let currentCatalog: Catalog;
      try {
        currentCatalog = await rpc<Catalog>("catalog");
      } catch (error) {
        if (!sameSession()) return;
        const message = accessError(error);
        const network = /fetch|network|offline|timeout|abort|timed out|conexión|load failed/i.test(message) || !navigator.onLine;
        setConnection(network ? "offline" : "error");
        setSyncProblem(network ? "" : message);
        return;
      }
      if (!sameSession()) return;
      setSyncProblem("");
      setConnection("syncing");
      try {
        const stored = session.current?.vault;
        if (stored) {
          const pending = stored.sales.filter(({ receipt }) => receipt.local);
          const results = new Map<string, Receipt>();
          for (const sale of pending) {
            if (!sameSession() || !navigator.onLine) break;
            try {
              const result = await rpc<{ id: string; reconciliation: boolean }>("confirm_sale", { data: sale.payload });
              results.set(sale.payload.id, { ...sale.receipt, local: undefined, error: undefined, reconciliation: result.reconciliation });
            } catch (error) {
              const message = accessError(error);
              results.set(sale.payload.id, { ...sale.receipt, local: "error", error: message });
              if (/fetch|network|offline|timeout|abort|timed out|load failed/i.test(message)) break;
            }
          }
          const failure = [...results.values()].find((receipt) => receipt.local);
          const changed = results.size > 0 || renew || expired(stored) || Date.now() - Date.parse(stored.grant.issued_at) > 5 * 60_000;
          if (changed && sameSession() && navigator.onLine) {
            const grant = await rpc<Grant>("authorize_device");
            await serialize(async () => {
              const latest = session.current?.vault;
              if (!latest || !sameSession()) return;
              const sales = latest.sales.map((sale) => ({ ...sale, receipt: results.get(sale.payload.id) ?? sale.receipt }));
              await updateVault({
                ...latest, grant, clockOffset: Date.parse(grant.issued_at) - Date.now(),
                sales: [...sales.filter((sale) => sale.receipt.local), ...sales.filter((sale) => !sale.receipt.local).slice(-100)],
                lastSync: failure ? latest.lastSync : new Date().toISOString(),
              });
              currentCatalog = grant.catalog;
            });
          }
          if (!sameSession()) return;
          if (failure) setSyncProblem(failure.error ?? "Hay ventas pendientes de revisión.");
          setConnection(!navigator.onLine ? "offline" : failure ? "error" : "online");
        } else {
          setConnection("online");
        }
        if (!sameSession() || !navigator.onLine) return;
        setCatalog(currentCatalog);
        await refreshHistory(historyLimit.current, sameSession);
      } catch (error) {
        if (!sameSession()) return;
        setSyncProblem(accessError(error));
        setConnection(navigator.onLine ? "error" : "offline");
      }
    })();
    const running = operation.finally(() => { syncInFlight.current = null; });
    syncInFlight.current = running;
    return running;
  }, [refreshHistory, serialize]);

  useEffect(() => {
    if (process.env.NODE_ENV === "production" && "serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" })
        .then(() => navigator.serviceWorker.ready)
        .then(() => setWorkerReady(true)).catch(() => setWorkerReady(false));
    }
    const reconnect = () => void sync(true);
    const offline = () => setConnection("offline");
    const interval = window.setInterval(() => { if (document.visibilityState === "visible") void sync(); }, 45_000);
    window.addEventListener("online", reconnect);
    window.addEventListener("offline", offline);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("online", reconnect);
      window.removeEventListener("offline", offline);
    };
  }, [sync]);

  async function login(username: string, password: string, offlineMode: boolean) {
    if (offlineMode) {
      const stored = await unlock(username, password);
      if (expired(stored.vault)) throw new Error("El acceso sin conexión venció. Conéctate e inicia sesión para renovarlo.");
      session.current = stored;
      active.current = stored.vault.profile;
      authenticated.current = false;
      setProfile(active.current);
      setLocal(stored.vault);
      setCatalog(stored.vault.grant.catalog);
      setPrepared(true);
      setConnection("offline");
      return;
    }
    if (active.current && active.current.username !== username) throw new Error("Vuelve a conectar con el mismo usuario.");
    await signIn(username, password);
    const p = await obtainProfile();
    if (session.current && session.current.vault.profile.id !== p.id) throw new Error("Esta sesión pertenece a otra cuenta.");
    const snapshot = await rpc<Catalog>("catalog");
    const ready = await hasVault(p.username);
    active.current = p;
    authenticated.current = true;
    setProfile(p);
    setCatalog(snapshot);
    setPrepared(ready);
    setConnection("online");
    if (session.current) await sync(true);
    else await refreshHistory().catch((error) => setSyncProblem(accessError(error)));
  }

  async function prepare(passphrase: string) {
    await serialize(async () => {
      const p = active.current;
      if (!p || !authenticated.current) throw new Error("Inicia sesión con internet para preparar este dispositivo.");
      const grant = await rpc<Grant>("authorize_device");
      if (await hasVault(p.username)) {
        const stored = await unlock(p.username, passphrase);
        if (stored.vault.profile.id !== p.id) throw new Error("La autorización local pertenece a otra cuenta.");
        session.current = stored;
        await updateVault({ ...stored.vault, profile: p, grant, clockOffset: Date.parse(grant.issued_at) - Date.now() });
      } else {
        session.current = await enroll(p, passphrase, grant);
        setLocal(session.current.vault);
      }
      setPrepared(true);
      setCatalog(grant.catalog);
      void navigator.storage?.persist?.();
    });
    await sync(true);
  }

  async function queue(sale: QueuedSale) {
    await serialize(async () => {
      const stored = session.current?.vault;
      if (!stored || expired(stored)) throw new Error("La autorización del dispositivo venció. Conéctate y renueva el acceso.");
      if (stored.sales.some(({ payload }) => payload.id === sale.payload.id)) return;
      if (sale.payload.grant_id !== stored.grant.id) throw new Error("El catálogo se actualizó. Revisa los importes y vuelve a confirmar.");
      for (const item of sale.payload.items) {
        const product = stored.grant.catalog.products.find((p) => p.id === item.product_id && p.active);
        const reserved = stored.sales.filter(({ receipt }) => receipt.local).flatMap(({ payload }) => payload.items)
          .filter((p) => p.product_id === item.product_id).reduce((sum, p) => sum + p.quantity, 0);
        if (!product || product.stock - reserved < item.quantity) throw new Error("El saldo local cambió. Revisa las cantidades.");
      }
      if (stored.sales.filter(({ receipt }) => receipt.local).length >= 1000) {
        throw new Error("Sincroniza las ventas pendientes antes de seguir registrando.");
      }
      await updateVault({ ...stored, sales: [...stored.sales, sale] });
    });
    void sync();
  }

  const lock = useCallback(async () => {
    await serialize(async () => {
      session.current = null;
      active.current = null;
      authenticated.current = false;
      setProfile(null); setLocal(null); setCatalog(null); setReceipts([]); setSyncProblem("");
      historyLimit.current = 500; setHistoryTruncated(false); setPrepared(false); setConnection("offline");
      try { await supabase().auth.signOut({ scope: "local" }); } catch { /* Session storage is cleared below. */ }
      for (const key of Object.keys(window.sessionStorage)) {
        if (key.startsWith("sb-") && key.includes("-auth-token")) window.sessionStorage.removeItem(key);
      }
    });
  }, [serialize]);

  useEffect(() => {
    if (!profile) return;
    let timer: number;
    const reset = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void lock(), 15 * 60_000);
    };
    reset();
    window.addEventListener("pointerdown", reset);
    window.addEventListener("keydown", reset);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("pointerdown", reset);
      window.removeEventListener("keydown", reset);
    };
  }, [profile, lock]);

  const wallClock = () => local ? adjustedNow(local) : Date.now();
  const merged = new Map(receipts.map((r) => [r.id, r]));
  for (const entry of local?.sales ?? []) if (!merged.has(entry.receipt.id)) merged.set(entry.receipt.id, entry.receipt);
  return {
    profile, catalog, local, connection, prepared, workerReady, syncProblem, historyTruncated, needsReconnect: Boolean(profile && !authenticated.current),
    receipts: [...merged.values()].sort((a, b) => b.occurred_at.localeCompare(a.occurred_at)),
    login, prepare, queue, lock, sync, wallClock, loadMoreHistory,
  };
}
export type Operation = ReturnType<typeof useOperation>;
