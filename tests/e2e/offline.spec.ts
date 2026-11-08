import { expect, test } from "@playwright/test";

const userId = "2dd1b4b8-35be-4f56-8278-599300013b31";
const productId = "4094fc72-6ec9-4ea3-9ac4-083fb4a6c6bd";
const priceId = "a9ca8311-a502-4bdf-8761-e97373a11c57";
const rateId = "450472d9-b6b8-4237-b85e-3c2f6691f15f";
const issuedAt = new Date().toISOString();
const profile = { id: userId, username: "cajero01", role: "cashier", active: true };
const user = { id: userId, aud: "authenticated", email: "cajero01@accounts.example.com", app_metadata: {}, user_metadata: {} };
const jwt = [Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url"),
  Buffer.from(JSON.stringify({ sub: userId, exp: Math.floor(Date.now() / 1000) + 7200 })).toString("base64url"), "fixture"].join(".");
const catalog = {
  settings: { pharmacy_name: "Farmacia La Grita", address: "La Grita, Táchira", phone: "", offline_hours: 24, rate_hours: 24, stale_policy: "confirm" },
  rate: { id: rateId, ves: 250, cop: 4000, created_at: issuedAt },
  methods: [{ code: "cash", label: "Efectivo" }, { code: "mobile", label: "Pago móvil" }],
  products: [{ id: productId, price_id: priceId, code: "ACET", barcode: "101", name: "Acetaminofén", price: 5, stock: 3,
    presentation: "Caja", strength: "500 mg", active: true, min_stock: 1 }],
};

test("guarda una venta offline, reabre la PWA y sincroniza la misma operación una sola vez", async ({ context, page }) => {
  const accepted = new Map<string, Record<string, unknown>>();
  let sendCount = 0;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await context.route("**/api/login", async (route) => {
    await route.fulfill({ json: { access_token: jwt, refresh_token: "refresh-fixture" } });
  });
  await context.route("https://supabase-fixture.example.com/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let result: unknown = null;
    if (path === "/auth/v1/user") result = { user };
    if (path === "/rest/v1/profiles") result = profile;
    if (path.endsWith("/rpc/catalog")) result = catalog;
    if (path.endsWith("/rpc/authorize_device")) result = {
      id: crypto.randomUUID(), cashier_id: userId, issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 86400000).toISOString(), rate_hours: 24, stale_policy: "confirm", catalog,
    };
    if (path.endsWith("/rpc/confirm_sale")) {
      sendCount++;
      const { data } = request.postDataJSON();
      const old = accepted.get(data.id);
      expect(!old || JSON.stringify(old) === JSON.stringify(data)).toBe(true);
      accepted.set(data.id, data);
      result = { id: data.id, reconciliation: false };
    }
    if (path === "/rest/v1/sales") result = [];
    await route.fulfill({ json: result, headers: { "Access-Control-Allow-Origin": "*" } });
  });
  await page.goto("/");
  await page.getByLabel("Nombre de usuario").fill("cajero01");
  await page.getByLabel("Contraseña").fill("prueba-ficticia");
  await page.getByRole("button", { name: "Ingresar" }).click();
  await expect(page.getByRole("heading", { name: "Resumen de la farmacia" })).toBeVisible();
  await page.getByRole("button", { name: "Preparar dispositivo" }).click();
  await page.getByLabel("Clave del dispositivo", { exact: true }).fill("mi clave local de prueba");
  await page.getByLabel("Confirmar clave").fill("mi clave local de prueba");
  await page.getByRole("button", { name: "Autorizar dispositivo" }).click();
  await expect(page.getByText("Dispositivo preparado", { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  await expect(page.getByRole("status").filter({ hasText: "En línea" })).toBeVisible();

  await context.setOffline(true);
  await page.getByRole("button", { name: "Abrir punto de venta" }).click();
  await page.getByRole("button", { name: "Añadir Acetaminofén" }).click();
  await page.getByRole("button", { name: "Exacto en USD" }).click();
  await page.getByRole("button", { name: "Confirmar venta" }).click();
  await expect(page.getByText("COMPROBANTE INTERNO DE CONTROL — NO ES FACTURA FISCAL")).toBeVisible();
  await expect(page.getByText("1 venta pendiente de sincronizar", { exact: false })).toBeVisible();
  expect(accepted.size).toBe(0);

  await page.close();
  const reopened = await context.newPage();
  await reopened.goto("/");
  await reopened.getByRole("button", { name: "Acceder sin conexión" }).click();
  await reopened.getByLabel("Nombre de usuario").fill("cajero01");
  await reopened.getByLabel("Clave del dispositivo").fill("mi clave local de prueba");
  await reopened.getByRole("button", { name: "Desbloquear", exact: true }).click();
  await expect(reopened.getByText("1 venta pendiente de sincronizar", { exact: false })).toBeVisible();
  await reopened.getByRole("button", { name: "Historial de ventas" }).click();
  await expect(reopened.getByText("Guardada en el dispositivo", { exact: true })).toBeVisible();

  await context.setOffline(false);
  await reopened.getByRole("button", { name: "Reconectar", exact: true }).click();
  await reopened.getByLabel("Contraseña de usuario").fill("prueba-ficticia");
  await reopened.getByRole("button", { name: "Ingresar y sincronizar" }).click();
  await expect(reopened.getByText("Sincronizada", { exact: true })).toBeVisible();
  await reopened.getByRole("button", { name: "Actualizar y sincronizar" }).click();
  await expect(reopened.getByRole("status").filter({ hasText: "En línea" })).toBeVisible();
  expect(sendCount).toBe(1);
  expect(accepted.size).toBe(1);
  expect(errors).toEqual([]);
});
