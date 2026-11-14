-- 009: precio de venta calculado desde costo neto y ganancia sobre costo.
-- No cambia los precios actuales. Se activa por producto al guardar su costo y porcentaje.
begin;
create table private.product_costs (
  product_id uuid primary key references public.products(id),
  net_cost numeric(14,4) not null check(net_cost > 0),
  markup_percent numeric(9,4) not null check(markup_percent between 0 and 10000),
  updated_at timestamptz not null default clock_timestamp()
);
alter table private.product_costs enable row level security;
revoke all on private.product_costs from public,anon,authenticated;

create function private.write_product_core(actor uuid, data jsonb, expected timestamptz)
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
      nullif(data->>'batch',''), nullif(data->>'expiration','')::date, ((data->>'price') is not null and coalesce((data->>'active')::boolean,true)))
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
      active = coalesce((data->>'price')::numeric, old.price) is not null and coalesce((data->>'active')::boolean,old.active), updated_at = clock_timestamp()
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
  if mode is not null and mode not in ('manual','cost') then raise exception 'Modo de precio inválido'; end if;
  select c.* into old_cost from private.product_costs c join public.products existing_product on existing_product.id=c.product_id
    where existing_product.code=upper(btrim(data->>'code'));
  use_cost := mode = 'cost' or (mode is distinct from 'manual' and (old_cost.product_id is not null or data ? 'net_cost' or data ? 'markup_percent'));
  if coalesce(use_cost,false) then
    cost := case when data ? 'net_cost' then (data->>'net_cost')::numeric else old_cost.net_cost end;
    percentage := case when data ? 'markup_percent' then (data->>'markup_percent')::numeric else old_cost.markup_percent end;
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
revoke execute on function private.write_product_core(uuid,jsonb,timestamptz),private.write_product(uuid,jsonb,timestamptz) from public,anon,authenticated;

create or replace function public.catalog() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare admin boolean;
begin
  perform private.require_role();
  admin := private.app_role() = 'admin';
  return jsonb_build_object(
    'pricing_enabled',true,
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
notify pgrst,'reload schema';
commit;
