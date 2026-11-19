import {test} from 'node:test';
import assert from 'node:assert/strict';
import {applyPendingResolution,pendingEntries} from '../src/lib/pending-sales.ts';
import type {QueuedSale,Receipt} from '../src/lib/domain.ts';
test('una anulación sale de la cola sin borrar el comprobante ni sus importes',()=>{
 const receipt={id:'id',local:'error',error:'Pago inválido',fiscal_status:'pending',total:'5.00',sale_payments:[{currency:'VES',amount:'5000.00'}]} as Receipt;
 const updated=applyPendingResolution(receipt,{id:'id',state:'cancelled',reason:'Operación duplicada'});
 assert.equal(updated.local,undefined);assert.equal(updated.error,undefined);assert.equal(updated.fiscal_status,'void');assert.equal(updated.cancellation_reason,'Operación duplicada');assert.deepEqual(updated.sale_payments,receipt.sale_payments);
 const rows=[{payload:{id:'id'},receipt:updated},{payload:{id:'other'},receipt}] as QueuedSale[];
 assert.deepEqual(pendingEntries(rows).map(r=>r.payload.id),['other']);assert.equal(receipt.local,'error');
});
test('una venta ya recibida se reconoce y un conflicto no se descarta',()=>{
 const r={id:'id',local:'error',error:'timeout',fiscal_status:'pending'} as Receipt;
 assert.equal(applyPendingResolution(r,{id:'id',state:'synced',fiscal_status:'void'}).fiscal_status,'void');
 assert.equal(applyPendingResolution(r,{id:'id',state:'synced'}).local,undefined);
 assert.equal(applyPendingResolution(r,{id:'id',state:'conflict',reason:'Datos diferentes'}).error,'Datos diferentes');
});
