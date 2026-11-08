import assert from "node:assert/strict";
import { test } from "node:test";
import { amountInCurrency, localDay, paymentValue } from "../src/lib/domain.ts";
const rate = { id: "test", ves: 250, cop: 4000, created_at: "2026-11-08T12:00:00Z" };
test("redondeo exacto por componente y cambio en la moneda del pago", () => {
  assert.equal(paymentValue({ currency: "VES", method: "cash", amount: "1300", change_amount: "50" }, rate).usd, "5.00");
  assert.equal(paymentValue({ currency: "COP", method: "cash", amount: "2020", change_amount: "0" }, rate).usd, "0.51");
  assert.throws(() => paymentValue({ currency: "COP", method: "cash", amount: "20.1", change_amount: "0" }, rate));
  assert.throws(() => paymentValue({ currency: "VES", method: "mobile", amount: "100", change_amount: "10" }, rate));
  assert.throws(() => paymentValue({ currency: "VES", method: "cash", amount: "1", change_amount: "0" }, null));
  assert.equal(localDay("2026-11-08T02:00:00Z"), "2026-11-07");
});

test("cotiza el cobro en la moneda elegida con la tasa del catálogo", () => {
  const example = { ...rate, ves: 1000, cop: 3000 };
  assert.equal(amountInCurrency("8.00", "VES", example), "8000.00");
  assert.equal(amountInCurrency("8.00", "COP", example), "24000");
  assert.equal(amountInCurrency("6.50", "VES", example), "6500.00");
  assert.equal(amountInCurrency("8.00", "USD", null), "8.00");
  assert.equal(amountInCurrency("8.00", "VES", null), null);
});
