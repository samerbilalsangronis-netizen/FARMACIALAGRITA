import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
const admin = "11111111-1111-4111-8111-111111111111";
const cashier = "22222222-2222-4222-8222-222222222222";
const other = "33333333-3333-4333-8333-333333333333";
test("Turnos: dos cierres independientes, noche, permisos, reintentos y sincronización tardía", async (t) => {
  const db = await PGlite.create(); t.after(() => db.close());
  await db.exec(`create role anon; create role authenticated; create schema auth;
    create table auth.users(id uuid primary key,email text);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth to authenticated;
    insert into auth.users values('${admin}','a@x'),('${cashier}','c@x'),('${other}','o@x');`);
  const dir = new URL("../supabase/migrations/",import.meta.url);
  for (const name of (await readdir(dir)).filter(name=>!name.includes("008")).sort()) await db.exec(await readFile(new URL(name,dir),"utf8"));
  await db.exec(`insert into public.profiles(id,username,role,register_no) values('${admin}','admin','admin',null),('${cashier}','caja3','cashier',3),('${other}','caja2','cashier',2);`);
  const as = async (id) => { await db.exec("reset role"); await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]); await db.exec("set role authenticated"); };
  const rpc = async (expr,args=[]) => (await db.query("select "+expr+" as r",args)).rows[0].r;
  await as(admin);
  const product = await rpc("public.save_product($1)",[{code:"T1",name:"Producto prueba",stock:50,price:2}]);
  await rpc("public.set_rate(250,4000,'Prueba')");
  await assert.rejects(rpc("public.open_register_shift($1)",[crypto.randomUUID()]),/caja asignada/);
  await as(cashier);
  const noShift = await rpc("public.authorize_device()"); assert.equal(noShift.shift_required,true); assert.equal(noShift.shift_id,null);
  const first = crypto.randomUUID();
  assert.equal(await rpc("public.open_register_shift($1)",[first]),first);
  assert.equal(await rpc("public.open_register_shift($1)",[first]),first);
  assert.equal(await rpc("public.open_register_shift($1)",[crypto.randomUUID()]),first);
  const grant = await rpc("public.authorize_device()"); assert.equal(grant.shift_id,first);
  const makeSale = (g) => ({id:crypto.randomUUID(),grant_id:g.id,occurred_at:new Date().toISOString(),rate_id:g.catalog.rate.id,
    customer_id:null,stale_confirmed:false,discount:"0",items:[{product_id:product,price_id:g.catalog.products[0].price_id,quantity:1}],
    payments:[{method:"cash",currency:"USD",amount:"2",change_amount:"0"}]});
  await assert.rejects(rpc("public.confirm_sale($1)",[makeSale(noShift)]),/Inicia un turno/);
  const sale = makeSale(grant); await rpc("public.confirm_sale($1)",[sale]);
  const late = makeSale(grant); // quedó en un dispositivo sin red antes del cierre
  const day = (await rpc("public.register_shift_day($1)",[new Date().toLocaleDateString('en-CA',{timeZone:'America/Caracas'})]))[0].business_day;
  assert.equal(await rpc("public.close_register_shift($1)",[first]),1);
  assert.equal(await rpc("public.close_register_shift($1)",[first]),1);
  await new Promise(r=>setTimeout(r,5));
  await assert.rejects(rpc("public.confirm_sale($1)",[makeSale(grant)]),/fuera del turno/);
  const second = crypto.randomUUID(); await rpc("public.open_register_shift($1)",[second]);
  const grant2 = await rpc("public.authorize_device()");
  await rpc("public.confirm_sale($1)",[makeSale(grant2)]);
  await rpc("public.confirm_sale($1)",[late]); // sincronización tardía al turno original
  await rpc("public.confirm_sale($1)",[late]); // reintento no duplica
  let shifts = await rpc("public.register_shift_day($1)",[day]);
  assert.equal(shifts.find(s=>s.id===first).changed,true);
  assert.equal(shifts.find(s=>s.id===second).summary.usd,2);
  assert.equal(await rpc("public.close_register_shift($1)",[first]),2);
  assert.equal(await rpc("public.close_register_shift($1)",[second]),1);
  shifts = await rpc("public.register_shift_day($1)",[day]);
  assert.deepEqual(shifts.map(s=>s.closure.summary.usd),[4,2]);
  assert.equal(shifts.reduce((n,s)=>n+s.closure.summary.sales,0),3);
  await as(other);
  assert.deepEqual(await rpc("public.register_shift_day($1)",[day]),[]);
  await assert.rejects(rpc("public.close_register_shift($1)",[first]),/no autorizado/);
  await assert.rejects(db.exec("select * from public.register_shifts"),/permission denied/);
  await as(admin); assert.equal((await rpc("public.register_shift_day($1)",[day])).length,2);
  await rpc("public.set_fiscal_status($1,'void','','2026-11-11','Anulación de prueba')",[sale.id]);
  assert.equal((await rpc("public.register_shift_day($1)",[day]))[0].changed,true);
  await as(cashier); assert.equal(await rpc("public.close_register_shift($1)",[first]),3);
  // Preparar un turno abierto desde ayer y vender hoy: la medianoche no lo corta.
  const night = crypto.randomUUID(); await rpc("public.open_register_shift($1)",[night]);
  await db.exec("reset role");
  await db.query("update public.register_shifts set started_at=(($1::date-1)::timestamp at time zone 'America/Caracas')+interval '22 hours',business_day=$1::date-1 where id=$2",[day,night]);
  await as(cashier); const overnightGrant = await rpc("public.authorize_device()");
  await rpc("public.confirm_sale($1)",[makeSale(overnightGrant)]);
  assert.ok((await rpc("public.register_shift_day($1)",[day])).find(s=>s.id===night && !s.ended_at));
  await rpc("public.close_register_shift($1)",[night]);
  assert.equal((await rpc("public.register_shift_day($1)",[day])).length,2);
  const yesterday = await rpc("($1::date-1)::text",[day]);
  const overnight = (await rpc("public.register_shift_day($1)",[yesterday]))[0];
  assert.equal(overnight.id,night); assert.equal(overnight.closure.summary.usd,2);
  // Solo cuatro ventas reales de prueba, una anulada; inventario conserva su saldo auditado.
  await as(admin); assert.equal((await rpc("public.catalog()")).products[0].stock,47);
  await assert.rejects(rpc("public.close_register($1)",[day]),/Cerrar turno/);
  // Actualizar una base existente a catálogo sin stock conserva precios e historial.
  await db.exec("reset role");
  const oldPrices = await rpc("(select jsonb_agg(to_jsonb(p) order by id) from public.product_prices p)");
  const oldSales = await rpc("(select count(*)::int from public.sales)");
  await db.exec(await readFile(new URL("202611140008_catalogo_sin_stock.sql",dir),"utf8"));
  assert.deepEqual(await rpc("(select jsonb_agg(to_jsonb(p) order by id) from public.product_prices p)"),oldPrices);
  assert.equal(await rpc("(select count(*)::int from public.sales)"),oldSales);
  assert.equal(await rpc("(select stock from private.stock_before_catalog_mode where product_id=$1)",[product]),47);
  await as(admin);
  const catalog = await rpc("public.catalog()");
  assert.equal(catalog.settings.stock_tracking,false); assert.equal(catalog.products[0].stock,0);
  assert.equal(catalog.products[0].price,2);
  await assert.rejects(rpc("public.adjust_inventory($1,1,'Prueba sin stock')",[product]),/sin control/);
  await as(cashier);
  await assert.rejects(db.exec("select * from private.stock_before_catalog_mode"),/permission denied/);
  const unlimitedShift = crypto.randomUUID(); await rpc("public.open_register_shift($1)",[unlimitedShift]);
  const unlimitedGrant = await rpc("public.authorize_device()");
  const bulk = makeSale(unlimitedGrant); bulk.items[0].quantity=20;bulk.payments[0].amount="40";
  assert.deepEqual(await rpc("public.confirm_sale($1)",[bulk]),{id:bulk.id,reconciliation:false});
  assert.deepEqual(await rpc("public.confirm_sale($1)",[bulk]),{id:bulk.id,reconciliation:false});
  assert.equal(await rpc("public.close_register_shift($1)",[unlimitedShift]),1);
  assert.equal((await rpc("public.register_shift_day($1)",[day])).find(s=>s.id===unlimitedShift).closure.summary.units,20);
  await as(admin);
  assert.equal((await rpc("public.catalog()")).products[0].stock,0);
  assert.equal(await rpc("(select count(*)::int from public.inventory_movements where sale_id=$1)",[bulk.id]),0);
  await rpc("public.set_fiscal_status($1,'void','','2026-11-14','Anular sin stock')",[bulk.id]);
  assert.equal((await rpc("public.catalog()")).products[0].stock,0);
  const another = await rpc("public.save_product($1)",[{code:"IGNORAR-STOCK",name:"Nuevo sin stock",price:3,stock:99,min_stock:10}]);
  assert.equal((await rpc("public.catalog()")).products.find(p=>p.id===another).stock,0);

});
