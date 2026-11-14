import assert from "node:assert/strict";
import { test } from "node:test";
import { salePriceFromCost } from "../src/lib/domain.ts";
test("ganancia sobre costo: cálculo exacto, coma decimal y redondeo",()=>{
  assert.equal(salePriceFromCost("10","25"),"12.50");
  assert.equal(salePriceFromCost("10","0"),"10.00");
  assert.equal(salePriceFromCost("0,42","25"),"0.53");
  assert.equal(salePriceFromCost("10","100"),"20.00");
  assert.equal(salePriceFromCost("1.2345","12.5"),"1.39");
});
test("rechaza costo vacío, cero, negativos y porcentajes fuera de rango",()=>{
  for(const [cost,percent] of [["","25"],["0","25"],["-1","25"],["10","-1"],["10","10001"],["10",""],["1.12345","25"]]) {
    assert.throws(()=>salePriceFromCost(cost,percent));
  }
});
