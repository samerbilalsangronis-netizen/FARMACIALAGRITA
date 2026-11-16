import assert from "node:assert/strict";
import { test } from "node:test";
import { collectionTotals,methodsForCurrency,paymentsWithEstimatedChange,paymentValue } from "../src/lib/domain.ts";
const rate={id:'r',ves:100,cop:3000,created_at:'2026-11-16T12:00:00Z'};
test('cambio automático COP 20000 para un cobro de 15000 y pago mixto',()=>{
 const raw=[{currency:'COP' as const,method:'cash',amount:'20000',change_amount:'0'}];
 let result=paymentsWithEstimatedChange(raw,'5.00',rate);assert.equal(result[0].change_amount,'5000');assert.equal(paymentValue(result[0],rate).usd,'5.00');assert.equal(raw[0].change_amount,'0');
 result=paymentsWithEstimatedChange([{currency:'USD',method:'zelle',amount:'2',change_amount:'0'},...raw],'5',rate);assert.equal(result[1].change_amount,'11000');assert.equal(paymentValue(result[1],rate).usd,'3.00');
 const bs=paymentsWithEstimatedChange([{currency:'VES',method:'card',amount:'600',change_amount:'0'}],'5',rate);assert.equal(bs[0].change_amount,'100.00');
 const partial=paymentsWithEstimatedChange([{currency:'COP',method:'transfer_co',amount:'3000',change_amount:'0'}],'5',rate);assert.equal(partial[0].change_amount,'0');
});
test('monedas y métodos permitidos; cobros reales no son equivalentes convertidos',()=>{
 const methods=['cash','mobile','transfer','card','zelle','transfer_co','otro'].map(code=>({code,label:code}));
 assert.deepEqual(methodsForCurrency(methods,'USD').map(m=>m.code),['cash','zelle']);
 assert.deepEqual(methodsForCurrency(methods,'VES').map(m=>m.code),['mobile','transfer','card']);
 assert.deepEqual(methodsForCurrency(methods,'COP').map(m=>m.code),['cash','transfer_co']);
 assert.deepEqual(collectionTotals([{payments:[{currency:'USD',net:10},{currency:'VES',net:250},{currency:'COP',net:15000}]},{payments:[{currency:'USD',net:'0.10'},{currency:'USD',net:'0.20'}]}]),{USD:'10.30',VES:'250.00',COP:'15000'});
});
