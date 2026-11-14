-- 010: formulario simple y porcentaje general. Conserva precios, stock, metadatos y ventas.
begin;
select pg_advisory_xact_lock(50422);
select set_config('farmacia.inventario_antes_simple',coalesce((select md5(string_agg((to_jsonb(p)-'active'-'updated_at')::text,',' order by id)) from public.products p),''),true);
alter table public.settings add column markup_percent numeric(9,4) not null default 25
  check (markup_percent between 0 and 10000);
-- Activo y pendiente de precio son estados independientes. La venta sigue exigiendo precio positivo.
alter table public.products drop constraint if exists products_active_requires_price;
create or replace function private.write_product_core(actor uuid, data jsonb, expected timestamptz)
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
  if p.price is not null and (p.price is distinct from old.price or p.name is distinct from old.name or p.active is distinct from old.active) then
    insert into public.product_prices(product_id,amount,product_name,sellable) values(p.id,p.price,p.name,p.active);
  end if;
  insert into public.audit_logs(actor_id,action,entity_id,detail)
  values(actor,'product.write',p.id,jsonb_build_object('before',to_jsonb(old),'after',to_jsonb(p)));
  return p;
end $$;

create or replace function private.write_product(actor uuid, data jsonb, expected timestamptz)
returns public.products language plpgsql set search_path = '' as $$
declare p public.products; old_cost private.product_costs; adjusted jsonb := data - 'net_cost' - 'markup_percent' - 'pricing_mode';
  cost numeric; percentage numeric; selling numeric; mode text := data->>'pricing_mode'; use_cost boolean;
begin
  perform pg_advisory_xact_lock(50422);
  if mode is not null and mode not in ('manual','cost','global_cost') then raise exception 'Modo de precio inválido'; end if;
  select c.* into old_cost from private.product_costs c join public.products existing_product on existing_product.id=c.product_id
    where existing_product.code=upper(btrim(data->>'code'));
  use_cost := mode in ('cost','global_cost') or (mode is distinct from 'manual' and (old_cost.product_id is not null or data ? 'net_cost' or data ? 'markup_percent'));
  if coalesce(use_cost,false) then
    cost := case when data ? 'net_cost' then (data->>'net_cost')::numeric else old_cost.net_cost end;
    percentage := case when mode = 'global_cost' then (select markup_percent from public.settings where id) when data ? 'markup_percent' then (data->>'markup_percent')::numeric else old_cost.markup_percent end;
    if cost is null or cost <= 0 or cost > 9999999999.9999 or cost <> round(cost,4)
      or percentage is null or percentage < 0 or percentage > 10000 or percentage <> round(percentage,4) then
      raise exception 'Revisa el costo neto y el porcentaje de ganancia sobre costo';
    end if;
    selling := round(cost * (1 + percentage / 100),2);
    if selling <= 0 or selling > 999999999999.99 then raise exception 'El precio calculado está fuera de rango'; end if;
    adjusted := adjusted || jsonb_build_object('price',selling);
  end if;
  p := private.write_product_core(actor,adjusted,expected);
  if coalesce(use_cost,false) then
    insert into private.product_costs(product_id,net_cost,markup_percent) values(p.id,cost,percentage)
      on conflict(product_id) do update set net_cost=excluded.net_cost,markup_percent=excluded.markup_percent,updated_at=clock_timestamp();
  elsif mode = 'manual' then
    delete from private.product_costs where product_id=p.id;
  end if;
  if coalesce(use_cost,false) or mode = 'manual' then
    insert into public.audit_logs(actor_id,action,entity_id,detail) values(actor,'product.pricing',p.id,
      jsonb_build_object('mode',case when coalesce(use_cost,false) then 'cost' else 'manual' end,'cost',cost,'markup_percent',percentage,'price',p.price));
  end if;
  return p;
end $$;

create function public.save_simple_product(data jsonb, expected timestamptz default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare actor uuid := private.require_role(true); old public.products; p public.products;
  current_percent numeric; name text := btrim(data->>'name'); adjusted jsonb;
begin
  perform pg_advisory_xact_lock(50422);
  select markup_percent into current_percent from public.settings where id;
  if data->>'expected_markup' is null or (data->>'expected_markup')::numeric is distinct from current_percent then
    raise exception 'El porcentaje general cambió. Actualiza el catálogo antes de guardar';
  end if;
  if name is null or length(name) not between 1 and 200 then raise exception 'Revisa el nombre del producto'; end if;
  if data ? 'id' then
    select * into old from public.products where id=(data->>'id')::uuid for update;
    if old.id is null then raise exception 'Producto no encontrado'; end if;
  elsif expected is not null then raise exception 'Producto no encontrado'; end if;
  adjusted := jsonb_build_object('code',coalesce(old.code,'FW-'||gen_random_uuid()::text),'name',name,'active',true);
  if data ? 'net_cost' then
    adjusted := adjusted || jsonb_build_object('pricing_mode','global_cost','net_cost',data->'net_cost');
  elsif old.id is null or exists(select 1 from private.product_costs where product_id=old.id) then
    raise exception 'Introduce un precio de costo válido';
  end if;
  p := private.write_product(actor,adjusted,expected);
  return p.id;
end $$;
revoke execute on function public.save_simple_product(jsonb,timestamptz) from public,anon;
grant execute on function public.save_simple_product(jsonb,timestamptz) to authenticated;

create function public.save_markup_percent(percentage numeric, expected numeric) returns void
language plpgsql security definer set search_path = '' as $$
declare actor uuid := private.require_role(true); before numeric; p record; affected integer := 0;
begin
  perform pg_advisory_xact_lock(50422);
  if percentage is null or percentage < 0 or percentage > 10000 or percentage <> round(percentage,4) then
    raise exception 'Indica un porcentaje entre 0 y 10000, con hasta cuatro decimales';
  end if;
  select markup_percent into before from public.settings where id for update;
  if expected is distinct from before then raise exception 'El porcentaje cambió. Actualiza la configuración'; end if;
  -- Valida todo antes de cambiar cualquier precio: un costo fuera de rango revierte la transacción.
  if exists(select 1 from private.product_costs where round(net_cost*(1+percentage/100),2) <= 0
    or round(net_cost*(1+percentage/100),2) > 999999999999.99) then
    raise exception 'El porcentaje produce precios fuera de rango';
  end if;
  update public.settings set markup_percent=percentage where id;
  for p in select pr.code,pr.updated_at,c.net_cost from public.products pr join private.product_costs c on c.product_id=pr.id
    where pr.price is distinct from round(c.net_cost*(1+percentage/100),2) or c.markup_percent is distinct from percentage
  loop
    perform private.write_product(actor,jsonb_build_object('code',p.code,'pricing_mode','global_cost','net_cost',p.net_cost),p.updated_at);
    affected := affected + 1;
  end loop;
  insert into public.audit_logs(actor_id,action,detail) values(actor,'settings.markup',jsonb_build_object('before',before,'after',percentage,'products',affected));
end $$;
revoke execute on function public.save_markup_percent(numeric,numeric) from public,anon;
grant execute on function public.save_markup_percent(numeric,numeric) to authenticated;

create or replace function public.catalog() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare admin boolean;
begin
  perform private.require_role();
  admin := private.app_role() = 'admin';
  return jsonb_build_object(
    'pricing_enabled',true, 'simple_pricing_enabled',true,
    'products',(select coalesce(jsonb_agg(to_jsonb(p) || jsonb_build_object('price_id',pr.id) ||
      case when admin then jsonb_build_object('net_cost',c.net_cost,'markup_percent',c.markup_percent) else '{}'::jsonb end
      order by p.name,p.code),'[]')
      from public.products p left join private.product_costs c on c.product_id=p.id
      left join lateral (select id from public.product_prices where product_id=p.id order by created_at desc,id desc limit 1) pr on true
      where (p.active and p.price is not null and pr.id is not null) or admin),
    'settings',(select to_jsonb(s) from public.settings s),
    'rate',(select to_jsonb(r) from public.exchange_rates r order by created_at desc,id desc limit 1),
    'methods',(select coalesce(jsonb_agg(to_jsonb(m) order by m.label),'[]') from public.payment_methods m where m.active)
  );
end $$;

-- Activación única: registra el estado anterior y crea versiones vendibles solo cuando hay precio.
do $$
declare actor uuid; changed jsonb;
begin
  perform pg_advisory_xact_lock(50422);
  select id into actor from public.profiles where role='admin' and active order by id limit 1;
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'active',active)),'[]') into changed from public.products where not active;
  if jsonb_array_length(changed)>0 then
    if actor is null then raise exception 'Se requiere un administrador activo'; end if;
    insert into public.audit_logs(actor_id,action,detail) values(actor,'products.activate_all',jsonb_build_object('before',changed));
    with activated as (
      update public.products set active=true,updated_at=clock_timestamp() where not active returning *
    ) insert into public.product_prices(product_id,amount,product_name,sellable)
      select id,price,name,true from activated where price is not null;
  end if;
end $$;
revoke execute on function private.write_product_core(uuid,jsonb,timestamptz),private.write_product(uuid,jsonb,timestamptz) from public,anon,authenticated;
do $$ begin
  if coalesce((select md5(string_agg((to_jsonb(p)-'active'-'updated_at')::text,',' order by id)) from public.products p),'')
    is distinct from current_setting('farmacia.inventario_antes_simple') then
    raise exception 'Cambios inesperados en los datos del inventario: se revierte la migración';
  end if;
end $$;
notify pgrst,'reload schema';
commit;
