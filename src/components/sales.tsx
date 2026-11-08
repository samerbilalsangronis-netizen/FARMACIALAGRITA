"use client";
import { useMemo, useRef, useState } from "react";
import { Check, CircleMinus, Plus, ScanLine, Search, ShoppingCart, Trash2 } from "lucide-react";
import { currencies, decimal, displayDate, money, normalize, paymentValue, type Currency, type Customer, type Payment, type Product, type QueuedSale, type Receipt } from "@/lib/domain";
import { expired } from "@/lib/vault";
import { accessError, type Operation } from "@/lib/use-operation";
import { rpc, supabase } from "@/lib/supabase";
import { Button } from "./ui/button";
import { Empty, Field, Heading, Notice } from "./ui/shared";

const payment = (): Payment => ({ currency: "USD", method: "cash", amount: "", change_amount: "0" });

export function Sales({ op, onReceipt }: { op: Operation; onReceipt: (receipt: Receipt) => void }) {
  const [query, setQuery] = useState("");
  const [cart, setCart] = useState<Record<string, number>>({});
  const [discountInput, setDiscountInput] = useState("0");
  const [payments, setPayments] = useState<Payment[]>([payment()]);
  const [error, setError] = useState("");
  const [staleConfirmed, setStaleConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [customerOpen, setCustomerOpen] = useState(false);
  const [customerList, setCustomerList] = useState<Customer[]>([]);
  const draft = useRef<QueuedSale | null>(null);
  const submitting = useRef(false);
  const local = op.local;
  const snapshot = local?.grant.catalog ?? op.catalog;
  const products = useMemo(() => {
    const deductions = new Map<string, number>();
    for (const sale of local?.sales ?? []) {
      if (!sale.receipt.local) continue;
      for (const item of sale.payload.items) {
        deductions.set(item.product_id, (deductions.get(item.product_id) ?? 0) + item.quantity);
      }
    }
    return (snapshot?.products ?? []).filter((p) => p.active)
      .map((p) => ({ ...p, stock: p.stock - (deductions.get(p.id) ?? 0) }));
  }, [local, snapshot]);
  const search = normalize(query.trim());
  const shown = products.filter((p) => normalize([p.name, p.code, p.barcode, p.ingredient].join(" ")).includes(search));
  const lines = products.filter((p) => cart[p.id]).map((p) => ({ ...p, quantity: cart[p.id] }));
  const subtotal = lines.reduce((sum, p) => sum.plus(new decimal(p.price).times(p.quantity)), new decimal(0));
  const discount = /^\d{1,12}(?:\.\d{1,2})?$/.test(discountInput) ? new decimal(discountInput) : new decimal(0);
  const invalidDiscount = (discountInput !== "" && !/^\d{1,12}(?:\.\d{1,2})?$/.test(discountInput)) ||
    (discount.gt(0) && discount.gte(subtotal));
  const total = invalidDiscount ? subtotal : subtotal.minus(discount);
  const methods = snapshot?.methods ?? [];
  const rate = snapshot?.rate ?? null;
  const stale = Boolean(rate && local && op.wallClock() - Date.parse(rate.created_at) > local.grant.rate_hours * 3_600_000);
  const foreign = payments.some((p) => p.currency !== "USD");
  const localExpired = local ? expired(local) : false;
  const invalidCart = Object.keys(cart).length !== lines.length || lines.some((p) => p.stock < p.quantity);
  const paid = payments.reduce((sum, line) => {
    try { return sum.plus(paymentValue(line, rate).usd); } catch { return sum; }
  }, new decimal(0));

  function change(p: Product, delta: number) {
    const quantity = (cart[p.id] ?? 0) + delta;
    if (delta > 0 && quantity > p.stock) return;
    draft.current = null;
    setCart((previous) => {
      const next = { ...previous };
      if (quantity <= 0) delete next[p.id]; else next[p.id] = quantity;
      return next;
    });
  }

  function editPayment(index: number, patch: Partial<Payment>) {
    draft.current = null;
    setPayments((previous) => previous.map((p, i) => i === index ? { ...p, ...patch } : p));
  }

  async function confirm() {
    if (submitting.current) return;
    setError("");
    submitting.current = true;
    setBusy(true);
    try {
      if (!local || localExpired || !op.profile) throw new Error("Prepara o renueva el acceso del dispositivo para vender.");
      if (invalidDiscount) throw new Error("Revisa el descuento en USD.");
      if (!lines.length || invalidCart) throw new Error("Revisa los productos y las existencias disponibles.");
      if (foreign && !rate) throw new Error("Configura las tasas para cobrar en VES o COP.");
      if (foreign && stale && (local.grant.stale_policy === "block" || !staleConfirmed)) {
        throw new Error("Revisa la vigencia de la tasa antes de confirmar.");
      }
      const applied = payments.map((p) => paymentValue(p, rate));
      const sum = applied.reduce((acc, p) => acc.plus(p.usd), new decimal(0));
      if (!sum.eq(total)) throw new Error("El importe neto recibido debe coincidir con el total.");
      if (!draft.current) {
        const id = crypto.randomUUID();
        const occurred_at = new Date(op.wallClock()).toISOString();
        draft.current = {
          payload: { id, occurred_at, grant_id: local.grant.id, rate_id: rate?.id ?? null, customer_id: customer?.id ?? null,
            stale_confirmed: staleConfirmed, discount: discount.toFixed(2), items: lines.map((p) => ({ product_id: p.id, price_id: p.price_id, quantity: p.quantity })), payments },
          receipt: { id, occurred_at, cashier_name: op.profile.username, customer_id: customer?.id ?? null, customer_name: customer?.name ?? null, total: total.toFixed(2),
            sale_items: lines.map((p) => ({ product_id: p.id, name: p.name, quantity: p.quantity, unit_price: p.price })),
            sale_payments: applied, discount: discount.toFixed(2), fiscal_status: "pending", reconciliation: false, local: "pending" },
        };
      }
      const sale = draft.current;
      await op.queue(sale);
      draft.current = null;
      setCart({}); setDiscountInput("0"); setPayments([payment()]); setCustomer(null); setStaleConfirmed(false);
      onReceipt(sale.receipt);
    } catch (error) {
      if (draft.current?.payload.grant_id !== local?.grant.id || accessError(error).includes("catálogo se actualizó")) draft.current = null;
      setError(accessError(error));
    } finally {
      setBusy(false);
      submitting.current = false;
    }
  }

  async function showCustomers() {
    setCustomerOpen((previous) => !previous);
    if (customerOpen) return;
    try {
      const { data, error } = await supabase().from("customers").select("id,name,document,phone").order("name").limit(500);
      if (error) throw new Error(error.message);
      setCustomerList(data as Customer[]);
    } catch (error) { setError(accessError(error)); }
  }

  return <>
    <Heading label="OPERACIÓN" title="Punto de venta">Busca los medicamentos, registra el cobro y guarda el comprobante interno.</Heading>
    {!local && <Notice>Abre «Preparar dispositivo» en la barra superior para habilitar el registro de ventas.</Notice>}
    {localExpired && <Notice>La autorización de este dispositivo venció. Renueva el acceso con conexión.</Notice>}
    {error && <Notice>{error}</Notice>}
    <div className="checkout">
      <section className="card product-browser">
        <div className="section-title"><div><h2>Buscar medicamentos</h2><p>Nombre, código interno, principio activo o código de barras.</p></div><ScanLine size={22} /></div>
        <form className="search" onSubmit={(event) => {
          event.preventDefault();
          const match = shown.find((p) => [p.code, p.barcode].some((code) => code && normalize(code) === search));
          if (match && !busy) { change(match, 1); setQuery(""); }
        }}>
          <Search size={18} /><input aria-label="Buscar medicamentos" placeholder="Buscar o escanear código…" value={query} onChange={(event) => setQuery(event.target.value)} />
        </form>
        {shown.length === 0 && <Empty>No se encontraron medicamentos.</Empty>}
        <div className="product-list">
          {shown.slice(0, 50).map((p) => <div className="product-row" key={p.id}>
            <div><strong>{p.name}</strong><small>{[p.code, p.presentation, p.strength].filter(Boolean).join(" · ")}</small></div>
            <div className="product-price"><strong>{money(p.price)}</strong><small>{Math.max(0, p.stock)} disponibles</small></div>
            <Button aria-label={"Añadir " + p.name} variant="outline" className="icon-button" disabled={busy || p.stock <= (cart[p.id] ?? 0)} onClick={() => change(p, 1)}><Plus size={18} /></Button>
          </div>)}
        </div>
        {shown.length > 50 && <p className="muted">Se muestran 50 resultados. Refina la búsqueda para ver otros productos.</p>}
      </section>
      <section className="card cart">
        <div className="section-title"><div><h2>Venta actual</h2><p>{lines.length} productos distintos</p></div><ShoppingCart size={22} /></div>
        {!lines.length && <Empty>Agrega un medicamento para empezar.</Empty>}
        {lines.map((p) => <div className="cart-line" key={p.id}>
          <div><strong>{p.name}</strong><small>{money(p.price)} por unidad</small></div>
          <div className="quantity">
            <Button aria-label={"Quitar una unidad de " + p.name} className="icon-button" variant="ghost" disabled={busy} onClick={() => change(p, -1)}><CircleMinus size={18} /></Button>
            {p.quantity}
            <Button aria-label={"Agregar una unidad de " + p.name} className="icon-button" variant="ghost" disabled={busy || p.stock <= p.quantity} onClick={() => change(p, 1)}><Plus size={18} /></Button>
          </div>
          <strong>{money(new decimal(p.price).times(p.quantity).toFixed(2))}</strong>
        </div>)}
        {invalidCart && <Notice>El catálogo cambió. Retira las cantidades sin stock o vacía el carrito.</Notice>}
        {!!Object.keys(cart).length && <Button variant="ghost" disabled={busy} onClick={() => { draft.current = null; setCart({}); }}>Vaciar carrito</Button>}
        {op.profile?.role === "admin" && lines.length > 0 && <Field label="Descuento autorizado en USD"><input value={discountInput} disabled={busy} inputMode="decimal" onChange={(e) => {
          draft.current = null; setDiscountInput(e.target.value.replace(",", "."));
        }} /></Field>}
        <div className="total"><span>Total de referencia</span><strong>{money(total.toFixed(2))}</strong></div>
        {op.connection === "online" && <Button variant="ghost" disabled={busy} onClick={() => void showCustomers()}>{customer?.name ?? "Cliente opcional"}</Button>}
        {customerOpen && op.connection === "online" && <div className="customer-box">
          <Field label="Cliente registrado"><select value={customer?.id ?? ""} onChange={(e) => { draft.current = null; setCustomer(customerList.find((c) => c.id === e.target.value) ?? null); }}>
            <option value="">Sin identificar</option>{customerList.map((c) => <option key={c.id} value={c.id}>{c.name} · {c.document}</option>)}
          </select></Field>
          <form className="stack" onSubmit={async (event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            try {
              const name = String(form.get("name"));
              const document = String(form.get("document"));
              const id = await rpc<string>("save_customer", { data: { name, document } });
              const saved = { id, name, document };
              draft.current = null;
              setCustomer(saved);
              setCustomerList((all) => [...all.filter((c) => c.id !== id), saved]);
            } catch (error) { setError(accessError(error)); }
          }}>
            <Field label="Nombre del nuevo cliente"><input name="name" required maxLength={160} /></Field>
            <Field label="Cédula o documento"><input name="document" required maxLength={40} /></Field>
            <Button type="submit" variant="outline">Guardar cliente</Button>
          </form>
        </div>}
        <div className="section-title payment-heading"><h3>Pagos</h3><Button variant="ghost" disabled={!lines.length || busy} onClick={() => {
          draft.current = null; setPayments([{ ...payment(), amount: total.toFixed(2), method: methods.find((m) => m.code === "cash")?.code ?? methods[0]?.code ?? "cash" }]);
        }}>Exacto en USD</Button></div>
        {payments.map((line, index) => <div className="payment-row" key={index}>
          <Field label="Moneda"><select value={line.currency} disabled={busy} onChange={(e) => editPayment(index, { currency: e.target.value as Currency })}>
            {currencies.map((c) => <option key={c}>{c}</option>)}
          </select></Field>
          <Field label="Método"><select value={line.method} disabled={busy} onChange={(e) => editPayment(index, { method: e.target.value, change_amount: "0" })}>
            {methods.map((m) => <option key={m.code} value={m.code}>{m.label}</option>)}
          </select></Field>
          <Field label="Recibido"><input value={line.amount} disabled={busy} inputMode="decimal" placeholder="0,00" onChange={(e) => editPayment(index, { amount: e.target.value.replace(",", ".") })} /></Field>
          {line.method === "cash" && <Field label="Cambio"><input value={line.change_amount} disabled={busy} inputMode="decimal" onChange={(e) => editPayment(index, { change_amount: e.target.value.replace(",", ".") })} /></Field>}
          {payments.length > 1 && <Button className="icon-button" aria-label="Eliminar pago" variant="ghost" disabled={busy} onClick={() => { draft.current = null; setPayments(payments.filter((_, i) => i !== index)); }}><Trash2 size={16} /></Button>}
        </div>)}
        <Button variant="outline" disabled={busy || payments.length >= 20} onClick={() => { draft.current = null; setPayments([...payments, payment()]); }}><Plus size={16} /> Añadir pago</Button>
        {rate && <p className="muted">1 USD = {rate.ves} VES · {rate.cop} COP. Tasa del {displayDate(rate.created_at)}.</p>}
        {foreign && stale && <Notice>{local?.grant.stale_policy === "block" ? "La tasa venció y bloquea cobros en otras monedas." :
          <label className="checkline"><input type="checkbox" checked={staleConfirmed} onChange={(event) => { draft.current = null; setStaleConfirmed(event.target.checked); }} /> Confirmo el uso de la tasa guardada.</label>}</Notice>}
        <div className="total small-total"><span>{paid.gt(total) ? "Cobro por ajustar" : "Pendiente por cobrar"}</span><strong>{money(total.minus(paid).abs().toFixed(2))}</strong></div>
        <Button className="full" disabled={busy || !local || localExpired || invalidCart || invalidDiscount || !lines.length} onClick={() => void confirm()}>
          <Check size={18} /> {busy ? "Guardando…" : "Confirmar venta"}
        </Button>
      </section>
    </div>
  </>;
}
