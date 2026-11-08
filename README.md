# Farmacia La Grita

Sistema web de contingencia para el registro de ventas, cobros e inventario durante apagones. La operación fiscal se realiza en el sistema de la farmacia. Los comprobantes emitidos aquí son documentos internos de control.

## Configuración desde el navegador

1. Crea un proyecto de Supabase. En **SQL Editor**, ejecuta por orden los archivos de [supabase/migrations](supabase/migrations). Se aplican una sola vez, en un proyecto dedicado a esta farmacia. Conserva el historial de las migraciones.
2. En **Authentication**, deshabilita el registro público y el alta anónima. Crea un usuario desde **Users** con la confirmación de correo marcada. Usa un alias del tipo `administrador@tu-dominio-de-acceso` y una contraseña privada. La interfaz muestra y acepta solo `administrador`.
3. Copia el UUID de esa cuenta y crea su perfil en **SQL Editor**. Repite el proceso para cada cajero usando el rol `cashier`.

   ```sql
   insert into public.profiles (id, username, role)
   values ('UUID_COPIADO_DE_AUTH', 'administrador', 'admin');
   ```

4. En Vercel, crea un proyecto e importa `FARMACIALAGRITA`. Usa `main` como rama de producción, Next.js como framework, Node.js 24, raíz del repositorio y comando de build predeterminado (`npm run build`). Agrega las siguientes variables al entorno de producción y despliega.

   | Variable | Valor |
   | --- | --- |
   | `NEXT_PUBLIC_SUPABASE_URL` | URL del proyecto de Supabase |
   | `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Clave publicable del proyecto |
   | `SUPABASE_LOGIN_DOMAIN` | Parte posterior al signo @ de los alias de Auth, sin incluir el signo @ |

5. Abre la URL HTTPS de producción, ingresa con el primer usuario administrador y configura las tasas y los productos con datos de prueba. Si cambias las variables públicas después del build, vuelve a desplegar.

El alta y la recuperación de credenciales se gestionan desde Supabase. En la aplicación, los administradores pueden cambiar el rol o desactivar perfiles registrados. Este proyecto requiere únicamente la clave publicable para conectarse a Supabase.

## Operación durante un apagón

- Inicia sesión con internet desde el teléfono o la tableta. En **Preparar dispositivo**, registra una frase privada de al menos 12 caracteres, distinta de la contraseña de usuario. Comprueba que el menú muestre **Dispositivo preparado** antes de cortar la red.
- Usa la opción **Instalar** cuando el navegador la ofrezca. En iPhone o iPad, abre Safari y usa **Compartir → Añadir a pantalla de inicio**. Si el sistema abre el acceso instalado en un contexto de almacenamiento distinto, prepara ese acceso con internet también.
- Durante el apagón, abre el acceso preparado. Si la sesión se cerró, elige **Acceder sin conexión** y usa tu nombre de usuario y la clave local. El catálogo, la última tasa y la cola de ventas están cifrados en IndexedDB con AES-GCM y una clave derivada de la frase. El dispositivo se bloquea tras 15 minutos de inactividad. La autorización tiene una vigencia configurable de 1 a 72 horas.
- Al volver la red, una sesión autenticada sincroniza en segundo plano mientras la app esté abierta. Si ingresaste con la clave local después de cerrar el navegador, elige **Reconectar** e introduce tu contraseña de usuario. Revisa los errores que se muestran en pantalla.
- Conserva la aplicación instalada y los datos del navegador mientras haya operaciones pendientes. Borrar datos, perder el dispositivo o usar una sesión privada puede impedir recuperar las ventas locales. El administrador debe conciliar cualquier operación pendiente de una cuenta antes de desactivarla.
- Dos dispositivos pueden vender el último producto mientras están desconectados. Al sincronizar, ambas operaciones se conservan y se muestra el saldo negativo para conciliación. El administrador registra el ajuste con un motivo. El acceso offline usa la autorización previamente concedida hasta su vencimiento y el servidor comprueba nuevamente el perfil al sincronizar.
- En **Pendientes fiscales**, registra la fecha y la referencia del documento del sistema fiscal una vez emitido. En **Reportes**, selecciona el período del apagón y descarga el resumen. Los informes muestran cobros netos por moneda, con el total de venta en USD de referencia.
- Para impresión térmica, selecciona 58 mm u 80 mm en el comprobante y configura el ancho de papel en el diálogo de tu impresora.

## Importación de inventario

Admite CSV, XLS y XLSX. Usa la primera fila para encabezados y la primera hoja de Excel. Cada archivo admite hasta 1.000 filas y 3 MB. Conserva los códigos con ceros iniciales como texto en Excel. Asigna las columnas a código interno, nombre y precio en USD. Usa punto o coma decimal sin separador de miles y fechas AAAA-MM-DD.

El asistente identifica por código interno, señala conflictos de código o código de barras y muestra las diferencias antes de aplicar cambios. Una importación da de alta las existencias iniciales. Para productos existentes, revisa las diferencias de cantidad y registra cualquier cambio mediante un movimiento auditado. El inventario del piloto registra un lote y un vencimiento por ficha de producto. Usa códigos distintos si necesitas fichas independientes por lote.

## Validación y piloto

- `npm ci` instala las versiones del archivo de bloqueo.
- `npm run typecheck` valida TypeScript y `npm run build` genera la versión de producción y la precaché offline.
- `npm test` comprueba cálculos decimales y migraciones, permisos, importación idempotente, ventas, conciliación y estados fiscales sobre PostgreSQL en PGlite.
- `npx playwright install chromium` y `npm run test:e2e` ejecutan el flujo offline de la PWA en Chromium con un backend simulado. El entorno de prueba usa credenciales ficticias.
- Antes del piloto, repite el recorrido en Vercel con el proyecto real de Supabase, dos cuentas, dos dispositivos, datos ficticios y la impresora que se utilizará. Verifica en particular el reinicio offline, las ventas concurrentes con el mismo stock, los permisos, el traslado fiscal y la recuperación de operaciones pendientes.

### Actualizar una instalación existente

Si ya aplicaste las tres primeras migraciones, ejecuta solo [202611080004_fiscal_lock_order.sql](supabase/migrations/202611080004_fiscal_lock_order.sql) en Supabase. Corrige el orden de bloqueos al anular una venta al mismo tiempo que se ajusta el inventario.

### Limpieza después de las pruebas

El archivo [limpieza_preentrega.sql](supabase/limpieza_preentrega.sql) se ejecuta manualmente en el SQL Editor. En modo `SIMULAR` solo muestra los conteos. El modo de borrado vacía el historial operativo completo y se usa únicamente si todos esos registros son ficticios. Conserva las cuentas, los perfiles, la configuración y los métodos de pago. Cierra las cajas, revisa que las colas de prueba se hayan sincronizado y exporta cualquier dato que quieras conservar antes de usarlo. Después, borra los datos locales del sitio en los dispositivos usados para pruebas, vuelve a prepararlos con internet y configura las tasas vigentes.
