import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

const admin = "11111111-1111-4111-8111-111111111111";
const first = "22222222-2222-4222-8222-222222222222";
const second = "33333333-3333-4333-8333-333333333333";
const unmanaged = "44444444-4444-4444-8444-444444444444";
const file = new URL("../supabase/migrations/", import.meta.url);

test("Migraciones, permisos, cobro mixto, reintentos y conflicto de inventario", async (t) => {
  const db = await PGlite.create();
  t.after(() => db.close());
  await db.exec(`
    create role anon;
    create role authenticated;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable
      as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth to authenticated;
    insert into auth.users values ('${admin}'),('${first}'),('${second}'),('${unmanaged}');
  `);
  for (const name of (await readdir(file)).sort()) await db.exec(await readFile(new URL(name, file), "utf8"));
  await db.exec(`insert into public.profiles(id,username,role) values
    ('${admin}','admin','admin'),('${first}','cajero1','cashier'),('${second}','cajero2','cashier')`);
  const as = async (actor, role = "authenticated") => {
    await db.exec("reset role");
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [actor]);
    await db.exec("set role " + role);
  };
  const rpc = async (expression, params = []) => (await db.query("select " + expression + " as result", params)).rows[0].result;

  await as(admin);
  const product = await rpc("public.save_product($1)", [{ code: " ACET-1 ", name: "Acetaminofén", stock: 3, price: 5, barcode: "0001" }]);
  await rpc("public.set_rate(250,4000,'Prueba')");
  const initial = (await rpc("public.catalog()")).products[0];
  assert.equal(initial.code, "ACET-1");
  const importId = crypto.randomUUID();
  const rows = [{ expected: initial.updated_at, data: { code: "ACET-1", price: 6, name: "Acetaminofén 500 mg" } },
    { expected: null, data: { code: "AZI-1", price: 4, name: "Azitromicina", stock: 3 } }];
  assert.deepEqual(await rpc("public.import_products($1,$2,$3)", [importId, "inventario.csv", rows]), { created: 1, updated: 1 });
  assert.deepEqual(await rpc("public.import_products($1,$2,$3)", [importId, "inventario.csv", rows]), { created: 1, updated: 1 });
  assert.equal(await rpc("(select count(*)::integer from public.inventory_imports)"), 1);
  const updated = (await rpc("public.catalog()")).products[0];
  await assert.rejects(rpc("public.save_product($1,$2)", [{ code: "ACET-1", stock: 99 }, updated.updated_at]), /ajuste auditado/);

  await as(first);
  await assert.rejects(rpc("public.save_product($1)", [{ code: "B", name: "B", price: 1 }]), /no autorizada/);
  await assert.rejects(db.exec("update public.products set stock=20"), /permission denied/);
  const g1 = await rpc("public.authorize_device()");
  await as(second);
  const g2 = await rpc("public.authorize_device()");
  const sale = (grant, amount = "750") => ({
    id: crypto.randomUUID(), grant_id: grant.id, rate_id: grant.catalog.rate.id, customer_id: null,
    occurred_at: grant.issued_at, stale_confirmed: false,
    items: [{ product_id: product, price_id: updated.price_id, quantity: 2 }],
    payments: [{ method: "cash", currency: "USD", amount: "9", change_amount: "0" },
      { method: "mobile", currency: "VES", amount, change_amount: "0" }],
  });
  const firstSale = sale(g1);
  const secondSale = sale(g2);
  await assert.rejects(rpc("public.confirm_sale($1)", [firstSale]), /período autorizado/);
  await assert.rejects(rpc("public.confirm_sale($1)", [sale(g2, "500")]), /debe coincidir/);
  assert.equal((await rpc("public.catalog()")).products[0].stock, 3);
  await as(first);
  const firstResult = await rpc("public.confirm_sale($1)", [firstSale]);
  assert.deepEqual(firstResult, { id: firstSale.id, reconciliation: false });
  assert.deepEqual(await rpc("public.confirm_sale($1)", [firstSale]), firstResult);
  await assert.rejects(rpc("public.confirm_sale($1)", [{ ...firstSale, stale_confirmed: true }]), /ya está en uso/);
  await as(second);
  assert.equal((await rpc("public.confirm_sale($1)", [secondSale])).reconciliation, true);
  assert.equal(await rpc("(select count(*)::integer from public.sales)"), 1);
  assert.equal(await rpc("(select count(*)::integer from public.sale_items)"), 1);
  assert.equal(await rpc("(select count(*)::integer from public.fiscal_transfers)"), 0);
  await as(admin);
  assert.equal(await rpc("(select count(*)::integer from public.sales)"), 2);
  assert.equal(await rpc("(select stock from public.products where code='ACET-1')"), -1);
  assert.equal(await rpc("(select count(*)::integer from public.inventory_movements where kind='sale')"), 2);
  await rpc("public.adjust_inventory($1,2,'Conciliación física')", [product]);
  await rpc("public.set_fiscal_status($1,'transferred','SERIE-0001','2026-11-08','Revisión')", [firstSale.id]);
  assert.equal(await rpc("(select invoice from public.fiscal_transfers where sale_id=$1)", [firstSale.id]), "SERIE-0001");
  await rpc("public.set_fiscal_status($1,'void','','2026-11-08','Operación anulada')", [secondSale.id]);
  assert.equal(await rpc("(select stock from public.products where code='ACET-1')"), 3);
  assert.equal(await rpc("(select fiscal_status from public.sales where id=$1)", [secondSale.id]), "void");
  await as(unmanaged);
  await assert.rejects(rpc("public.catalog()"), /no autorizada/);
  assert.equal(await rpc("(select count(*)::integer from public.products)"), 0);
  await as("", "anon");
  await assert.rejects(rpc("public.catalog()"), /permission denied/);

  await db.exec("reset role");
  const cleanup = await readFile(new URL("../supabase/limpieza_preentrega.sql", import.meta.url), "utf8");
  await db.exec(cleanup);
  assert.equal(await rpc("(select count(*)::integer from public.sales)"), 2);
  await db.exec(cleanup.replace("= 'SIMULAR';", "= 'BORRAR_DATOS_DE_PRUEBA';"));
  for (const table of ["sales", "sale_items", "sale_payments", "fiscal_transfers", "customers", "inventory_movements",
    "inventory_imports", "products", "product_prices", "exchange_rates", "device_grants"]) {
    assert.equal(await rpc("(select count(*)::integer from public." + table + ")"), 0, table);
  }
  assert.equal(await rpc("(select count(*)::integer from public.profiles)"), 3);
  assert.equal(await rpc("(select count(*)::integer from auth.users)"), 4);
  assert.equal(await rpc("(select count(*)::integer from public.payment_methods)"), 3);
});
