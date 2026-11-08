begin;

create schema if not exists private;

create table public.profiles (
  id uuid primary key references auth.users(id),
  username text unique not null check (username ~ '^[a-z0-9][a-z0-9_.-]{2,31}$'),
  role text not null check (role in ('admin', 'cashier')),
  active boolean not null default true
);

create table public.settings (
  id boolean primary key default true check (id),
  pharmacy_name text not null default 'Farmacia La Grita',
  address text not null default 'La Grita, Táchira',
  phone text not null default '',
  offline_hours integer not null default 24 check (offline_hours between 1 and 72),
  rate_hours integer not null default 24 check (rate_hours between 1 and 168),
  stale_policy text not null default 'confirm' check (stale_policy in ('confirm', 'block'))
);
insert into public.settings default values;

create table public.products (
  id uuid primary key default gen_random_uuid(),
  code text unique not null check (code <> '' and code = upper(btrim(code))),
  barcode text unique,
  name text not null check (length(trim(name)) between 1 and 200),
  ingredient text not null default '',
  strength text not null default '',
  presentation text not null default '',
  category text not null default '',
  laboratory text not null default '',
  price numeric(14,2) not null check (price > 0),
  stock integer not null default 0,
  min_stock integer not null default 0 check (min_stock >= 0),
  batch text,
  expiration date,
  active boolean not null default true,
  updated_at timestamptz not null default now(),
  unique (id, code)
);

create table public.product_prices (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id),
  amount numeric(14,2) not null check (amount > 0),
  product_name text not null,
  sellable boolean not null,
  created_at timestamptz not null default clock_timestamp()
);
create index product_prices_latest on public.product_prices(product_id, created_at desc, id desc);

create table public.exchange_rates (
  id uuid primary key default gen_random_uuid(),
  ves numeric(18,6) not null check (ves > 0),
  cop numeric(18,6) not null check (cop > 0),
  note text not null default '',
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default clock_timestamp()
);

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id),
  name text not null check (length(btrim(name)) between 1 and 160),
  document text not null check (length(btrim(document)) between 1 and 40),
  phone text,
  notes text,
  unique (owner_id, document)
);

create table public.sales (
  id uuid primary key,
  cashier_id uuid not null references public.profiles(id),
  customer_id uuid references public.customers(id),
  cashier_name text not null,
  customer_name text,
  occurred_at timestamptz not null,
  received_at timestamptz not null default clock_timestamp(),
  rate_id uuid references public.exchange_rates(id),
  total numeric(18,2) not null check (total > 0),
  discount numeric(18,2) not null default 0 check (discount >= 0),
  payload jsonb not null,
  fiscal_status text not null default 'pending' check (fiscal_status in ('pending','review','transferred','void')),
  reconciliation boolean not null default false
);
create index sales_date on public.sales(occurred_at desc);
create index sales_by_cashier on public.sales(cashier_id, occurred_at desc);

create table public.sale_items (
  sale_id uuid not null references public.sales(id),
  product_id uuid not null references public.products(id),
  price_id uuid not null references public.product_prices(id),
  name text not null,
  quantity integer not null check (quantity between 1 and 10000),
  unit_price numeric(14,2) not null check (unit_price > 0),
  primary key (sale_id, product_id)
);

create table public.payment_methods (
  code text primary key,
  label text not null,
  active boolean not null default true
);
insert into public.payment_methods values
  ('cash','Efectivo',true), ('mobile','Pago móvil',true), ('transfer','Transferencia bancaria',true);

create table public.sale_payments (
  sale_id uuid not null references public.sales(id),
  line integer not null,
  method text not null references public.payment_methods(code),
  currency text not null check (currency in ('USD','VES','COP')),
  amount numeric(18,2) not null check (amount > 0),
  change_amount numeric(18,2) not null check (change_amount >= 0 and change_amount < amount),
  rate numeric(18,6) not null check (rate > 0),
  usd numeric(18,2) not null check (usd > 0),
  primary key (sale_id, line)
);

create table public.inventory_movements (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id),
  actor_id uuid not null references public.profiles(id),
  sale_id uuid references public.sales(id),
  kind text not null check (kind in ('initial','entry','adjustment','sale','void')),
  delta integer not null check (delta <> 0),
  stock_after integer not null,
  note text not null default '',
  created_at timestamptz not null default clock_timestamp(),
  unique (sale_id, product_id, kind)
);
create index inventory_product_history on public.inventory_movements(product_id, created_at desc);

create table public.inventory_imports (
  id uuid primary key,
  filename text not null,
  actor_id uuid not null references public.profiles(id),
  created_at timestamptz not null default clock_timestamp(),
  summary jsonb not null,
  payload jsonb not null
);

create table public.fiscal_transfers (
  sale_id uuid primary key references public.sales(id),
  invoice text unique not null check (length(trim(invoice)) > 0),
  fiscal_date date not null,
  actor_id uuid not null references public.profiles(id),
  note text not null default '',
  created_at timestamptz not null default clock_timestamp()
);

create table public.audit_logs (
  id bigint generated always as identity primary key,
  actor_id uuid not null references public.profiles(id),
  action text not null,
  entity_id uuid,
  detail jsonb not null default '{}',
  created_at timestamptz not null default clock_timestamp()
);

create function private.app_role() returns text
language sql stable security definer set search_path = ''
as $$ select role from public.profiles where id = auth.uid() and active $$;

create function private.require_role(admin_only boolean default false) returns uuid
language plpgsql stable security definer set search_path = ''
as $$
declare actor uuid := auth.uid(); r text := private.app_role();
begin
  if r is null or (admin_only and r <> 'admin') then
    raise exception 'Operación no autorizada' using errcode = '42501';
  end if;
  return actor;
end $$;

revoke all on schema private from public;
grant usage on schema private to authenticated;
revoke execute on all functions in schema private from public, anon, authenticated;
grant execute on function private.app_role() to authenticated;

do $$
declare t text;
begin
  foreach t in array array[
    'profiles','settings','products','product_prices','exchange_rates','customers','sales','sale_items',
    'sale_payments','payment_methods','inventory_movements','inventory_imports','fiscal_transfers','audit_logs'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
  foreach t in array array['settings','products','product_prices','exchange_rates','payment_methods'] loop
    execute format('create policy staff_read on public.%I for select to authenticated using ((select private.app_role()) is not null)', t);
  end loop;
  foreach t in array array['inventory_movements','inventory_imports','fiscal_transfers','audit_logs'] loop
    execute format('create policy admin_read on public.%I for select to authenticated using ((select private.app_role()) = ''admin'')', t);
  end loop;
  foreach t in array array['sale_items','sale_payments'] loop
    execute format('create policy related_sale on public.%I for select to authenticated using (exists (select 1 from public.sales s where s.id = sale_id))', t);
  end loop;
end $$;

create policy profiles_read on public.profiles for select to authenticated
using ((select private.app_role()) = 'admin' or (active and id = (select auth.uid())));
create policy customers_read on public.customers for select to authenticated
using ((select private.app_role()) = 'admin' or ((select private.app_role()) = 'cashier' and owner_id = (select auth.uid())));
create policy sales_read on public.sales for select to authenticated
using ((select private.app_role()) = 'admin' or ((select private.app_role()) = 'cashier' and cashier_id = (select auth.uid())));

create function public.catalog() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  perform private.require_role();
  return jsonb_build_object(
    'products', (select coalesce(jsonb_agg(to_jsonb(p) || jsonb_build_object('price_id', pr.id) order by p.name, p.code), '[]')
      from public.products p cross join lateral (
        select id from public.product_prices where product_id = p.id order by created_at desc, id desc limit 1
      ) pr where p.active or private.app_role() = 'admin'),
    'settings', (select to_jsonb(s) from public.settings s),
    'rate', (select to_jsonb(r) from public.exchange_rates r order by created_at desc, id desc limit 1),
    'methods', (select coalesce(jsonb_agg(to_jsonb(m) order by m.label), '[]') from public.payment_methods m where m.active)
  );
end $$;

create function private.write_product(actor uuid, data jsonb, expected timestamptz)
returns public.products language plpgsql set search_path = ''
as $$
declare p public.products; old public.products;
begin
  perform pg_advisory_xact_lock(50422);
  select * into old from public.products where code = upper(btrim(data->>'code')) for update;
  if old.updated_at is distinct from expected then
    raise exception 'El producto cambió después de la revisión: %', data->>'code';
  end if;
  if old.id is null then
    insert into public.products (code, name, barcode, ingredient, strength, presentation, category, laboratory, price, stock, min_stock, batch, expiration, active)
    values (upper(btrim(data->>'code')), btrim(data->>'name'), nullif(btrim(data->>'barcode'), ''),
      coalesce(data->>'ingredient',''), coalesce(data->>'strength',''), coalesce(data->>'presentation',''),
      coalesce(data->>'category',''), coalesce(data->>'laboratory',''), (data->>'price')::numeric,
      greatest(0,coalesce((data->>'stock')::integer,0)), coalesce((data->>'min_stock')::integer,0),
      nullif(data->>'batch',''), nullif(data->>'expiration','')::date, coalesce((data->>'active')::boolean,true))
    returning * into p;
    if p.stock > 0 then
      insert into public.inventory_movements(product_id,actor_id,kind,delta,stock_after)
      values(p.id,actor,'initial',p.stock,p.stock);
    end if;
  else
    if data ? 'stock' and (data->>'stock')::integer is distinct from old.stock then
      raise exception 'Las existencias de productos existentes requieren un ajuste auditado';
    end if;
    update public.products set
      name = coalesce(btrim(data->>'name'), old.name),
      barcode = case when data ? 'barcode' then nullif(btrim(data->>'barcode'),'') else old.barcode end,
      ingredient = coalesce(data->>'ingredient', old.ingredient), strength = coalesce(data->>'strength',old.strength),
      presentation = coalesce(data->>'presentation', old.presentation), category = coalesce(data->>'category',old.category),
      laboratory = coalesce(data->>'laboratory',old.laboratory), price = coalesce((data->>'price')::numeric,old.price),
      min_stock = coalesce((data->>'min_stock')::integer,old.min_stock),
      batch = case when data ? 'batch' then nullif(data->>'batch','') else old.batch end,
      expiration = case when data ? 'expiration' then nullif(data->>'expiration','')::date else old.expiration end,
      active = coalesce((data->>'active')::boolean,old.active), updated_at = clock_timestamp()
    where id = old.id returning * into p;
  end if;
  if p.price is distinct from old.price or p.name is distinct from old.name or p.active is distinct from old.active then
    insert into public.product_prices(product_id,amount,product_name,sellable) values(p.id,p.price,p.name,p.active);
  end if;
  insert into public.audit_logs(actor_id,action,entity_id,detail)
  values(actor,'product.write',p.id,jsonb_build_object('before',to_jsonb(old),'after',to_jsonb(p)));
  return p;
end $$;
revoke execute on function private.write_product(uuid,jsonb,timestamptz) from public, anon, authenticated;

create function public.save_product(data jsonb, expected timestamptz default null)
returns uuid language plpgsql security definer set search_path = ''
as $$
begin
  return (private.write_product(private.require_role(true), data, expected)).id;
end $$;

create function public.import_products(import_id uuid, filename text, rows jsonb)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare actor uuid := private.require_role(true); r jsonb; previous public.inventory_imports;
  expected timestamptz; created integer := 0; updated integer := 0; result jsonb;
begin
  if import_id is null or coalesce(jsonb_typeof(rows),'') <> 'array' or jsonb_array_length(rows) not between 1 and 1000 then
    raise exception 'Importa entre 1 y 1000 filas válidas por archivo';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(import_id::text,1));
  select * into previous from public.inventory_imports where id = import_id;
  if found then
    if previous.actor_id <> actor or previous.payload <> rows or previous.filename <> filename then
      raise exception 'El identificador de importación ya está en uso';
    end if;
    return previous.summary;
  end if;
  for r in select value from jsonb_array_elements(rows) order by value->'data'->>'code' loop
    expected := (r->>'expected')::timestamptz;
    perform private.write_product(actor,r->'data',expected);
    if expected is null then created := created + 1; else updated := updated + 1; end if;
  end loop;
  result := jsonb_build_object('created',created,'updated',updated);
  insert into public.inventory_imports(id,filename,actor_id,summary,payload)
  values(import_id,left(filename,255),actor,result,rows);
  return result;
end $$;

create function public.adjust_inventory(product uuid, delta integer, reason text)
returns integer language plpgsql security definer set search_path = ''
as $$
declare actor uuid := private.require_role(true); balance integer;
begin
  if coalesce(delta,0) = 0 or length(coalesce(btrim(reason),'')) not between 3 and 500 then
    raise exception 'Indica una cantidad y el motivo del ajuste';
  end if;
  update public.products p set stock = stock + delta, updated_at = clock_timestamp()
    where p.id = product and p.stock + delta >= 0 returning stock into balance;
  if not found then raise exception 'Producto inexistente o el ajuste deja saldo negativo'; end if;
  insert into public.inventory_movements(product_id,actor_id,kind,delta,stock_after,note)
    values(product,actor,'adjustment',delta,balance,reason);
  if not exists (select 1 from public.sale_items i join public.products p on p.id=i.product_id
      where p.stock < 0 and i.sale_id in (select sale_id from public.sale_items where product_id=product)) then
    update public.sales set reconciliation=false
      where reconciliation and id in (select sale_id from public.sale_items where product_id=product);
  end if;
  return balance;
end $$;

create function public.set_rate(ves_per_usd numeric, cop_per_usd numeric, note text default '')
returns uuid language plpgsql security definer set search_path = ''
as $$
declare actor uuid := private.require_role(true); rate_id uuid;
begin
  perform pg_advisory_xact_lock(50422);
  insert into public.exchange_rates(ves,cop,note,created_by) values(ves_per_usd,cop_per_usd,left(note,500),actor)
    returning id into rate_id;
  insert into public.audit_logs(actor_id,action,entity_id) values(actor,'rate.create',rate_id);
  return rate_id;
end $$;

create function public.save_customer(data jsonb) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare actor uuid := private.require_role(); customer uuid;
begin
  insert into public.customers(owner_id,name,document,phone,notes)
    values(actor,btrim(data->>'name'),upper(btrim(data->>'document')),nullif(data->>'phone',''),nullif(data->>'notes',''))
    on conflict(owner_id,document) do update set name=excluded.name, phone=excluded.phone, notes=excluded.notes
    returning id into customer;
  return customer;
end $$;

create function public.save_settings(data jsonb) returns void
language plpgsql security definer set search_path = ''
as $$
declare actor uuid := private.require_role(true);
begin
  update public.settings set pharmacy_name=left(data->>'pharmacy_name',120), address=left(data->>'address',220),
    phone=left(data->>'phone',40), offline_hours=(data->>'offline_hours')::integer,
    rate_hours=(data->>'rate_hours')::integer, stale_policy=data->>'stale_policy' where id;
  insert into public.audit_logs(actor_id,action) values(actor,'settings.update');
end $$;

revoke execute on function public.catalog(), public.save_product(jsonb,timestamptz),
  public.import_products(uuid,text,jsonb), public.adjust_inventory(uuid,integer,text),
  public.set_rate(numeric,numeric,text), public.save_customer(jsonb), public.save_settings(jsonb) from public, anon;
grant execute on function public.catalog(), public.save_product(jsonb,timestamptz),
  public.import_products(uuid,text,jsonb), public.adjust_inventory(uuid,integer,text),
  public.set_rate(numeric,numeric,text), public.save_customer(jsonb), public.save_settings(jsonb) to authenticated;

commit;
