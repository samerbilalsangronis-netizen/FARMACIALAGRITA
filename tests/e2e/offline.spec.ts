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

test("registra cliente y venta offline, reabre la PWA y sincroniza una sola vez", async ({ context, page }, testInfo) => {
  const accepted = new Map<string, Record<string, unknown>>();
  const registeredCustomer = { id: "66188d88-40db-4a94-8d5c-4066a55a48b1", name: "Cliente de prueba", document: "V-12345678", phone: "" };
  const cachedCustomer = { id: "42abbec2-8ffc-4ae8-b128-4edb8d0a24ea", name: "Cliente existente", document: "V-87654321", phone: "" };
  let customerSaves = 0;
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
    if (path === "/rest/v1/customers") {
      const requestedDocument = new URL(request.url()).searchParams.get("document");
      result = requestedDocument ? [] : [cachedCustomer, ...(customerSaves ? [registeredCustomer] : [])];
    }
    if (path.endsWith("/rpc/save_customer")) {
      const { data } = request.postDataJSON();
      expect(data).toMatchObject({ name: registeredCustomer.name, document: registeredCustomer.document });
      customerSaves++;
      result = registeredCustomer.id;
    }
    if (path.endsWith("/rpc/confirm_sale")) {
      expect(customerSaves).toBe(1);
      sendCount++;
      const { data } = request.postDataJSON();
      expect(data.customer_id).toBe(registeredCustomer.id);
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
  await page.getByRole("button", { name: "Abrir punto de venta" }).click();
  await page.getByRole("button", { name: "Añadir Acetaminofén" }).click();
  await page.getByLabel("Moneda", { exact: true }).selectOption("VES");
  await page.getByLabel("Método", { exact: true }).selectOption("mobile");
  await expect(page.getByText("Total a cobrar", { exact: true }).locator("..")).toContainText("Bs. 1.250,00");
  await expect(page.getByText("Pendiente por cobrar", { exact: true }).locator("..")).toContainText("Bs. 1.250,00");
  await page.getByRole("button", { name: "Usar monto exacto · Bs. 1.250,00" }).click();
  await expect(page.getByLabel("Recibido")).toHaveValue("1250.00");
  await page.getByLabel("Moneda", { exact: true }).selectOption("COP");
  await expect(page.getByLabel("Recibido")).toHaveValue("");
  await expect(page.getByText("Total a cobrar", { exact: true }).locator("..")).toContainText("20.000");
  await page.getByLabel("Moneda", { exact: true }).selectOption("VES");
  await page.getByLabel("Recibido").fill("750");
  await page.getByRole("button", { name: "Añadir pago" }).click();
  await page.getByRole("button", { name: /Usar monto exacto.*USD.*2,00/ }).click();
  await expect(page.getByLabel("Recibido").nth(1)).toHaveValue("2.00");
  const confirmSale = page.getByRole("button", { name: "Confirmar venta" });
  await expect(confirmSale).toBeDisabled();
  await expect(page.getByText("Prepara este dispositivo con internet para confirmar la venta.")).toBeVisible();
  await page.getByRole("button", { name: "Preparar este dispositivo", exact: true }).click();
  await expect(page.getByLabel("Clave del dispositivo", { exact: true })).toBeFocused();
  await page.getByLabel("Clave del dispositivo", { exact: true }).fill("mi clave local de prueba");
  await page.getByLabel("Confirmar clave").fill("mi clave local de prueba");
  await page.getByRole("button", { name: "Autorizar dispositivo" }).click();
  await expect(page.getByText("Dispositivo preparado", { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  await expect(page.getByRole("status").filter({ hasText: "En línea" })).toBeVisible();

  await context.setOffline(true);
  await expect(confirmSale).toBeEnabled();
  await page.getByRole("button", { name: "Seleccionar", exact: true }).click();
  await page.getByLabel("Buscar cliente por nombre o documento").fill(cachedCustomer.document);
  await expect(page.getByRole("button", { name: /Cliente existente/ })).toBeVisible();
  await page.getByRole("button", { name: "Registrar cliente", exact: true }).click();
  await page.getByLabel("Nombre completo").fill(registeredCustomer.name);
  await page.getByLabel("Cédula o documento").fill(registeredCustomer.document.toLowerCase());
  await page.getByRole("button", { name: "Guardar y asignar cliente" }).click();
  await expect(page.getByText(registeredCustomer.name + " · " + registeredCustomer.document)).toBeVisible();
  await confirmSale.click();
  await expect(page.getByText("COMPROBANTE INTERNO DE CONTROL — NO ES FACTURA FISCAL")).toBeVisible();
  await expect(page.getByText("1 venta pendiente de sincronizar", { exact: false })).toBeVisible();
  const receipt = page.getByRole("dialog", { name: "Comprobante de venta" });
  await expect(receipt.getByText("Documento " + registeredCustomer.document)).toBeVisible();
  await expect(receipt.getByRole("img", { name: "Logo de FarmaWorld" })).toBeVisible();
  await receipt.screenshot({ path: testInfo.outputPath("comprobante.png") });
  const downloading = page.waitForEvent("download");
  await receipt.getByRole("button", { name: "PDF", exact: true }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/^comprobante-.*\.pdf$/);
  await download.saveAs(testInfo.outputPath("comprobante.pdf"));
  expect(accepted.size).toBe(0);
  expect(customerSaves).toBe(0);

  await page.close();
  const reopened = await context.newPage();
  reopened.on("pageerror", (error) => errors.push(error.message));
  await reopened.goto("/");
  await reopened.getByRole("button", { name: "Acceder sin conexión" }).click();
  await reopened.getByLabel("Nombre de usuario").fill("cajero01");
  await reopened.getByLabel("Clave del dispositivo").fill("mi clave local de prueba");
  await reopened.getByRole("button", { name: "Desbloquear", exact: true }).click();
  await expect(reopened.getByText("1 venta pendiente de sincronizar", { exact: false })).toBeVisible();
  await reopened.getByRole("button", { name: "Historial de ventas" }).click();
  await expect(reopened.getByText("Guardada en el dispositivo", { exact: true })).toBeVisible();
  await reopened.getByRole("button", { name: "Clientes", exact: true }).click();
  await expect(reopened.getByRole("cell", { name: registeredCustomer.document })).toBeVisible();
  await reopened.getByRole("button", { name: "Historial de ventas", exact: true }).click();

  await context.setOffline(false);
  await reopened.getByRole("button", { name: "Reconectar", exact: true }).click();
  await reopened.getByLabel("Contraseña de usuario").fill("prueba-ficticia");
  await reopened.getByRole("button", { name: "Ingresar y sincronizar" }).click();
  await expect(reopened.getByRole("table").getByText("Sincronizada", { exact: true })).toBeVisible();
  await reopened.getByRole("button", { name: "Actualizar y sincronizar" }).click();
  await expect(reopened.getByRole("status").filter({ hasText: "En línea" })).toBeVisible();
  expect(customerSaves).toBe(1);
  expect(sendCount).toBe(1);
  expect(accepted.size).toBe(1);
  expect([...accepted.values()][0].payments).toEqual([
    { currency: "VES", method: "mobile", amount: "750", change_amount: "0" },
    { currency: "USD", method: "cash", amount: "2.00", change_amount: "0" },
  ]);
  expect(errors).toEqual([]);
});

test("conserva el formulario de un producto nuevo mientras se sincroniza el inventario", async ({ context, page }) => {
  const currentCatalog = { ...catalog, products: [...catalog.products] };
  let holdSync: Promise<void> | undefined;
  let saveCount = 0;
  await context.route("**/api/login", (route) =>
    route.fulfill({ json: { access_token: jwt, refresh_token: "refresh-fixture" } }));
  await context.route("https://supabase-fixture.example.com/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let result: unknown = [];
    if (path === "/auth/v1/user") result = { user };
    if (path === "/rest/v1/profiles") result = { ...profile, role: "admin" };
    if (path.endsWith("/rpc/catalog")) result = currentCatalog;
    if (path.endsWith("/rpc/authorize_device")) {
      await holdSync;
      result = {
        id: crypto.randomUUID(), cashier_id: userId, issued_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 86400000).toISOString(), rate_hours: 24, stale_policy: "confirm", catalog: currentCatalog,
      };
    }
    if (path.endsWith("/rpc/save_product")) {
      const { data, expected } = request.postDataJSON();
      expect(expected).toBeNull();
      expect(data).toMatchObject({ code: "PRUEBA-001", name: "Producto nuevo", price: "3.50", stock: "8" });
      saveCount++;
      const id = crypto.randomUUID();
      currentCatalog.products.push({
        ...catalog.products[0], id, price_id: crypto.randomUUID(), code: data.code,
        name: data.name, price: Number(data.price), stock: Number(data.stock),
      });
      result = id;
    }
    await route.fulfill({ json: result, headers: { "Access-Control-Allow-Origin": "*" } });
  });
  await page.goto("/");
  await page.getByLabel("Nombre de usuario").fill("cajero01");
  await page.getByLabel("Contraseña").fill("prueba-ficticia");
  await page.getByRole("button", { name: "Ingresar" }).click();
  await expect(page.getByRole("heading", { name: "Resumen de la farmacia" })).toBeVisible();
  await page.getByRole("button", { name: "Preparar dispositivo", exact: true }).click();
  await page.getByLabel("Clave del dispositivo", { exact: true }).fill("mi clave local de prueba");
  await page.getByLabel("Confirmar clave").fill("mi clave local de prueba");
  await page.getByRole("button", { name: "Autorizar dispositivo" }).click();
  await expect(page.getByText("Dispositivo preparado", { exact: true })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "En línea" })).toBeVisible();
  await page.getByRole("button", { name: "Inventario", exact: true }).click();
  await page.getByRole("button", { name: "Nuevo producto" }).click();
  await page.getByLabel("Código interno", { exact: true }).fill("PRUEBA-001");
  await page.getByLabel("Nombre", { exact: true }).fill("Producto nuevo");

  let releaseSync!: () => void;
  holdSync = new Promise<void>((resolve) => { releaseSync = resolve; });
  try {
    await page.getByRole("button", { name: "Actualizar y sincronizar" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Sincronizando" })).toBeVisible();
    await expect(page.getByLabel("Nombre", { exact: true })).toHaveValue("Producto nuevo", { timeout: 2500 });
  } finally {
    releaseSync();
  }

  await expect(page.getByRole("status").filter({ hasText: "En línea" })).toBeVisible();
  await context.setOffline(true);
  await expect(page.getByRole("button", { name: "Guardar producto" })).toBeDisabled();
  await expect(page.getByLabel("Código interno", { exact: true })).toHaveValue("PRUEBA-001");
  await context.setOffline(false);
  await expect(page.getByRole("button", { name: "Guardar producto" })).toBeEnabled();
  await page.getByLabel("Precio USD", { exact: true }).fill("3,50");
  await page.getByLabel("Existencias", { exact: true }).fill("8");
  await page.getByRole("button", { name: "Guardar producto" }).click();
  await expect(page.getByText("Producto registrado.", { exact: true })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "Producto nuevo" })).toBeVisible();
  expect(saveCount).toBe(1);
});
