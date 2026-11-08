import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

const credentials = z.object({
  username: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9_.-]{2,31}$/),
  password: z.string().min(1).max(128),
});

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  const originUrl = origin ? URL.parse(origin) : null;
  if (!originUrl || originUrl.host !== request.headers.get("host")) {
    return new Response(null, { status: 403 });
  }
  const payload = credentials.safeParse(await request.json().catch(() => null));
  const headers = { "Cache-Control": "no-store" };
  const unavailable = () => Response.json({ error: "La conexión con el servicio de acceso no está disponible." }, { status: 503, headers });
  const unauthorized = () => Response.json({ error: "Usuario o contraseña incorrectos." }, { status: 401, headers });
  const { NEXT_PUBLIC_SUPABASE_URL: url, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: key, SUPABASE_LOGIN_DOMAIN: domain } = process.env;
  if (!url || !key || !domain) return unavailable();
  if (!payload.success) return unauthorized();

  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { username, password } = payload.data;
  const { data, error } = await client.auth.signInWithPassword({ email: username + "@" + domain, password });
  if (error?.status === 429) {
    return Response.json({ error: "Demasiados intentos. Espera unos minutos." }, { status: 429, headers });
  }
  if (!data.session) return error?.status && error.status < 500 ? unauthorized() : unavailable();
  const profile = await client.from("profiles").select("id").eq("id", data.user.id).eq("active", true).maybeSingle();
  if (!profile.data) return profile.error ? unavailable() : unauthorized();
  return Response.json({
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
  }, { headers });
}
