-- 008: catálogo de productos y precios, sin control de stock.
-- Aplicar UNA VEZ después de 007 y de sincronizar todos los dispositivos.
-- Conserva productos, precios, usuarios, clientes, comprobantes y cierres.
-- Guarda las cantidades anteriores en un respaldo privado antes de ponerlas en cero.
begin;
alter table public.settings add column stock_tracking boolean not null default true;
lock table public.products in share row exclusive mode;
create table private.stock_before_catalog_mode (
  product_id uuid primary key,
  stock integer not null,
  min_stock integer not null,
  captured_at timestamptz not null default clock_timestamp()
);
alter table private.stock_before_catalog_mode enable row level security;
revoke all on private.stock_before_catalog_mode from public,anon,authenticated;
insert into private.stock_before_catalog_mode(product_id,stock,min_stock)
  select id,stock,min_stock from public.products;
update public.settings set stock_tracking=false;
update public.products set stock=0,min_stock=0,updated_at=clock_timestamp();
insert into public.audit_logs(actor_id,action,detail)
  select id,'inventory.catalog_mode',jsonb_build_object('stock_tracking',false,'products',(select count(*) from public.products))
  from public.profiles where role='admin' and active order by id limit 1;

create function private.keep_catalog_without_stock() returns trigger
language plpgsql set search_path = '' as $$
begin
  if not (select stock_tracking from public.settings) then
    new.stock := 0;
    new.min_stock := 0;
  end if;
  return new;
end $$;
revoke execute on function private.keep_catalog_without_stock() from public,anon,authenticated;
create trigger keep_catalog_without_stock before insert or update of stock,min_stock on public.products
  for each row execute function private.keep_catalog_without_stock();

create or replace function public.confirm_sale(data jsonb) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  actor uuid := private.require_role();
  sale_uuid uuid := (data->>'id')::uuid;
  previous public.sales;
  g public.device_grants;
  p public.products;
  price public.product_prices;
  fx public.exchange_rates;
  line jsonb;
  sold_at timestamptz := (data->>'occurred_at')::timestamptz;
  item_id uuid;
  customer uuid := (data->>'customer_id')::uuid;
  quantity integer;
  number_of_lines integer := 0;
  total numeric := 0;
  discount_amount numeric := coalesce((data->>'discount')::numeric,0);
  paid numeric := 0;
  amount numeric;
  change_given numeric;
  applied_rate numeric;
  converted numeric;
  currency text;
  method text;
  balance integer;
  needs_reconciliation boolean := false;
  tracks_stock boolean;
begin
  select stock_tracking into tracks_stock from public.settings;
  if sale_uuid is null then raise exception 'Identificador de venta requerido'; end if;
  perform pg_advisory_xact_lock(hashtextextended(sale_uuid::text,2));
  select * into previous from public.sales where id = sale_uuid;
  if found then
    if previous.cashier_id <> actor or previous.payload <> data then
      raise exception 'El identificador de venta ya está en uso';
    end if;
    return jsonb_build_object('id', previous.id, 'reconciliation', previous.reconciliation);
  end if;
  select * into g from public.device_grants where id = (data->>'grant_id')::uuid and cashier_id = actor;
  if g.id is null or sold_at is null or sold_at < g.issued_at - interval '2 minutes'
    or sold_at > g.expires_at or sold_at > clock_timestamp() + interval '2 minutes' then
    raise exception 'La venta está fuera del período autorizado del dispositivo';
  end if;
  if coalesce(jsonb_typeof(data->'items'),'') <> 'array' or jsonb_array_length(data->'items') not between 1 and 100
    or coalesce(jsonb_typeof(data->'payments'),'') <> 'array' or jsonb_array_length(data->'payments') not between 1 and 20 then
    raise exception 'La venta requiere productos y pagos válidos';
  end if;
  if customer is not null and not exists (
    select 1 from public.customers where id=customer and (owner_id=actor or private.app_role()='admin')
  ) then raise exception 'Cliente fuera de tu alcance'; end if;
  select * into fx from public.exchange_rates where created_at <= g.issued_at order by created_at desc,id desc limit 1;
  if fx.id is distinct from (data->>'rate_id')::uuid then raise exception 'Tasa distinta de la autorizada'; end if;

  for line in select value from jsonb_array_elements(data->'items') order by value->>'product_id' loop
    item_id := (line->>'product_id')::uuid;
    quantity := (line->>'quantity')::integer;
    select * into p from public.products where id=item_id for update;
    select * into price from public.product_prices where product_id=item_id and created_at <= g.issued_at
      order by created_at desc,id desc limit 1;
    if p.id is null or price.id is null or not price.sellable or price.id is distinct from (line->>'price_id')::uuid
      or quantity is null or quantity not between 1 and 10000 then
      raise exception 'Producto, cantidad o precio fuera del catálogo autorizado';
    end if;
    total := total + quantity * price.amount;
  end loop;

  if discount_amount < 0 or discount_amount >= total or discount_amount <> round(discount_amount,2)
    or (discount_amount > 0 and private.app_role() <> 'admin') then raise exception 'Descuento no autorizado o inválido'; end if;
  total := total - discount_amount;
  insert into public.sales(id,cashier_id,customer_id,cashier_name,customer_name,occurred_at,rate_id,total,discount,payload)
  values(sale_uuid,actor,customer,(select username from public.profiles where id=actor),
    (select name from public.customers where id=customer),sold_at,fx.id,total,discount_amount,data);

  for line in select value from jsonb_array_elements(data->'items') order by value->>'product_id' loop
    item_id := (line->>'product_id')::uuid;
    quantity := (line->>'quantity')::integer;
    select * into price from public.product_prices where id=(line->>'price_id')::uuid;
    if tracks_stock then
      update public.products set stock=stock-quantity, updated_at=clock_timestamp()
        where id=item_id returning * into p;
      balance := p.stock;
      needs_reconciliation := needs_reconciliation or balance < 0 or not p.active;
    end if;
    insert into public.sale_items(sale_id,product_id,price_id,name,quantity,unit_price)
      values(sale_uuid,item_id,price.id,price.product_name,quantity,price.amount);
    if tracks_stock then
      insert into public.inventory_movements(product_id,actor_id,sale_id,kind,delta,stock_after)
        values(item_id,actor,sale_uuid,'sale',-quantity,balance);
    end if;
  end loop;

  for line in select value from jsonb_array_elements(data->'payments') loop
    currency := line->>'currency';
    method := line->>'method';
    amount := (line->>'amount')::numeric;
    change_given := coalesce((line->>'change_amount')::numeric,0);
    applied_rate := case currency when 'USD' then 1 when 'VES' then fx.ves when 'COP' then fx.cop end;
    if applied_rate is null or amount is null or amount <= 0 or change_given < 0 or change_given >= amount
      or amount <> round(amount,case when currency='COP' then 0 else 2 end)
      or change_given <> round(change_given,case when currency='COP' then 0 else 2 end)
      or method is null or not (method = any(g.methods))
      or (method <> 'cash' and change_given <> 0) then raise exception 'Pago inválido'; end if;
    if currency <> 'USD' and sold_at - fx.created_at > make_interval(hours => g.rate_hours)
      and (g.stale_policy = 'block' or not coalesce((data->>'stale_confirmed')::boolean,false)) then
      raise exception 'La tasa guardada excede la vigencia autorizada';
    end if;
    converted := round((amount-change_given)/applied_rate,2);
    paid := paid + converted;
    number_of_lines := number_of_lines + 1;
    insert into public.sale_payments(sale_id,line,method,currency,amount,change_amount,rate,usd)
      values(sale_uuid,number_of_lines,method,currency,amount,change_given,applied_rate,converted);
  end loop;
  if total <> paid then raise exception 'El pago neto debe coincidir con el total'; end if;
  update public.sales set reconciliation=needs_reconciliation where id=sale_uuid;
  insert into public.audit_logs(actor_id,action,entity_id,detail)
    values(actor,'sale.confirm',sale_uuid,jsonb_build_object('reconciliation',needs_reconciliation));
  return jsonb_build_object('id',sale_uuid,'reconciliation',needs_reconciliation);
end $$;


create or replace function public.set_fiscal_status(sale uuid, next_status text, invoice text default '', fiscal_date date default null, note text default '')
returns void language plpgsql security definer set search_path = ''
as $$
declare actor uuid := private.require_role(true); s public.sales; item record; balance integer; tracks_stock boolean;
begin
  select stock_tracking into tracks_stock from public.settings;
  if next_status = 'void' and tracks_stock then
    -- Match inventory adjustments and sales: lock products in ID order before locking the sale.
    perform p.id
    from public.sale_items i
    join public.products p on p.id = i.product_id
    where i.sale_id = sale
    order by p.id
    for update of p;
  end if;

  select * into s from public.sales where id=sale for update;
  if not found or s.fiscal_status in ('transferred','void') then
    raise exception 'Operación fiscal cerrada o inexistente';
  end if;
  if next_status = 'transferred' then
    insert into public.fiscal_transfers(sale_id,invoice,fiscal_date,actor_id,note)
      values(sale,btrim(invoice),fiscal_date,actor,left(note,500));
  elsif next_status = 'void' then
    if length(coalesce(btrim(note),'')) < 3 then raise exception 'Indica el motivo de anulación'; end if;
    if tracks_stock then
    for item in select * from public.sale_items where sale_id=sale order by product_id loop
      update public.products set stock=stock+item.quantity, updated_at=clock_timestamp()
        where id=item.product_id returning stock into balance;
      insert into public.inventory_movements(product_id,actor_id,sale_id,kind,delta,stock_after,note)
        values(item.product_id,actor,sale,'void',item.quantity,balance,left(note,500));
    end loop;
    end if;
  elsif next_status <> 'review' then
    raise exception 'Transición fiscal inválida';
  end if;
  update public.sales set fiscal_status=next_status, reconciliation=case when next_status='void' then false else reconciliation end
    where id=sale;
  insert into public.audit_logs(actor_id,action,entity_id,detail)
    values(actor,'fiscal.' || next_status,sale,jsonb_build_object('note',left(note,500)));
end $$;

create or replace function public.adjust_inventory(product uuid, delta integer, reason text)
returns integer language plpgsql security definer set search_path = ''
as $$
declare actor uuid := private.require_role(true); balance integer;
begin
  if not (select stock_tracking from public.settings) then raise exception 'El catálogo funciona sin control de existencias'; end if;
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


notify pgrst,'reload schema';
commit;
