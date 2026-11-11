-- 007: turnos por caja, varios cierres y jornadas nocturnas.
-- Ejecutar después de 006. No modifica productos, precios ni existencias.
begin;
create table public.register_shifts (
  id uuid primary key,
  register_no smallint not null check (register_no between 1 and 3),
  cashier_id uuid not null references public.profiles(id),
  cashier_name text not null,
  started_at timestamptz not null default clock_timestamp(),
  business_day date not null default (clock_timestamp() at time zone 'America/Caracas')::date,
  ended_at timestamptz,
  check (ended_at is null or ended_at >= started_at)
);
create unique index register_one_open_shift on public.register_shifts(register_no) where ended_at is null;
create index register_shift_day on public.register_shifts(business_day, register_no);
create table public.shift_closures (
  shift_id uuid not null references public.register_shifts(id),
  revision integer not null check (revision > 0),
  closed_at timestamptz not null default clock_timestamp(),
  summary jsonb not null,
  primary key (shift_id, revision)
);
alter table public.register_shifts enable row level security;
alter table public.shift_closures enable row level security;
revoke all on public.register_shifts, public.shift_closures from public, anon, authenticated;
alter table public.sales add column shift_id uuid references public.register_shifts(id);
create index sales_shift on public.sales(shift_id) where shift_id is not null;
alter table public.device_grants add column shift_id uuid references public.register_shifts(id),
  add column shift_required boolean not null default false;

create function public.open_register_shift(request_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare actor uuid := private.require_role(); p public.profiles; previous public.register_shifts;
begin
  select * into p from public.profiles where id = actor;
  if p.role <> 'cashier' or p.register_no is null then raise exception 'Tu usuario debe tener una caja asignada'; end if;
  if request_id is null then raise exception 'Falta identificar el turno'; end if;
  perform pg_advisory_xact_lock(50423,p.register_no::integer);
  select * into previous from public.register_shifts where id = request_id;
  if previous.id is not null then
    if previous.cashier_id <> actor then raise exception 'Turno no autorizado'; end if;
    return previous.id;
  end if;
  select * into previous from public.register_shifts where register_no = p.register_no and ended_at is null;
  if previous.id is not null then
    if previous.cashier_id <> actor then raise exception 'La caja tiene un turno abierto de otra cajera'; end if;
    return previous.id;
  end if;
  insert into public.register_shifts(id,register_no,cashier_id,cashier_name)
    values(request_id,p.register_no,actor,p.username);
  return request_id;
end $$;

create or replace function public.authorize_device() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare actor uuid := private.require_role(); g public.device_grants; s public.settings; box smallint; turn uuid;
begin
  perform pg_advisory_xact_lock(50422);
  select register_no into box from public.profiles where id = actor;
  if box is not null then
    perform pg_advisory_xact_lock(50423,box::integer);
    select id into turn from public.register_shifts where register_no = box and cashier_id = actor and ended_at is null;
  end if;
  select * into strict s from public.settings;
  insert into public.device_grants(cashier_id,expires_at,rate_hours,stale_policy,methods,shift_id,shift_required)
  values(actor,clock_timestamp() + make_interval(hours => s.offline_hours),s.rate_hours,s.stale_policy,
    array(select code from public.payment_methods where active),turn,box is not null) returning * into g;
  return to_jsonb(g) || jsonb_build_object('catalog',public.catalog());
end $$;

create or replace function private.assign_sale_register() returns trigger
language plpgsql set search_path = '' as $$
declare g public.device_grants; turn public.register_shifts;
begin
  select register_no into new.register_no from public.profiles where id = new.cashier_id;
  if new.register_no is null then return new; end if;
  perform pg_advisory_xact_lock(50423,new.register_no::integer);
  select * into g from public.device_grants where id = (new.payload->>'grant_id')::uuid;
  if g.shift_required then
    if g.shift_id is null then raise exception 'Inicia un turno y actualiza el dispositivo antes de vender'; end if;
    select * into turn from public.register_shifts where id = g.shift_id;
    if turn.cashier_id <> new.cashier_id or turn.register_no <> new.register_no
      or new.occurred_at < turn.started_at or (turn.ended_at is not null and new.occurred_at >= turn.ended_at) then
      raise exception 'La venta está fuera del turno autorizado. Actualiza el dispositivo';
    end if;
    new.shift_id := turn.id;
  else
    select * into turn from public.register_shifts s where s.cashier_id = new.cashier_id
      and s.register_no = new.register_no and new.occurred_at >= s.started_at
      and (s.ended_at is null or new.occurred_at < s.ended_at) order by s.started_at desc limit 1;
    if turn.id is not null then new.shift_id := turn.id;
    elsif exists (select 1 from public.register_shifts s where s.cashier_id = new.cashier_id and s.started_at <= new.occurred_at) then
      raise exception 'Inicia un turno y actualiza el dispositivo antes de vender';
    end if;
  end if;
  -- Las autorizaciones anteriores a 007 conservan sus ventas sin turno.
  return new;
end $$;

create function private.shift_summary(shift uuid)
returns jsonb language sql stable set search_path = ''
as $$
  with sales_day as (
    select s.id, s.total, s.discount, s.rate_id
    from public.sales s
    where s.shift_id = shift
      and s.fiscal_status <> 'void'
  ), totals as (
    select count(*) as sales, coalesce(sum(s.total), 0) as usd,
           sum(round(s.total * r.ves, 2)) as ves, sum(round(s.total * r.cop)) as cop,
           count(*) filter (where r.id is null) as without_rate,
           coalesce(sum(s.discount), 0) as discounts,
           coalesce(jsonb_agg(s.id order by s.id), '[]') as sale_ids
    from sales_day s left join public.exchange_rates r on r.id = s.rate_id
  ), products as (
    select i.product_id, i.name, sum(i.quantity) as units, sum(i.quantity * i.unit_price) as subtotal
    from sales_day s join public.sale_items i on i.sale_id = s.id
    group by i.product_id, i.name
  ), payments as (
    select p.currency, p.method, sum(p.amount - p.change_amount) as net
    from sales_day s join public.sale_payments p on p.sale_id = s.id
    group by p.currency, p.method
  )
  select jsonb_build_object(
    'sales', t.sales, 'usd', t.usd,
    'ves', case when t.without_rate = 0 then coalesce(t.ves, 0) end,
    'cop', case when t.without_rate = 0 then coalesce(t.cop, 0) end,
    'without_rate', t.without_rate, 'discounts', t.discounts, 'sale_ids', t.sale_ids,
    'units', coalesce((select sum(p.units) from products p), 0),
    'products', coalesce((select jsonb_agg(to_jsonb(p) order by p.name, p.product_id) from products p), '[]'),
    'payments', coalesce((select jsonb_agg(to_jsonb(p) order by p.currency, p.method) from payments p), '[]')
  ) from totals t;
$$;


create function public.close_register_shift(shift uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare actor uuid := private.require_role(); turn public.register_shifts; previous public.shift_closures; snapshot jsonb;
begin
  select * into turn from public.register_shifts where id = shift and cashier_id = actor;
  if turn.id is null or private.app_role() <> 'cashier' then raise exception 'Turno no autorizado'; end if;
  perform pg_advisory_xact_lock(50423,turn.register_no::integer);
  update public.register_shifts set ended_at = coalesce(ended_at,clock_timestamp()) where id = shift;
  snapshot := private.shift_summary(shift);
  select * into previous from public.shift_closures where shift_id = shift order by revision desc limit 1;
  if previous.revision is not null and previous.summary = snapshot then return previous.revision; end if;
  insert into public.shift_closures(shift_id,revision,summary) values(shift,coalesce(previous.revision,0)+1,snapshot)
    returning revision into previous.revision;
  return previous.revision;
end $$;

create function public.register_shift_day(report_day date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare actor uuid := private.require_role(); admin boolean := private.app_role() = 'admin';
begin
  if report_day is null or report_day > (current_timestamp at time zone 'America/Caracas')::date then
    raise exception 'Selecciona una fecha válida';
  end if;
  return coalesce((select jsonb_agg(to_jsonb(t) order by t.register_no,t.started_at) from (
    select s.id,s.register_no,s.cashier_name,s.business_day,s.started_at,s.ended_at,
      private.shift_summary(s.id) - 'sale_ids' as summary,
      case when c.revision is not null then jsonb_build_object('revision',c.revision,'closed_at',c.closed_at,'summary',c.summary - 'sale_ids') end as closure,
      c.revision is not null and c.summary <> private.shift_summary(s.id) as changed
    from public.register_shifts s
    left join lateral (select * from public.shift_closures where shift_id = s.id order by revision desc limit 1) c on true
    where (admin or s.cashier_id = actor) and (s.business_day = report_day or s.ended_at is null)
  ) t), '[]'::jsonb);
end $$;
revoke execute on function private.shift_summary(uuid) from public,anon,authenticated;
revoke execute on function public.open_register_shift(uuid), public.close_register_shift(uuid),public.register_shift_day(date) from public,anon;
grant execute on function public.open_register_shift(uuid), public.close_register_shift(uuid),public.register_shift_day(date) to authenticated;
-- El historial por fecha anterior a 007 se mantiene disponible; desde ahora se cierra por turno.
create or replace function public.close_register(report_day date) returns integer
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_role();
  raise exception 'Actualiza la aplicación y utiliza Cerrar turno';
end $$;
notify pgrst, 'reload schema';
commit;
