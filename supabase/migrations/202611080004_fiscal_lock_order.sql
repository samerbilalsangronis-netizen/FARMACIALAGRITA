begin;

create or replace function public.set_fiscal_status(sale uuid, next_status text, invoice text default '', fiscal_date date default null, note text default '')
returns void language plpgsql security definer set search_path = ''
as $$
declare actor uuid := private.require_role(true); s public.sales; item record; balance integer;
begin
  if next_status = 'void' then
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
    for item in select * from public.sale_items where sale_id=sale order by product_id loop
      update public.products set stock=stock+item.quantity, updated_at=clock_timestamp()
        where id=item.product_id returning stock into balance;
      insert into public.inventory_movements(product_id,actor_id,sale_id,kind,delta,stock_after,note)
        values(item.product_id,actor,sale,'void',item.quantity,balance,left(note,500));
    end loop;
  elsif next_status <> 'review' then
    raise exception 'Transición fiscal inválida';
  end if;
  update public.sales set fiscal_status=next_status, reconciliation=case when next_status='void' then false else reconciliation end
    where id=sale;
  insert into public.audit_logs(actor_id,action,entity_id,detail)
    values(actor,'fiscal.' || next_status,sale,jsonb_build_object('note',left(note,500)));
end $$;

commit;
