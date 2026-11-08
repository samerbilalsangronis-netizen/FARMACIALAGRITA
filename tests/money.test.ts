import assert from "node:assert/strict";
import { test } from "node:test";
import { localDay, paymentValue } from "../src/lib/domain.ts";
const rate = { id: "test", ves: 250, cop: 4000, created_at: "2026-11-08T12:00:00Z" };
test("redondeo exacto por componente y cambio en la moneda del pago", () => {
  assert.equal(paymentValue({ currency: "VES", method: "cash", amount: "1300", change_amount: "50" }, rate).usd, "5.00");
  assert.equal(paymentValue({ currency: "COP", method: "cash", amount: "2020", change_amount: "0" }, rate).usd, "0.51");
  assert.throws(() => paymentValue({ currency: "COP", method: "cash", amount: "20.1", change_amount: "0" }, rate));
  assert.throws(() => paymentValue({ currency: "VES", method: "mobile", amount: "100", change_amount: "10" }, rate));
  assert.throws(() => paymentValue({ currency: "VES", method: "cash", amount: "1", change_amount: "0" }, null));
  assert.equal(localDay("2026-11-08T02:00:00Z"), "2026-11-07");
});
