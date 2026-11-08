import Decimal from "decimal.js";
import { z } from "zod";

export type Currency = "USD" | "VES" | "COP";
export type Profile = { id: string; username: string; role: "admin" | "cashier" };
export type Product = {
  id: string; code: string; barcode: string | null; name: string; ingredient: string; strength: string;
  presentation: string; category: string; laboratory: string; price: number; price_id: string;
  stock: number; min_stock: number; batch: string | null; expiration: string | null; active: boolean; updated_at: string;
};
export type Settings = {
  pharmacy_name: string; address: string; phone: string; offline_hours: number;
  rate_hours: number; stale_policy: "confirm" | "block";
};
export type Rate = { id: string; ves: number; cop: number; created_at: string };
export type Method = { code: string; label: string };
export type Catalog = { products: Product[]; settings: Settings; rate: Rate | null; methods: Method[] };
export type Grant = { id: string; cashier_id: string; issued_at: string; expires_at: string; rate_hours: number; stale_policy: "confirm" | "block"; catalog: Catalog };
export type Customer = { id: string; name: string; document: string; phone?: string; notes?: string };
export type Payment = { currency: Currency; method: string; amount: string; change_amount: string };
export type SalePayload = {
  id: string; grant_id: string; rate_id: string | null; customer_id: string | null; occurred_at: string;
  stale_confirmed: boolean; discount: string; items: { product_id: string; price_id: string; quantity: number }[]; payments: Payment[];
};
export type Receipt = {
  id: string; occurred_at: string; cashier_name: string; customer_id?: string | null; customer_name: string | null; total: number | string;
  discount?: number | string;
  sale_items: { product_id: string; name: string; quantity: number; unit_price: number | string }[];
  sale_payments: { currency: Currency; method: string; amount: number | string; change_amount: number | string; usd: number | string; rate: number | string }[];
  fiscal_status: "pending" | "review" | "transferred" | "void";
  reconciliation: boolean; fiscal_transfers?: { invoice: string; fiscal_date: string; note: string } | null;
  local?: "pending" | "error"; error?: string;
};
export type QueuedSale = { payload: SalePayload; receipt: Receipt };
export const decimal = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
export const currencies = ["USD", "VES", "COP"] as const;
export const currencyScale = (currency: Currency) => currency === "COP" ? 0 : 2;
export const amountPattern = /^\d{1,14}(?:\.\d{1,6})?$/;
export const money = (amount: number | string, currency: Currency = "USD") =>
  new Intl.NumberFormat("es-VE", { style: "currency", currency, currencyDisplay: "code", maximumFractionDigits: currencyScale(currency), minimumFractionDigits: currencyScale(currency) }).format(Number(amount));
export const displayDate = (value: string) => new Intl.DateTimeFormat("es-VE", { dateStyle: "short", timeStyle: "short", timeZone: "America/Caracas" }).format(new Date(value));
export const localDay = (value: string | number | Date = new Date()) => new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Caracas", year: "numeric", month: "2-digit", day: "2-digit",
}).format(new Date(value));

function exchangeRate(currency: Currency, rate: Rate | null) {
  return currency === "USD" ? 1 : currency === "VES" ? rate?.ves : rate?.cop;
}

export function amountInCurrency(usd: string, currency: Currency, rate: Rate | null) {
  const exchange = exchangeRate(currency, rate);
  return exchange ? new decimal(usd).times(exchange).toFixed(currencyScale(currency)) : null;
}

export function paymentValue(payment: Payment, rate: Rate | null) {
  const exchange = exchangeRate(payment.currency, rate);
  if (!exchange || !amountPattern.test(payment.amount) || !amountPattern.test(payment.change_amount)) throw new Error("Completa los importes y verifica la tasa.");
  const amount = new decimal(payment.amount);
  const change = new decimal(payment.change_amount);
  const places = currencyScale(payment.currency);
  if (!amount.gt(change) || amount.decimalPlaces() > places || change.decimalPlaces() > places || (payment.method !== "cash" && !change.isZero())) {
    throw new Error("Verifica los decimales y el cambio de cada pago.");
  }
  const usd = amount.minus(change).div(exchange).toDecimalPlaces(2);
  if (usd.lte(0)) throw new Error("Cada pago debe equivaler al menos a USD 0,01.");
  return { ...payment, rate: exchange, usd: usd.toFixed(2) };
}

export const productSchema = z.object({
  code: z.string().trim().min(1).max(60).transform((code) => code.toUpperCase()),
  name: z.string().trim().min(1).max(200),
  barcode: z.string().trim().max(100).optional(),
  ingredient: z.string().max(200).optional(),
  strength: z.string().max(120).optional(),
  presentation: z.string().max(120).optional(),
  category: z.string().max(120).optional(),
  laboratory: z.string().max(120).optional(),
  price: z.string().regex(/^\d{1,12}(?:\.\d{1,2})?$/).refine((price) => new decimal(price).gt(0)),
  stock: z.string().regex(/^\d{1,9}$/).optional(),
  min_stock: z.string().regex(/^\d{1,9}$/).optional(),
  batch: z.string().max(120).optional(),
  expiration: z.union([z.literal(""), z.iso.date()]).optional(),
  active: z.boolean().optional(),
});

export const productFields = [
  ["code", "Código interno"], ["barcode", "Código de barras"], ["name", "Nombre"],
  ["ingredient", "Principio activo"], ["strength", "Concentración"], ["presentation", "Presentación"],
  ["category", "Categoría"], ["laboratory", "Laboratorio"], ["price", "Precio USD"], ["stock", "Existencias"],
  ["min_stock", "Stock mínimo"], ["batch", "Lote"], ["expiration", "Vencimiento"],
] as const;
export type ProductField = typeof productFields[number][0];
export const normalize = (text: string) => text.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
export const disclaimer = "COMPROBANTE INTERNO DE CONTROL — NO ES FACTURA FISCAL";
