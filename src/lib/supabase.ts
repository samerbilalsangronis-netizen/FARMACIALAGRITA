import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | undefined;
export function supabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error("Configura la conexión con Supabase para activar el sistema.");
  client ??= createClient(url, key, {
    auth: { storage: window.sessionStorage, detectSessionInUrl: false },
    global: { fetch: (input, options) => {
      const timeout = AbortSignal.timeout(8_000);
      return fetch(input, { ...options, signal: options?.signal ? AbortSignal.any([timeout, options.signal]) : timeout });
    } },
  });
  return client;
}

export async function rpc<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase().rpc(name, args);
  if (error) throw new Error(error.message);
  return data as T;
}

export async function signIn(username: string, password: string) {
  const response = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }) });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "No se pudo iniciar sesión.");
  const { error } = await supabase().auth.setSession(body);
  if (error) throw new Error(error.message);
}
