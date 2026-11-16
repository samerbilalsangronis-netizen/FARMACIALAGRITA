-- 012: cambio estimado automático y métodos específicos por moneda.
-- Conserva todos los comprobantes, cierres, precios y existencias.
begin;
alter table public.device_grants add column payment_rules boolean not null default false;
insert into public.payment_methods(code,label,active) values
  ('card','Punto de venta',true),('zelle','Zelle',true),('transfer_co','Transferencia colombiana',true)
  on conflict(code) do update set label=excluded.label,active=true;
create function private.method_currency_allowed(method text,currency text) returns boolean
language sql immutable set search_path='' as $$
 select coalesce(case currency
  when 'USD' then method in ('cash','zelle')
  when 'VES' then method in ('transfer','mobile','card')
  when 'COP' then method in ('cash','transfer_co')
  else false end,false);
$$;
revoke execute on function private.method_currency_allowed(text,text) from public,anon,authenticated;
create or replace function public.authorize_device() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare actor uuid := private.require_role(); g public.device_grants; s public.settings; box smallint; turn uuid;
begin
  perform pg_advisory_xact_lock(50422);
  box := private.operator_register(actor);
  if box is not null then
    perform pg_advisory_xact_lock(50423,box::integer);
    select id into turn from public.register_shifts where register_no = box and cashier_id = actor and ended_at is null;
  end if;
  select * into strict s from public.settings;
  insert into public.device_grants(cashier_id,expires_at,rate_hours,stale_policy,methods,shift_id,shift_required,payment_rules)
  values(actor,clock_timestamp() + make_interval(hours => s.offline_hours),s.rate_hours,s.stale_policy,
    array(select code from public.payment_methods where active),turn,box is not null,true) returning * into g;
  return to_jsonb(g) || jsonb_build_object('catalog',public.catalog());
end $$;

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
  estimated_change numeric;
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
    if g.payment_rules then
      estimated_change := greatest(amount-round(greatest(total-paid,0)*applied_rate,case when currency='COP' then 0 else 2 end),0);
      if change_given is distinct from estimated_change then raise exception 'El cambio no coincide con el cálculo automático'; end if;
    end if;
    if applied_rate is null or amount is null or amount <= 0 or change_given < 0 or change_given >= amount
      or amount <> round(amount,case when currency='COP' then 0 else 2 end)
      or change_given <> round(change_given,case when currency='COP' then 0 else 2 end)
      or method is null or not (method = any(g.methods))
      or (not g.payment_rules and method <> 'cash' and change_given <> 0)
      or (g.payment_rules and not private.method_currency_allowed(method,currency)) then raise exception 'Pago inválido'; end if;
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


create or replace function public.catalog() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare admin boolean;
begin
  perform private.require_role();
  admin := private.app_role() = 'admin';
  return jsonb_build_object(
    'pricing_enabled',true, 'simple_pricing_enabled',true, 'admin_shifts_enabled',true, 'payment_rules_enabled',true,
    'products',(select coalesce(jsonb_agg(to_jsonb(p) || jsonb_build_object('price_id',pr.id) ||
      case when admin then jsonb_build_object('net_cost',c.net_cost,'markup_percent',c.markup_percent) else '{}'::jsonb end
      order by p.name,p.code),'[]')
      from public.products p left join private.product_costs c on c.product_id=p.id
      left join lateral (select id from public.product_prices where product_id=p.id order by created_at desc,id desc limit 1) pr on true
      where p.active or admin),
    'settings',(select to_jsonb(s) from public.settings s),
    'rate',(select to_jsonb(r) from public.exchange_rates r order by created_at desc,id desc limit 1),
    'methods',(select coalesce(jsonb_agg(to_jsonb(m) || jsonb_build_object('currencies',(select jsonb_agg(c) from unnest(array['USD','VES','COP']) c where private.method_currency_allowed(m.code,c))) order by m.label),'[]') from public.payment_methods m where m.active and (private.method_currency_allowed(m.code,'USD') or private.method_currency_allowed(m.code,'VES') or private.method_currency_allowed(m.code,'COP')))
  );
end $$;



notify pgrst,'reload schema';
commit;
