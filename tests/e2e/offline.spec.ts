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
    presentation: "Caja", strength: "500 mg", active: true, min_stock: 1, updated_at: issuedAt }],
};

test("registra cliente y venta offline, reabre la PWA y sincroniza una sola vez", async ({ context, page }, testInfo) => {
  const noStockCatalog = { ...catalog, settings: { ...catalog.settings, stock_tracking: false }, products: catalog.products.map(p => ({ ...p, stock: 0 })) };
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
    if (path.endsWith("/rpc/catalog")) result = noStockCatalog;
    if (path.endsWith("/rpc/authorize_device")) result = {
      id: crypto.randomUUID(), shift_required: true, shift_id: "44444444-4444-4444-8444-444444444444", cashier_id: userId, issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 86400000).toISOString(), rate_hours: 24, stale_policy: "confirm", catalog: noStockCatalog,
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
  let adjustmentCount = 0;
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
    if (path.endsWith("/rpc/adjust_inventory")) {
      const { product, delta, reason } = request.postDataJSON();
      expect(reason).toBe("Conteo físico de prueba"); expect(delta).toBe(2); adjustmentCount++;
      currentCatalog.products.find((p) => p.id === product)!.stock += delta;
    }
    if (path.endsWith("/rpc/save_product")) {
      const { data, expected } = request.postDataJSON();
      saveCount++;
      const existing = currentCatalog.products.find((product) => product.code === data.code);
      if (existing) {
        expect(expected).toBe(issuedAt);
        expect(data).toMatchObject({ code: "PRUEBA-001", name: "Producto nuevo", price: "4.25" });
        expect(data).not.toHaveProperty("stock");
        existing.price = Number(data.price);
        result = existing.id;
      } else {
        expect(expected).toBeNull();
        expect(data).toMatchObject({ code: "PRUEBA-001", name: "Producto nuevo", price: "3.50", stock: "8" });
        const id = crypto.randomUUID();
        currentCatalog.products.push({
          ...catalog.products[0], id, price_id: crypto.randomUUID(), code: data.code,
          name: data.name, price: Number(data.price), stock: Number(data.stock), updated_at: issuedAt,
        });
        result = id;
      }
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
  const row = page.getByRole("row").filter({ has: page.getByText("Producto nuevo", { exact: true }) });
  await expect(row).toBeVisible();
  expect(saveCount).toBe(1);
  await row.getByRole("button", { name: "Editar" }).click();
  const editor = row.locator("xpath=following-sibling::tr[1]");
  await expect(editor.getByRole("heading", { name: "Editar Producto nuevo" })).toBeFocused();
  await editor.getByLabel("Precio USD", { exact: true }).fill("4,25");
  await editor.getByRole("button", { name: "Guardar producto" }).click();
  await expect(row).toContainText("4,25");
  expect(saveCount).toBe(2);
  const totalUnits = page.getByText("Unidades en existencia", {exact:true}).locator("..");
  const valuation = page.getByText("Valor del inventario en USD", {exact:true}).locator("..");
  await expect(totalUnits).toContainText("11"); await expect(valuation).toContainText("49,00");
  await page.getByLabel("Filtrar inventario").fill("PRUEBA-001");
  await expect(totalUnits).toContainText("11"); await expect(valuation).toContainText("49,00");
  await row.getByRole("button", {name:"Ajustar",exact:true}).click();
  const adjustment = row.locator("xpath=following-sibling::tr[1]");
  await expect(adjustment.getByRole("heading",{name:"Ajustar existencias de Producto nuevo"})).toBeFocused();
  await adjustment.getByLabel("Cantidad de ajuste").fill("2");
  await adjustment.getByLabel("Motivo",{exact:true}).fill("Conteo físico de prueba");
  await adjustment.getByRole("button",{name:"Registrar ajuste"}).click();
  await expect(page.getByText("Movimiento guardado en el inventario.",{exact:true})).toBeVisible();
  expect(adjustmentCount).toBe(1);
  await expect(totalUnits).toContainText("13"); await expect(valuation).toContainText("57,50");
});

test("cada cajera cierra su caja y la administración descarga los tres cierres", async ({ browser }, testInfo) => {
  const summary = {
    sales: 1, units: 2, usd: 5, ves: 1250, cop: 20000, without_rate: 0, discounts: 0,
    products: [{ product_id: productId, name: "Acetaminofén", units: 2, subtotal: 5 }],
    payments: [{ currency: "USD", method: "cash", net: 5 }],
  };
  const closed = { revision: 1, closed_at: issuedAt, cashier_name: "cajera1", summary };
  let closeCount = 0;
  for (const role of ["cashier", "admin"] as const) {
    const context = await browser.newContext();
    try {
      await context.route("**/api/login", (route) => route.fulfill({ json: { access_token: jwt, refresh_token: "refresh-fixture" } }));
      await context.route("https://supabase-fixture.example.com/**", async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path.endsWith("/rpc/register_shift_day")) {
          await route.fulfill({status:404,json:{message:"Could not find the function public.register_shift_day in the schema cache"}}); return;
        }
        let result: unknown = [];
        if (path === "/auth/v1/user") result = { user };
        if (path === "/rest/v1/profiles") result = { ...profile, role };
        if (path.endsWith("/rpc/catalog")) result = catalog;
        if (path.endsWith("/rpc/close_register")) {
          expect(role).toBe("cashier");
          closeCount++;
          result = 1;
        }
        if (path.endsWith("/rpc/register_day")) {
          const box = { register_no: 1, username: "cajera1", summary, closure: closeCount ? closed : null, changed: false };
          result = role === "cashier" ? [box] : [box, ...[2, 3].map((n) => ({
            ...box, register_no: n, username: "cajera" + n, closure: { ...closed, cashier_name: "cajera" + n },
          }))];
        }
        await route.fulfill({ json: result, headers: { "Access-Control-Allow-Origin": "*" } });
      });
      const page = await context.newPage();
      await page.goto("http://127.0.0.1:3417/");
      await page.getByLabel("Nombre de usuario").fill("cajero01");
      await page.getByLabel("Contraseña").fill("prueba-ficticia");
      await page.getByRole("button", { name: "Ingresar" }).click();
      if (role === "admin") {
        await expect(page.getByRole("heading", { name: "Ventas de hoy por caja" })).toBeVisible();
        await expect(page.getByRole("heading", { name: "Caja 3", exact: true })).toBeVisible();
      } else {
        await expect(page.getByRole("heading", { name: "Resumen de la farmacia" })).toBeVisible();
        await expect(page.getByRole("heading", { name: "Ventas de hoy por caja" })).toHaveCount(0);
      }
      await page.getByRole("button", { name: "Cierres diarios", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Caja 1", exact: true })).toBeVisible();
      if (role === "cashier") {
        await expect(page.getByRole("heading", { name: "Caja 2", exact: true })).toHaveCount(0);
        await expect(page.getByRole("button", { name: "PDF consolidado" })).toHaveCount(0);
        await page.getByRole("button", { name: "Cerrar caja", exact: true }).click();
        await page.getByRole("button", { name: "Confirmar cierre" }).click();
        await expect(page.getByText("Cierre registrado · Versión 1")).toBeVisible();
        await expect(page.getByRole("button", { name: "PDF de la caja" })).toBeEnabled();
      } else {
        await expect(page.getByRole("heading", { name: "Caja 3", exact: true })).toBeVisible();
        const downloading = page.waitForEvent("download");
        await page.getByRole("button", { name: "PDF consolidado" }).click();
        const download = await downloading;
        expect(download.suggestedFilename()).toMatch(/consolidado\.pdf$/);
        await download.saveAs(testInfo.outputPath("cierre-consolidado.pdf"));
      }
    } finally {
      await context.close();
    }
  }
  expect(closeCount).toBe(1);
});

test("abre dos turnos, bloquea ventas sin turno y descarga cierres con horario completo", async ({ context, page }, testInfo) => {
  const shifts: { id: string; register_no: number; cashier_name: string; business_day: string; started_at: string; ended_at: string | null; summary: object; closure: object | null; changed: boolean }[] = [];
  const summary = {sales:1,units:2,usd:5,ves:1250,cop:20000,without_rate:0,discounts:0,products:[{product_id:productId,name:"Acetaminofén",units:2,subtotal:5}],payments:[{currency:"USD",method:"cash",net:5}]};
  const day = new Date().toLocaleDateString("en-CA",{timeZone:"America/Caracas"});
  let grantNumber = 0;
  await context.route("**/api/login",(r)=>r.fulfill({json:{access_token:jwt,refresh_token:"refresh-fixture"}}));
  await context.route("https://supabase-fixture.example.com/**",async(route)=>{
    const request=route.request(); const path=new URL(request.url()).pathname; let result:unknown=[];
    if(path==="/auth/v1/user") result={user};
    if(path==="/rest/v1/profiles") result=profile;
    if(path.endsWith("/rpc/catalog")) result=catalog;
    if(path.endsWith("/rpc/register_shift_day")) result=shifts;
    if(path.endsWith("/rpc/authorize_device")) result={id:"grant-"+(++grantNumber),cashier_id:userId,issued_at:new Date().toISOString(),expires_at:new Date(Date.now()+86400000).toISOString(),rate_hours:24,stale_policy:"confirm",catalog,shift_required:true,shift_id:shifts.find(s=>!s.ended_at)?.id??null};
    if(path.endsWith("/rpc/open_register_shift")) {
      const {request_id}=request.postDataJSON();
      shifts.push({id:request_id,register_no:3,cashier_name:"caja3",business_day:day,started_at:new Date().toISOString(),ended_at:null,summary,closure:null,changed:false}); result=request_id;
    }
    if(path.endsWith("/rpc/close_register_shift")) {
      const {shift}=request.postDataJSON(); const row=shifts.find(s=>s.id===shift)!;
      row.ended_at=new Date().toISOString(); row.closure={revision:1,closed_at:row.ended_at,summary}; result=1;
    }
    await route.fulfill({json:result});
  });
  await page.goto("/"); await page.getByLabel("Nombre de usuario").fill("caja3"); await page.getByLabel("Contraseña").fill("fixture"); await page.getByRole("button",{name:"Ingresar",exact:true}).click();
  await page.getByRole("button",{name:"Preparar dispositivo",exact:true}).click();
  await page.getByLabel("Clave del dispositivo",{exact:true}).fill("clave de dispositivo prueba"); await page.getByLabel("Confirmar clave").fill("clave de dispositivo prueba"); await page.getByRole("button",{name:"Autorizar dispositivo"}).click();
  await expect(page.getByText("Dispositivo preparado",{exact:true})).toBeVisible();
  await page.getByRole("button",{name:"Punto de venta",exact:true}).click();
  await expect(page.getByRole("button",{name:"Ir a Cierres diarios"})).toBeVisible();
  await expect(page.getByRole("button",{name:"Confirmar venta",exact:true})).toBeDisabled();
  await page.getByRole("button",{name:"Ir a Cierres diarios"}).click();
  await page.getByRole("button",{name:"Iniciar turno",exact:true}).click();
  await expect(page.getByText("Turno abierto",{exact:true})).toBeVisible();
  await page.getByRole("button",{name:"Cerrar turno",exact:true}).click(); await page.getByRole("button",{name:"Confirmar cierre",exact:true}).click();
  await expect(page.getByText("Turno cerrado",{exact:true})).toHaveCount(1);
  await page.getByRole("button",{name:"Punto de venta",exact:true}).click(); await expect(page.getByRole("button",{name:"Ir a Cierres diarios"})).toBeVisible();
  await page.getByRole("button",{name:"Ir a Cierres diarios"}).click(); await page.getByRole("button",{name:"Iniciar turno",exact:true}).click();
  await page.getByRole("button",{name:"Cerrar turno",exact:true}).click(); await page.getByRole("button",{name:"Confirmar cierre",exact:true}).click();
  await expect(page.getByText("Turno cerrado",{exact:true})).toHaveCount(2);
  const downloading=page.waitForEvent("download"); await page.getByRole("button",{name:"PDF del turno",exact:true}).last().click(); const download=await downloading;
  await download.saveAs(testInfo.outputPath("cierre-turno.pdf"));
  await page.screenshot({path:testInfo.outputPath("turnos.png"),fullPage:true});
  expect(shifts).toHaveLength(2); expect(shifts.every(s=>s.closure)).toBe(true);
});

test("administración descarga un consolidado de seis turnos de tres cajas",async({context,page},testInfo)=>{
  const day=new Date().toLocaleDateString("en-CA",{timeZone:"America/Caracas"});
  const summary={sales:1,units:2,usd:5,ves:1250,cop:20000,without_rate:0,discounts:0,products:[{product_id:productId,name:"Acetaminofén",units:2,subtotal:5}],payments:[{currency:"USD",method:"cash",net:5}]};
  const shifts=[1,2,3].flatMap(n=>[0,1].map(i=>({id:crypto.randomUUID(),register_no:n,cashier_name:"caja"+n,business_day:day,started_at:day+(i?"T18:00:00-04:00":"T08:00:00-04:00"),ended_at:day+(i?"T23:00:00-04:00":"T12:00:00-04:00"),summary,closure:{revision:1,closed_at:issuedAt,summary},changed:false})));
  await context.route("**/api/login",r=>r.fulfill({json:{access_token:jwt,refresh_token:"fixture"}}));
  await context.route("https://supabase-fixture.example.com/**",async r=>{
    const path=new URL(r.request().url()).pathname; let result:unknown=[];
    if(path==="/auth/v1/user") result={user};
    if(path==="/rest/v1/profiles") result={...profile,role:"admin"};
    if(path.endsWith("/rpc/catalog")) result=catalog;
    if(path.endsWith("/rpc/register_shift_day")) result=shifts;
    await r.fulfill({json:result});
  });
  await page.goto("/"); await page.getByLabel("Nombre de usuario").fill("admin");await page.getByLabel("Contraseña").fill("fixture");await page.getByRole("button",{name:"Ingresar",exact:true}).click();
  await page.getByRole("button",{name:"Cierres diarios",exact:true}).click();await expect(page.getByText("Turno cerrado",{exact:true})).toHaveCount(6);
  await expect(page.getByRole("button",{name:"Cerrar turno",exact:true})).toHaveCount(0);
  const downloading=page.waitForEvent("download");await page.getByRole("button",{name:"PDF consolidado de turnos"}).click();const download=await downloading;
  await download.saveAs(testInfo.outputPath("consolidado-seis-turnos.pdf"));
});


test("catálogo sin stock oculta existencias y permite editar precios",async({context,page})=>{
  const noStockCatalog={...catalog,settings:{...catalog.settings,stock_tracking:false},products:catalog.products.map(p=>({...p,stock:0}))};
  let saves=0;
  await context.route("**/api/login",r=>r.fulfill({json:{access_token:jwt,refresh_token:"fixture"}}));
  await context.route("https://supabase-fixture.example.com/**",async r=>{
    const path=new URL(r.request().url()).pathname;let result:unknown=[];
    if(path==="/auth/v1/user")result={user};
    if(path==="/rest/v1/profiles")result={...profile,role:"admin"};
    if(path.endsWith("/rpc/catalog"))result=noStockCatalog;
    if(path.endsWith("/rpc/save_product")){
      const {data}=r.request().postDataJSON();expect(data).not.toHaveProperty("stock");expect(data).not.toHaveProperty("min_stock");
      expect(data.price).toBe("7.25");noStockCatalog.products[0].price=7.25;saves++;result=productId;
    }
    await r.fulfill({json:result});
  });
  await page.goto("/");await page.getByLabel("Nombre de usuario").fill("admin");await page.getByLabel("Contraseña").fill("fixture");await page.getByRole("button",{name:"Ingresar",exact:true}).click();
  await page.getByRole("button",{name:"Inventario",exact:true}).click();
  await expect(page.getByText("Unidades en existencia",{exact:true})).toHaveCount(0);
  await expect(page.getByRole("columnheader",{name:"Existencias",exact:true})).toHaveCount(0);
  await expect(page.getByRole("button",{name:"Ajustar",exact:true})).toHaveCount(0);
  await page.getByRole("button",{name:"Editar",exact:true}).click();
  await expect(page.getByLabel("Existencias",{exact:true})).toHaveCount(0);await expect(page.getByLabel("Stock mínimo",{exact:true})).toHaveCount(0);
  await page.getByLabel("Precio USD",{exact:true}).fill("7,25");await page.getByRole("button",{name:"Guardar producto"}).click();
  await expect(page.getByRole("cell").filter({hasText:"7,25"})).toBeVisible();expect(saves).toBe(1);
});

test("calcula y guarda el precio desde costo y porcentaje y lo muestra en caja",async({context,page})=>{
  const pricedCatalog={...catalog,pricing_enabled:true,settings:{...catalog.settings,stock_tracking:false},products:catalog.products.map(p=>({...p,stock:0,net_cost:null as number|null,markup_percent:null as number|null}))};
  let saves=0;
  await context.route("**/api/login",r=>r.fulfill({json:{access_token:jwt,refresh_token:"fixture"}}));
  await context.route("https://supabase-fixture.example.com/**",async r=>{
    const path=new URL(r.request().url()).pathname;let result:unknown=[];
    if(path==="/auth/v1/user")result={user};
    if(path==="/rest/v1/profiles")result={...profile,role:"admin"};
    if(path.endsWith("/rpc/catalog"))result=pricedCatalog;
    if(path.endsWith("/rpc/save_product")){
      const {data}=r.request().postDataJSON();
      expect(data).toMatchObject({pricing_mode:"cost",net_cost:"10",markup_percent:"25",price:"12.50"});
      pricedCatalog.products[0].price=12.5;pricedCatalog.products[0].net_cost=10;pricedCatalog.products[0].markup_percent=25;saves++;result=productId;
    }
    await r.fulfill({json:result});
  });
  await page.goto("/");await page.getByLabel("Nombre de usuario").fill("admin");await page.getByLabel("Contraseña").fill("fixture");await page.getByRole("button",{name:"Ingresar",exact:true}).click();
  await page.getByRole("button",{name:"Inventario",exact:true}).click();await page.getByRole("button",{name:"Editar",exact:true}).click();
  await page.getByRole("checkbox",{name:"Calcular precio desde costo y ganancia",exact:true}).check();
  await page.getByLabel("Costo neto USD",{exact:true}).fill("10");await page.getByLabel("Ganancia sobre costo (%)",{exact:true}).fill("25");
  await expect(page.getByLabel("Precio de venta USD",{exact:true})).toHaveValue("12.50");
  await page.getByRole("button",{name:"Guardar producto",exact:true}).click();await expect(page.getByText("Producto actualizado.",{exact:true})).toBeVisible();expect(saves).toBe(1);
  const row=page.getByRole("row").filter({has:page.getByText("Acetaminofén",{exact:true})});await expect(row).toContainText("12,50");await expect(row).toContainText("25 %");
  await page.getByRole("button",{name:"Editar",exact:true}).click();await expect(page.getByLabel("Costo neto USD",{exact:true})).toHaveValue("10");await page.getByRole("button",{name:"Cancelar",exact:true}).click();
  await page.getByRole("button",{name:"Punto de venta",exact:true}).click();await expect(page.getByText(/12,50/).first()).toBeVisible();await expect(page.getByText(/disponibles/)).toHaveCount(0);
});
