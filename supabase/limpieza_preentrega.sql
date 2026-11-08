-- Ejecutar manualmente desde Supabase SQL Editor. Esta hoja no es una migración.
-- Deja SIMULAR para consultar los conteos sin modificar datos.
-- Usa BORRAR_DATOS_DE_PRUEBA únicamente si ya verificaste que todo el historial
-- operativo es ficticio, exportaste lo que quieres conservar y cerraste las cajas.
-- Se conservan usuarios de Auth, perfiles, configuración y métodos de pago.
-- El catálogo, las tasas, las ventas y las autorizaciones offline se reinician.
-- Tras el borrado, limpia los datos locales de este sitio en cada dispositivo de
-- pruebas y vuelve a preparar el dispositivo con conexión.

begin;
set local lock_timeout = '5s';
set local farmacia.confirmar_limpieza = 'SIMULAR';

do $$
declare
  modo text := current_setting('farmacia.confirmar_limpieza');
begin
  if modo = 'SIMULAR' then
    return;
  end if;

  if modo <> 'BORRAR_DATOS_DE_PRUEBA' then
    raise exception 'Modo inválido. Usa SIMULAR o BORRAR_DATOS_DE_PRUEBA.';
  end if;

  truncate table
    public.fiscal_transfers,
    public.inventory_movements,
    public.sale_items,
    public.sale_payments,
    public.sales,
    public.inventory_imports,
    public.product_prices,
    public.products,
    public.customers,
    public.exchange_rates,
    public.device_grants
  restrict;

  delete from public.audit_logs
  where action not in ('settings.update', 'profile.update', 'payment_method.update');
end
$$;
commit;

select
  (select count(*) from public.products) as productos,
  (select count(*) from public.sales) as ventas,
  (select count(*) from public.sale_items) as renglones_de_venta,
  (select count(*) from public.sale_payments) as pagos,
  (select count(*) from public.customers) as clientes,
  (select count(*) from public.inventory_movements) as movimientos,
  (select count(*) from public.inventory_imports) as importaciones,
  (select count(*) from public.fiscal_transfers) as traslados_fiscales,
  (select count(*) from public.exchange_rates) as tasas,
  (select count(*) from public.device_grants) as autorizaciones_offline,
  (select count(*) from public.profiles) as perfiles_conservados,
  (select count(*) from public.payment_methods) as metodos_de_pago_conservados;
