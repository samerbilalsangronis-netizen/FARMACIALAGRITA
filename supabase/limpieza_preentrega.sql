-- FarmaWorld San Gerardo C.A. | Limpieza de pruebas antes de importar el inventario
-- Ejecuta este archivo manualmente en Supabase > SQL Editor.
--
-- 1. Ejecuta tal como está. SIMULAR muestra los conteos sin borrar datos.
-- 2. Verifica que TODOS los datos operativos sean de prueba, exporta lo que
--    necesites conservar y cierra la app en las cajas.
-- 3. Cambia solo el valor de "set local farmacia.confirmar_limpieza" a
--    'BORRAR_DATOS_DE_PRUEBA' y ejecuta el archivo completo otra vez.
-- 4. Borra los datos del sitio en los navegadores y dispositivos de prueba.
--    Confirma primero que todas sus operaciones pendientes sean ficticias.
--    Así se descartan también los registros que existían solo sin conexión.
-- 5. Importa el inventario real, registra las tasas vigentes y vuelve a
--    preparar cada dispositivo de caja con internet.
--
-- Se borran ventas, comprobantes internos, traslados, clientes, catálogo,
-- importaciones, movimientos, tasas y autorizaciones offline. Conserva los
-- usuarios de Auth, perfiles, configuración y métodos de pago.
-- Ejecuta el borrado antes de cargar el Excel real.

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
    public.device_grants,
    public.register_closures
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
  (select count(*) from public.audit_logs) as eventos_de_auditoria,
  (select count(*) from public.profiles) as perfiles_conservados,
  (select count(*) from public.payment_methods) as metodos_de_pago_conservados;
