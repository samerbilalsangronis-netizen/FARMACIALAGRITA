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


## Tres cajas y cierres diarios

1. En una base de prueba, aplica las migraciones en orden hasta `202611110007_turnos.sql`.
2. En **Authentication → Users**, crea `cajera1`, `cajera2` y `cajera3` con el mismo dominio de acceso que usa FarmaWorld. Confirma los correos desde el panel y asigna una contraseña distinta a cada cuenta.
3. Escribe el dominio en `supabase/configurar_cajas.sql` y ejecútalo desde SQL Editor. El script vincula las cuentas a las cajas 1, 2 y 3. Cada cajera entra con su nombre de usuario y prepara su propio equipo para vender sin conexión.
4. En **Cierres diarios**, cada cajera pulsa **Iniciar turno** con conexión y prepara o actualiza su dispositivo. Al terminar, sincroniza las ventas y pulsa **Cerrar turno**. Puede abrir otro turno el mismo día. El turno continúa después de medianoche hasta cerrarlo; su fecha de reporte es la de apertura en Venezuela. Cada turno tiene PDF propio y administración descarga un consolidado de los turnos cerrados de las tres cajas, sin repetir ventas. El dashboard conserva las ventas por fecha calendario.
5. El resumen por caja agrupa las ventas sincronizadas a partir de la asignación. Los equivalentes usan la tasa registrada en cada venta. Los cobros netos se muestran por moneda y método. Las ventas tardías y anulaciones posteriores aparecen como cambios pendientes de incorporar. La cajera puede emitir una nueva versión del cierre sin perder la anterior.

Para producción, aplica primero la migración durante la ventana acordada, vincula las tres cuentas y publica la versión de la app después de comprobar que el servidor responde. Si usas Vercel Preview, configura allí las variables de una base de prueba.

## Activar turnos en una farmacia que ya está trabajando

Publica esta versión; sin 007 la app conserva los cierres anteriores. Antes de aplicar **solo** `supabase/migrations/202611110007_turnos.sql`, sincroniza todos los equipos y termina la jornada anterior. El SQL agrega tablas, columnas y funciones de turnos: no actualiza ni elimina productos, precios, existencias, clientes ni ventas. No ejecutes de nuevo las migraciones antiguas ni el script de limpieza.

Después de ejecutar 007, recarga la aplicación en cada equipo, abre **Cierres diarios**, inicia el turno de su cajera y actualiza/prepara el dispositivo. Abrir, cerrar y consultar cierres requiere conexión. Un dispositivo previamente preparado permite vender sin red dentro de su turno y de la vigencia de su autorización. Antes de cerrar, sincroniza todos los equipos de esa caja. Las ventas tardías anteriores al cierre conservan su turno y señalan una actualización pendiente; las ventas registradas después del fin con una autorización vieja quedan pendientes de revisión y no se asignan a otro turno.

El historial anterior permanece en **Consultar cierres diarios anteriores al cambio**. Los turnos nuevos se consultan por fecha de apertura; un turno 22:00–06:00 pertenece al día en que abrió. El consolidado incluye la última versión guardada de cada turno cerrado y advierte si hay turnos abiertos o cambios pendientes.

Los indicadores administrativos de inventario suman las unidades con saldo positivo de todo el catálogo, incluidos productos inactivos. El valor en USD usa el precio de venta vigente y excluye las unidades sin precio, que se muestran como pendientes de valorar. Los saldos negativos se señalan para conciliación. Los filtros y la paginación no cambian estos totales. Editar y ajustar se abren debajo del producto; guardar requiere conexión y permiso de administrador.

## Netlify y el catálogo sin stock (008)

El repositorio incluye `netlify.toml` y `.nvmrc` para desplegar la misma app con Node 24 y el adaptador automático de Next.js en Netlify. Importa `samerbilalsangronis-netizen/FARMACIALAGRITA`, rama `main`, directorio base vacío, comando `npm run build`, directorio de publicación `.next`. No uses un despliegue de archivos estáticos: el inicio de sesión utiliza `/api/login` y necesita el adaptador de Next.js.

En las variables del proyecto de Netlify copia EXACTAMENTE los valores actuales de Vercel para `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` y `SUPABASE_LOGIN_DOMAIN`. Habilita su uso durante Builds y Functions. No crees otra base de datos ni otras cuentas; no publiques contraseñas ni una clave `service_role`. Tras cambiar variables vuelve a desplegar.

Una vez publicada esta versión, ejecuta UNA VEZ `supabase/migrations/202611140008_catalogo_sin_stock.sql` en SQL Editor de la misma base. No repitas las migraciones anteriores. El script conserva productos, precios, clientes, usuarios, ventas y cierres; guarda las cantidades anteriores en `private.stock_before_catalog_mode`, pone stock y mínimo en cero y desactiva el control. Las ventas y anulaciones siguientes no modifican existencias ni crean movimientos de stock. Las cantidades vendidas siguen figurando en comprobantes y reportes. Los productos activos necesitan un precio para venderse. El nuevo catálogo no muestra stock, ajustes ni valoración monetaria de existencias. Los CSV omiten cantidades y las importaciones las ignoran. Admin conserva la edición de precios.

Antes de eliminar Vercel verifica en la dirección nueva: acceso administrador y cajeras, catálogo y precios de Supabase, carga de logo/PDF y preparación del dispositivo. Prueba offline solo después de preparar la app en el nuevo dominio. Los datos locales de un dominio no se transfieren al otro: sincroniza cualquier venta/cliente pendiente desde Vercel si existiera; nunca borres datos locales para corregir una migración. Cuando la base aún no tiene ventas, basta comprobar que los productos y precios coinciden.

Tras validar Netlify y repartir el nuevo enlace, elimina únicamente el proyecto `farmacia-la-grita` de Vercel desde su configuración general. Esta acción retira la dirección `farmacia-la-grita.vercel.app`; conserva GitHub y el proyecto independiente de Supabase. Los accesos directos anteriores deben reemplazarse por la dirección de Netlify. La eliminación de Vercel queda pendiente hasta confirmar que Netlify está funcionando.

## Costo neto y ganancia sobre costo (009)

La migración `202611140009_costos_ganancia.sql` no cambia precios existentes. Agrega la configuración privada de costos y permite activarla por producto desde **Inventario → Editar → Calcular precio desde costo y ganancia**. Introduce **Costo neto USD** y **Ganancia sobre costo (%)**; el precio de venta es `redondear(costo × (1 + porcentaje/100), 2)`. Ejemplo: USD 10 y 25 % dan USD 12,50. Es un recargo sobre costo; el margen sobre el precio de venta en ese ejemplo es 20 %.

Los productos anteriores conservan su precio manual hasta guardar costos. Se puede volver a precio manual desmarcando el cálculo. El administrador ve costo y porcentaje en inventario; las cajeras reciben solo el precio de venta. Los costos se guardan en una tabla privada con RLS y sin permisos para clientes anónimos o autenticados. El servidor recalcula el precio y conserva el historial de precios para las ventas pendientes offline. La sincronización renueva el catálogo cuando cambian los precios. Un dispositivo sin conexión conserva su autorización y precios hasta sincronizar.

La marca **Powered by Netlify** se desactivó para este proyecto desde **Project configuration → General → Powered by Netlify badge**; no se oculta mediante CSS ni requiere pagar un plan.
