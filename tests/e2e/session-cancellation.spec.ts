import {expect,test,type BrowserContext} from '@playwright/test';
const userId='2dd1b4b8-35be-4f56-8278-599300013b31',adminId='11111111-1111-4111-8111-111111111111';
const productId='4094fc72-6ec9-4ea3-9ac4-083fb4a6c6bd',priceId='a9ca8311-a502-4bdf-8761-e97373a11c57',rateId='450472d9-b6b8-4237-b85e-3c2f6691f15f';
const token=(id:string)=>[Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url'),Buffer.from(JSON.stringify({sub:id,exp:Math.floor(Date.now()/1000)+7200})).toString('base64url'),'fixture'].join('.');
const jwt=token(userId),adminJwt=token(adminId),issuedAt=new Date().toISOString();
const catalog={settings:{pharmacy_name:'Farmacia La Grita',address:'La Grita, Táchira',phone:'',offline_hours:24,rate_hours:24,stale_policy:'confirm',stock_tracking:false},rate:{id:rateId,ves:100,cop:3000,created_at:issuedAt},methods:[{code:'cash',label:'Efectivo'},{code:'mobile',label:'Pago móvil'}],products:[{id:productId,price_id:priceId,code:'P1',name:'Acetaminofén',price:5,stock:0,active:true,min_stock:0,updated_at:issuedAt}]};
const user={id:userId,aud:'authenticated',email:'caja1@accounts.example.com',app_metadata:{},user_metadata:{}};
async function baseRoutes(context:BrowserContext,role='cashier',extra?: (path:string,request:any)=>Promise<unknown>|unknown){
 await context.route('**/api/login',async r=>{const {username}=r.request().postDataJSON();await r.fulfill({json:{access_token:username==='admin'?adminJwt:jwt,refresh_token:'fixture'}});});
 await context.route('https://supabase-fixture.example.com/**',async r=>{
  const request=r.request(),path=new URL(request.url()).pathname;let result:unknown=[];
  if(path==='/auth/v1/user')result={user};if(path==='/rest/v1/profiles')result={id:userId,username:'caja1',role,active:true};
  if(path.endsWith('/rpc/catalog'))result=catalog;
  if(path.endsWith('/rpc/authorize_device'))result={id:crypto.randomUUID(),cashier_id:userId,issued_at:new Date().toISOString(),expires_at:new Date(Date.now()+86400000).toISOString(),rate_hours:24,stale_policy:'confirm',catalog};
  const override=await extra?.(path,request);if(override!==undefined)result=override;
  if(result && typeof result==='object' && 'fixtureError' in result){await r.fulfill({status:400,json:{message:(result as any).fixtureError}});return;}
  await r.fulfill({json:result});
 });
}
async function login(page:any){await page.goto('/');await page.getByLabel('Nombre de usuario').fill('caja1');await page.getByLabel('Contraseña',{exact:true}).fill('ficticia');await page.getByRole('button',{name:'Ingresar',exact:true}).click();await expect(page.getByRole('heading',{name:'Resumen de la farmacia'})).toBeVisible();}
async function prepare(page:any){await page.getByRole('button',{name:'Preparar este dispositivo',exact:true}).click();await page.getByLabel('Clave del dispositivo',{exact:true}).fill('clave local ficticia');await page.getByLabel('Confirmar clave').fill('clave local ficticia');await page.getByRole('button',{name:'Autorizar dispositivo',exact:true}).click();await expect(page.getByText('Dispositivo preparado',{exact:true})).toBeVisible();}
async function fillSale(page:any){await page.getByRole('button',{name:'Añadir Acetaminofén'}).click();await page.getByLabel('Recibido',{exact:true}).fill('5');}

test('los totales y cobros del inicio son exclusivos de administración',async({browser},testInfo)=>{
 for(const role of ['cashier','admin']){const context=await browser.newContext();try{await baseRoutes(context,role);const page=await context.newPage();await login(page);
  await expect(page.getByText('Total vendido',{exact:true})).toHaveCount(role==='admin'?1:0);await expect(page.getByRole('heading',{name:'Cobros de hoy',exact:true})).toHaveCount(role==='admin'?1:0);
  await page.screenshot({path:testInfo.outputPath('inicio-'+role+'.png'),fullPage:true});
 }finally{await context.close();}}
});

test('mantiene el dispositivo desbloqueado tras inactividad y permite otra venta sin repetir clave',async({context,page})=>{
 let accepted=0;await baseRoutes(context,'cashier',(path,request)=>{if(path.endsWith('/rpc/confirm_sale')){accepted++;return{id:request.postDataJSON().data.id,reconciliation:false};}});
 await page.clock.install();await login(page);await page.getByRole('button',{name:'Abrir punto de venta'}).click();await prepare(page);await fillSale(page);await page.getByRole('button',{name:'Confirmar venta',exact:true}).click();await page.getByRole('button',{name:'Cerrar comprobante'}).click();await expect.poll(()=>accepted).toBe(1);
 await page.clock.fastForward('16:00');await expect(page.getByRole('heading',{name:'Punto de venta',exact:true})).toBeVisible();await expect(page.getByLabel('Clave del dispositivo',{exact:true})).toHaveCount(0);
 await fillSale(page);await expect(page.getByRole('button',{name:'Confirmar venta',exact:true})).toBeEnabled();await page.getByRole('button',{name:'Confirmar venta',exact:true}).click();await expect.poll(()=>accepted).toBe(2);
});

test('administración autoriza cancelar un pendiente sin cerrar la sesión de la cajera',async({context,page},testInfo)=>{
 const current={...catalog,sync_controls_enabled:true};let saved:any;let cancelled=false,attempts=0,cancellations=0;
 await baseRoutes(context,'cashier',(path,request)=>{
  if(path.endsWith('/rpc/catalog'))return current;
  if(path.endsWith('/rpc/authorize_device'))return{id:crypto.randomUUID(),cashier_id:userId,issued_at:new Date().toISOString(),expires_at:new Date(Date.now()+86400000).toISOString(),rate_hours:24,stale_policy:'confirm',catalog:current};
  if(path.endsWith('/rpc/report_pending_sales')){const {entries}=request.postDataJSON();if(entries[0])saved=entries[0];return entries.map((e:any)=>({id:e.payload.id,state:cancelled?'cancelled':'pending',reason:cancelled?'Comprobante duplicado':undefined}));}
  if(path.endsWith('/rpc/confirm_sale')){attempts++;return{fixtureError:'Pago inválido: rechazo simulado para comprobar la anulación'};}
  if(path.endsWith('/rpc/pending_sale_records'))return saved?[{...saved.receipt,cashier_id:userId,device_label:'Mostrador 1',remote_pending:true,local:cancelled?null:'error',error:cancelled?null:'Pago inválido: rechazo simulado',fiscal_status:cancelled?'void':'pending',cancellation_reason:cancelled?'Comprobante duplicado':null}]:[];
  if(path.endsWith('/rpc/cancel_sale_operation')){expect(request.headers()['authorization']).toBe('Bearer '+adminJwt);expect(request.postDataJSON()).toEqual({sale:saved.payload.id,reason:'Comprobante duplicado'});cancelled=true;cancellations++;return{state:'cancelled',reason:'Comprobante duplicado'};}
 });
 await login(page);await page.getByRole('button',{name:'Abrir punto de venta'}).click();await prepare(page);await fillSale(page);await page.getByRole('button',{name:'Confirmar venta',exact:true}).click();await page.getByRole('button',{name:'Cerrar comprobante'}).click();await page.getByRole('button',{name:'Historial de ventas',exact:true}).click();await expect(page.getByRole('table').getByText('Error de sincronización',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Anular factura',exact:true}).click();const dialog=page.getByRole('dialog',{name:'Anular factura'});await expect(dialog.getByRole('button',{name:'Confirmar anulación'})).toBeDisabled();await dialog.getByLabel('Motivo de anulación').fill('Comprobante duplicado');await dialog.screenshot({path:testInfo.outputPath('anular-pendiente.png')});
 await dialog.getByLabel('Usuario administrador').fill('admin');await dialog.getByLabel('Contraseña de la administradora').fill('credencial-ficticia');await dialog.getByRole('button',{name:'Confirmar anulación'}).click();await expect(page.getByRole('table').getByText('Anulada',{exact:true})).toBeVisible();await expect(page.locator('.sidebar-user strong')).toHaveText('caja1');await expect(page.getByRole('dialog')).toHaveCount(0);expect(cancellations).toBe(1);
 const before=attempts;await page.getByRole('button',{name:'Actualizar y sincronizar',exact:true}).click();await expect(page.getByRole('status').filter({hasText:'En línea'})).toBeVisible();expect(attempts).toBe(before);await expect(page.getByText(/venta pendiente de sincronizar/)).toHaveCount(0);
});

test('otra computadora ve el bloqueo de cierre por pendientes comunicados',async({context,page})=>{
 const summary={sales:0,units:0,usd:0,ves:0,cop:0,without_rate:0,discounts:0,products:[],payments:[]};
 const day=new Date().toLocaleDateString('en-CA',{timeZone:'America/Caracas'});
 await baseRoutes(context,'cashier',(path)=>{if(path.endsWith('/rpc/catalog'))return{...catalog,sync_controls_enabled:true};if(path.endsWith('/rpc/register_shift_day'))return[{id:crypto.randomUUID(),cashier_id:userId,register_no:1,cashier_name:'caja1',business_day:day,started_at:issuedAt,ended_at:null,summary,closure:null,changed:false,pending_count:1,pending_devices:'Mostrador 2'}];});
 await login(page);await page.getByRole('button',{name:'Cierres diarios',exact:true}).click();await expect(page.getByText(/pendientes comunicadas por Mostrador 2/)).toBeVisible();await expect(page.getByRole('button',{name:'Cerrar turno',exact:true})).toBeDisabled();
});

test('administración anula una factura ya sincronizada desde el historial y conserva el motivo',async({context,page},testInfo)=>{
 let cancelled=false,cancelledCount=0;const saleId=crypto.randomUUID();
 const receipt=()=>({id:saleId,occurred_at:issuedAt,cashier_name:'caja1',cashier_id:userId,customer_name:null,total:5,discount:0,sale_items:[{product_id:productId,name:'Acetaminofén',quantity:1,unit_price:5}],sale_payments:[{currency:'USD',method:'cash',amount:5,change_amount:0,usd:5,rate:1}],fiscal_status:cancelled?'void':'pending',reconciliation:false,cancellation_reason:cancelled?'Cliente desistió de la compra':undefined});
 await baseRoutes(context,'admin',(path,request)=>{
  if(path.endsWith('/rpc/catalog'))return{...catalog,sync_controls_enabled:true};
  if(path==='/rest/v1/sales')return[receipt()];
  if(path.endsWith('/rpc/pending_sale_records'))return cancelled?[receipt()]:[];
  if(path.endsWith('/rpc/cancel_sale_operation')){expect(request.postDataJSON()).toEqual({sale:saleId,reason:'Cliente desistió de la compra'});cancelled=true;cancelledCount++;return{state:'cancelled',reason:'Cliente desistió de la compra'};}
 });
 await login(page);await page.getByRole('button',{name:'Historial de ventas',exact:true}).click();await page.getByRole('button',{name:'Anular factura',exact:true}).click();const dialog=page.getByRole('dialog',{name:'Anular factura'});await expect(dialog.getByLabel('Usuario administrador')).toHaveCount(0);await dialog.getByLabel('Motivo de anulación').fill('Cliente desistió de la compra');await dialog.getByRole('button',{name:'Confirmar anulación'}).click();
 await expect(page.getByRole('table').getByText('Anulada',{exact:true})).toBeVisible();await expect(page.getByRole('table')).toContainText('Cliente desistió de la compra');expect(cancelledCount).toBe(1);await expect(page.getByRole('button',{name:'Anular factura',exact:true})).toHaveCount(0);
 await page.getByRole('button',{name:'Ver',exact:true}).click();const downloading=page.waitForEvent('download');await page.getByRole('dialog',{name:'Comprobante de venta'}).getByRole('button',{name:'PDF',exact:true}).click();await(await downloading).saveAs(testInfo.outputPath('comprobante-anulado.pdf'));await page.getByRole('button',{name:'Cerrar comprobante'}).click();
 await page.getByRole('button',{name:'Resumen',exact:true}).click();await expect(page.locator('.stat').filter({has:page.getByText('Total vendido',{exact:true})})).toContainText('0,00');
});
