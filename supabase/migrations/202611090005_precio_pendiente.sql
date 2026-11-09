begin;

alter table public.products alter column price drop not null;
alter table public.products drop constraint if exists products_active_requires_price;
alter table public.products add constraint products_active_requires_price check (price is not null or not active);

create or replace function public.catalog() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  perform private.require_role();
  return jsonb_build_object(
    'products', (select coalesce(jsonb_agg(to_jsonb(p) || jsonb_build_object('price_id', pr.id) order by p.name, p.code), '[]')
      from public.products p left join lateral (
        select id from public.product_prices where product_id = p.id order by created_at desc, id desc limit 1
      ) pr on true where (p.active and p.price is not null and pr.id is not null) or private.app_role() = 'admin'),
    'settings', (select to_jsonb(s) from public.settings s),
    'rate', (select to_jsonb(r) from public.exchange_rates r order by created_at desc, id desc limit 1),
    'methods', (select coalesce(jsonb_agg(to_jsonb(m) order by m.label), '[]') from public.payment_methods m where m.active)
  );
end $$;

create or replace function private.write_product(actor uuid, data jsonb, expected timestamptz)
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
commit;
