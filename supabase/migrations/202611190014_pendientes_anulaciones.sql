-- Aplicar junto con la versión de interfaz: controles de pendientes entre equipos.
-- No modifica productos ni precios. Aplicada en producción el 19-11-2026 con autorización.
begin;
create table private.sale_sync_queue (
 sale_id uuid primary key, owner_id uuid not null references public.profiles(id), device_id uuid not null,
 device_label text not null, grant_id uuid not null references public.device_grants(id), shift_id uuid references public.register_shifts(id),
 register_no smallint, payload jsonb not null, receipt jsonb not null,
 state text not null default 'pending' check(state in ('pending','synced','cancelled')),
 last_error text, updated_at timestamptz not null default clock_timestamp()
);
create index sale_sync_queue_shift on private.sale_sync_queue(shift_id,state);
create table private.sale_cancellations (
 sale_id uuid primary key, owner_id uuid not null references public.profiles(id), actor_id uuid not null references public.profiles(id),
 reason text not null check(length(btrim(reason)) between 3 and 500), cancelled_at timestamptz not null default clock_timestamp()
);
alter table private.sale_sync_queue enable row level security;
alter table private.sale_cancellations enable row level security;

create or replace function public.report_pending_sales(device uuid, device_label text, entries jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=private.require_role(); entry jsonb; sale_uuid uuid; g public.device_grants; existing public.sales; cancelled private.sale_cancellations; result jsonb:='[]'; box smallint; username text;
begin
 if device is null or jsonb_typeof(entries) is distinct from 'array' or jsonb_array_length(entries)>1000 then raise exception 'Lista de pendientes inválida'; end if;
 select p.username into username from public.profiles p where p.id=actor;
 -- Adquiere todos los IDs antes del bloqueo de caja, igual que confirm_sale.
 for entry in select value from jsonb_array_elements(entries) order by value->'payload'->>'id' loop
  sale_uuid:=(entry->'payload'->>'id')::uuid;
  if sale_uuid is null then raise exception 'Identificador pendiente requerido'; end if;
  perform pg_advisory_xact_lock(hashtextextended(sale_uuid::text,2));
 end loop;
 box:=private.operator_register(actor);
 if box is not null then perform pg_advisory_xact_lock(50423,box::integer); end if;
 for entry in select value from jsonb_array_elements(entries) order by value->'payload'->>'id' loop
  if pg_column_size(entry)>131072 then raise exception 'Comprobante pendiente demasiado grande'; end if;
  sale_uuid:=(entry->'payload'->>'id')::uuid;
  if sale_uuid is null then raise exception 'Identificador pendiente requerido'; end if;
  perform pg_advisory_xact_lock(hashtextextended(sale_uuid::text,2));
  select * into g from public.device_grants where id=(entry->'payload'->>'grant_id')::uuid and cashier_id=actor;
  if g.id is null then raise exception 'Autorización pendiente ajena o inexistente'; end if;
  select * into cancelled from private.sale_cancellations where sale_id=sale_uuid;
  if cancelled.sale_id is not null then
   if cancelled.owner_id<>actor then raise exception 'Operación fuera de tu alcance'; end if;
   result:=result||jsonb_build_array(jsonb_build_object('id',sale_uuid,'state','cancelled','reason',cancelled.reason));continue;
  end if;
  select * into existing from public.sales where id=sale_uuid;
  if existing.id is not null then
   if existing.cashier_id<>actor or existing.payload is distinct from entry->'payload' then
    result:=result||jsonb_build_array(jsonb_build_object('id',sale_uuid,'state','conflict','reason','El identificador existe con otros datos; solicita revisión a administración.'));
   else
    update private.sale_sync_queue set state='synced',payload='{}'::jsonb,receipt='{}'::jsonb,last_error=null,updated_at=clock_timestamp() where sale_id=sale_uuid;
    result:=result||jsonb_build_array(jsonb_build_object('id',sale_uuid,'state','synced','fiscal_status',existing.fiscal_status));
   end if;continue;
  end if;
  if exists(select 1 from private.sale_sync_queue where sale_id=sale_uuid and owner_id<>actor) then raise exception 'Identificador pendiente fuera de tu alcance'; end if;
  insert into private.sale_sync_queue(sale_id,owner_id,device_id,device_label,grant_id,shift_id,register_no,payload,receipt,last_error)
  values(sale_uuid,actor,device,left(coalesce(nullif(btrim(device_label),''),'Equipo '||username),80),g.id,g.shift_id,box,entry->'payload',
   (entry->'receipt')||jsonb_build_object('id',sale_uuid,'cashier_id',actor,'cashier_name',username),left(entry->'receipt'->>'error',1000))
  on conflict(sale_id) do update set payload=excluded.payload,receipt=excluded.receipt,last_error=excluded.last_error,updated_at=clock_timestamp()
   where private.sale_sync_queue.owner_id=actor and private.sale_sync_queue.state='pending';
  result:=result||jsonb_build_array(jsonb_build_object('id',sale_uuid,'state','pending'));
 end loop;
 return result;
end $$;

create function public.pending_sale_records() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare actor uuid:=private.require_role(); admin boolean:=private.app_role()='admin';
begin
 return coalesce((select jsonb_agg(r.receipt order by r.occurred_at desc) from (
  select q.receipt||jsonb_build_object('cashier_id',q.owner_id,'device_label',q.device_label,'remote_pending',true,
   'local',case when q.state='cancelled' then null when q.last_error is not null then 'error' else 'pending' end,
   'error',case when q.state='cancelled' then null else q.last_error end,
   'fiscal_status',case when q.state='cancelled' then 'void' else 'pending' end,'cancellation_reason',c.reason) as receipt,q.receipt->>'occurred_at' as occurred_at
  from private.sale_sync_queue q left join private.sale_cancellations c on c.sale_id=q.sale_id
  where (admin or q.owner_id=actor) and q.state in ('pending','cancelled') and not exists(select 1 from public.sales s where s.id=q.sale_id)
  union all
  select jsonb_build_object('id',s.id,'occurred_at',s.occurred_at,'cashier_id',s.cashier_id,'cashier_name',s.cashier_name,
   'customer_id',s.customer_id,'customer_name',s.customer_name,'total',s.total,'discount',s.discount,'fiscal_status','void',
   'reconciliation',s.reconciliation,'cancellation_reason',c.reason,
   'sale_items',coalesce((select jsonb_agg(jsonb_build_object('product_id',i.product_id,'name',i.name,'quantity',i.quantity,'unit_price',i.unit_price)) from public.sale_items i where i.sale_id=s.id),'[]'),
   'sale_payments',coalesce((select jsonb_agg(jsonb_build_object('currency',p.currency,'method',p.method,'amount',p.amount,'change_amount',p.change_amount,'usd',p.usd,'rate',p.rate)) from public.sale_payments p where p.sale_id=s.id),'[]')),
   s.occurred_at::text
  from private.sale_cancellations c join public.sales s on s.id=c.sale_id where admin or c.owner_id=actor
 ) r),'[]'::jsonb);
end $$;

create function public.cancel_sale_operation(sale uuid, reason text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=private.require_role(true); existing public.sales; queued private.sale_sync_queue; cancelled private.sale_cancellations; owner uuid;
begin
 if sale is null or length(coalesce(btrim(reason),'')) not between 3 and 500 then raise exception 'Indica el motivo de anulación, entre 3 y 500 caracteres'; end if;
 perform pg_advisory_xact_lock(hashtextextended(sale::text,2));
 select * into cancelled from private.sale_cancellations where sale_id=sale;
 if cancelled.sale_id is not null then return jsonb_build_object('state','cancelled','reason',cancelled.reason); end if;
 select * into existing from public.sales where id=sale;
 select * into queued from private.sale_sync_queue where sale_id=sale;
 if existing.id is null and queued.sale_id is null then raise exception 'La operación no está disponible. Sincroniza el equipo original para comunicar el pendiente antes de anular'; end if;
 owner:=coalesce(existing.cashier_id,queued.owner_id);
 if existing.id is not null and existing.fiscal_status<>'void' then
  perform public.set_fiscal_status(sale,'void','',null,btrim(reason));
 end if;
 insert into private.sale_cancellations(sale_id,owner_id,actor_id,reason) values(sale,owner,actor,btrim(reason));
 update private.sale_sync_queue set state='cancelled',last_error=null,updated_at=clock_timestamp() where sale_id=sale;
 insert into public.audit_logs(actor_id,action,entity_id,detail) values(actor,'sale.cancelled',sale,jsonb_build_object('reason',btrim(reason),'was_synced',existing.id is not null,'owner_id',owner));
 return jsonb_build_object('state','cancelled','reason',btrim(reason));
end $$;

create function private.prevent_cancelled_sale() returns trigger language plpgsql set search_path='' as $$
begin
 if exists(select 1 from private.sale_cancellations where sale_id=new.id) then raise exception 'Operación anulada por administración. No debe volver a sincronizarse'; end if;
 return new;
end $$;
create trigger prevent_cancelled_sale before insert on public.sales for each row execute function private.prevent_cancelled_sale();
create function private.resolve_sale_sync_queue() returns trigger language plpgsql set search_path='' as $$
begin
 update private.sale_sync_queue set state='synced',payload='{}'::jsonb,receipt='{}'::jsonb,last_error=null,updated_at=clock_timestamp() where sale_id=new.id;
 return new;
end $$;
create trigger resolve_sale_sync_queue after insert on public.sales for each row execute function private.resolve_sale_sync_queue();

-- Conserva las excepciones de recuperación si todavía están presentes.
do $migration$
declare definition text; old text:='then raise exception ''Pago inválido''; end if;'; replacement text;
begin
 definition:=pg_get_functiondef('public.confirm_sale(jsonb)'::regprocedure);
 replacement:=$body$then
  if applied_rate is null then raise exception 'Pago inválido: falta una tasa válida para %',currency; end if;
  if amount is null or amount<=0 then raise exception 'Pago inválido: el importe recibido debe ser mayor que cero'; end if;
  if change_given<0 or change_given>=amount then raise exception 'Pago inválido: el cambio debe ser positivo o cero y menor que lo recibido'; end if;
  if amount<>round(amount,case when currency='COP' then 0 else 2 end) or change_given<>round(change_given,case when currency='COP' then 0 else 2 end) then raise exception 'Pago inválido: revisa los decimales de %',currency; end if;
  if method is null or not(method=any(g.methods)) then raise exception 'Pago inválido: el método % no pertenece a la autorización original del comprobante',method; end if;
  if not g.payment_rules and method<>'cash' and change_given<>0 then raise exception 'Pago inválido: la autorización original no permite cambio en este método electrónico. Solicita revisión a administración'; end if;
  raise exception 'Pago inválido: el método % no está permitido en %. Solicita revisión o anulación a administración',method,currency;
 end if;$body$;
 if position(old in definition)=0 then raise exception 'La validación de pagos cambió; revisar migración 014'; end if;
 execute replace(definition,old,replacement);
 -- Una caja con pendientes conocidos de un turno anterior no abre uno nuevo.
 definition:=pg_get_functiondef('public.open_register_shift(uuid)'::regprocedure);
 old:='insert into public.register_shifts(id,register_no,cashier_id,cashier_name)';
 if position(old in definition)=0 then raise exception 'La apertura de turno cambió; revisar migración 014'; end if;
 execute replace(definition,old,$body$if exists(select 1 from private.sale_sync_queue where register_no=box and state='pending') then
  raise exception 'La caja tiene operaciones pendientes comunicadas por otro equipo. Sincroniza o anula con administración antes de abrir otro turno';
 end if;
 insert into public.register_shifts(id,register_no,cashier_id,cashier_name)$body$);
 -- Bloquea el cierre desde cualquier equipo cuando hay pendientes comunicados.
 definition:=pg_get_functiondef('public.close_register_shift(uuid)'::regprocedure);
 old:='update public.register_shifts set ended_at';
 if position(old in definition)=0 then raise exception 'El cierre de turno cambió; revisar migración 014'; end if;
 execute replace(definition,old,$body$if exists(select 1 from private.sale_sync_queue where shift_id=shift and state='pending') then
  raise exception 'Este turno tiene operaciones pendientes en uno o más equipos. Sincronízalas o solicita su anulación antes de cerrar';
 end if;
 update public.register_shifts set ended_at$body$);
 -- El historial de turnos expone los bloqueos conocidos y el equipo que los comunica.
 definition:=pg_get_functiondef('public.register_shift_day(date)'::regprocedure);
 old:='c.revision is not null and c.summary <> private.shift_summary(s.id) as changed';
 if position(old in definition)=0 then raise exception 'La consulta de turnos cambió; revisar migración 014'; end if;
 execute replace(definition,old,old||$body$,
 (select count(*) from private.sale_sync_queue q where q.shift_id=s.id and q.state='pending') as pending_count,
 (select string_agg(distinct q.device_label,', ') from private.sale_sync_queue q where q.shift_id=s.id and q.state='pending') as pending_devices$body$);
 -- Publica el indicador de disponibilidad para una actualización compatible.
 definition:=pg_get_functiondef('public.catalog()'::regprocedure);
 old:='''payment_rules_enabled'',true';
 if position(old in definition)=0 then raise exception 'El catálogo cambió; revisar migración 014'; end if;
 execute replace(definition,old,'''payment_rules_enabled'',true,''sync_controls_enabled'',true');
end $migration$;

revoke all on private.sale_sync_queue,private.sale_cancellations from public,anon,authenticated;
revoke execute on function private.prevent_cancelled_sale(),private.resolve_sale_sync_queue() from public,anon,authenticated;
revoke execute on function public.report_pending_sales(uuid,text,jsonb),public.pending_sale_records(),public.cancel_sale_operation(uuid,text) from public,anon;
grant execute on function public.report_pending_sales(uuid,text,jsonb),public.pending_sale_records(),public.cancel_sale_operation(uuid,text) to authenticated;
notify pgrst,'reload schema';
commit;
