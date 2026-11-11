"use client";
import { useMemo, useRef, useState } from "react";
import { Check, CircleMinus, Plus, ScanLine, Search, ShoppingCart, Trash2, UserPlus, UserRound } from "lucide-react";
import { amountInCurrency, currencies, currencyScale, decimal, displayDate, money, normalize, paymentValue, type Currency, type Customer, type Payment, type Product, type QueuedSale, type Receipt } from "@/lib/domain";
import { expired } from "@/lib/vault";
import { accessError, type Operation } from "@/lib/use-operation";
import { Button } from "./ui/button";
import { Empty, Field, Heading, Notice } from "./ui/shared";

const bolivars = new Intl.NumberFormat("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const displayPayment = (amount: string, currency: Currency) =>
  currency === "VES" ? "Bs. " + bolivars.format(Number(amount)) : money(amount, currency);

const payment = (): Payment => ({ currency: "USD", method: "cash", amount: "", change_amount: "0" });

export function Sales({ op, onReceipt, onPrepareDevice, onOpenRegisters }: {
  op: Operation;
  onReceipt: (receipt: Receipt) => void;
  onPrepareDevice: () => void;
  onOpenRegisters: () => void;
}) {
  const [query, setQuery] = useState("");
  const [cart, setCart] = useState<Record<string, number>>({});
  const [discountInput, setDiscountInput] = useState("0");
  const [payments, setPayments] = useState<Payment[]>([payment()]);
  const [error, setError] = useState("");
  const [staleConfirmed, setStaleConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [customerOpen, setCustomerOpen] = useState(false);
  const [customerQuery, setCustomerQuery] = useState("");
  const [customerCreate, setCustomerCreate] = useState(false);
  const [savingCustomer, setSavingCustomer] = useState(false);
  const [customerError, setCustomerError] = useState("");
  const draft = useRef<QueuedSale | null>(null);
  const submitting = useRef(false);
  const local = op.local;
  const needsShift = Boolean(local?.grant.shift_required && !local.grant.shift_id);
  const customerSearch = normalize(customerQuery.trim());
  const customerMatches = op.customers.filter((row) => normalize(row.name + " " + row.document).includes(customerSearch));
  const snapshot = local?.grant.catalog ?? op.catalog;
  const products = useMemo(() => {
    const deductions = new Map<string, number>();
    for (const sale of local?.sales ?? []) {
      if (!sale.receipt.local) continue;
      for (const item of sale.payload.items) {
        deductions.set(item.product_id, (deductions.get(item.product_id) ?? 0) + item.quantity);
      }
    }
    return (snapshot?.products ?? []).filter((p): p is Product & { price: number; price_id: string } => p.active && p.price !== null && p.price_id !== null)
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
  const paymentValues = payments.map((line) => {
    try { return new decimal(paymentValue(line, rate).usd); } catch { return new decimal(0); }
  });
  const paid = paymentValues.reduce((sum, value) => sum.plus(value), new decimal(0));
  const balance = total.minus(paid);
  const displayCurrency = payments.every(({ currency }) => currency === payments[0].currency) ? payments[0].currency : "USD";
  const convertedTotal = amountInCurrency(total.toFixed(2), displayCurrency, rate);
  const convertedBalance = amountInCurrency(balance.abs().toFixed(2), displayCurrency, rate);
  const cartPrice = (usd: string) => {
    const converted = amountInCurrency(usd, displayCurrency, rate);
    return converted === null ? money(usd) : displayPayment(converted, displayCurrency);
  };

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
    if (submitting.current || savingCustomer) return;
    setError("");
    submitting.current = true;
    setBusy(true);
    try {
      if (!local || localExpired || !op.profile) throw new Error("Prepara o renueva el acceso del dispositivo para vender.");
      if (needsShift) throw new Error("Inicia tu turno en Cierres diarios y actualiza el dispositivo antes de vender.");
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
          receipt: { id, occurred_at, cashier_name: op.profile.username, customer_id: customer?.id ?? null, customer_name: customer?.name ?? null, customer_document: customer?.document ?? null, total: total.toFixed(2),
            sale_items: lines.map((p) => ({ product_id: p.id, name: p.name, quantity: p.quantity, unit_price: p.price })),
            sale_payments: applied, discount: discount.toFixed(2), fiscal_status: "pending", reconciliation: false, local: "pending" },
        };
      }
      const sale = draft.current;
      await op.queue(sale);
      draft.current = null;
      setCart({}); setDiscountInput("0"); setPayments([payment()]); setCustomer(null); setCustomerOpen(false); setCustomerCreate(false); setCustomerQuery(""); setCustomerError(""); setStaleConfirmed(false);
      onReceipt(sale.receipt);
    } catch (error) {
      if (draft.current?.payload.grant_id !== local?.grant.id || accessError(error).includes("catálogo se actualizó")) draft.current = null;
      setError(accessError(error));
    } finally {
      setBusy(false);
      submitting.current = false;
    }
  }

  function chooseCustomer(selected: Customer | null) {
    draft.current = null;
    setCustomer(selected);
    setCustomerOpen(false);
    setCustomerCreate(false);
    setCustomerError("");
    setCustomerQuery("");
  }

  return <>
    <Heading label="OPERACIÓN" title="Punto de venta">Busca los medicamentos, registra el cobro y guarda el comprobante interno.</Heading>
    {needsShift && <Notice>Inicia tu turno antes de registrar ventas. <Button variant="outline" onClick={onOpenRegisters}>Ir a Cierres diarios</Button></Notice>}
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
          <div><strong>{p.name}</strong><small>{cartPrice(String(p.price))} por unidad</small></div>
          <div className="quantity">
            <Button aria-label={"Quitar una unidad de " + p.name} className="icon-button" variant="ghost" disabled={busy} onClick={() => change(p, -1)}><CircleMinus size={18} /></Button>
            {p.quantity}
            <Button aria-label={"Agregar una unidad de " + p.name} className="icon-button" variant="ghost" disabled={busy || p.stock <= p.quantity} onClick={() => change(p, 1)}><Plus size={18} /></Button>
          </div>
          <strong>{cartPrice(new decimal(p.price).times(p.quantity).toFixed(2))}</strong>
        </div>)}
        {invalidCart && <Notice>El catálogo cambió. Retira las cantidades sin stock o vacía el carrito.</Notice>}
        {!!Object.keys(cart).length && <Button variant="ghost" disabled={busy} onClick={() => { draft.current = null; setCart({}); }}>Vaciar carrito</Button>}
        {op.profile?.role === "admin" && lines.length > 0 && <Field label="Descuento autorizado en USD"><input value={discountInput} disabled={busy} inputMode="decimal" onChange={(e) => {
          draft.current = null; setDiscountInput(e.target.value.replace(",", "."));
        }} /></Field>}
        <div className="total"><span>{convertedTotal === null || (displayCurrency === "USD" && foreign) ? "Total de referencia" : "Total a cobrar"}</span>
          <strong>{convertedTotal === null ? money(total.toFixed(2)) : displayPayment(convertedTotal, displayCurrency)}</strong>
        </div>
        {displayCurrency !== "USD" && convertedTotal !== null && <p className="muted">Referencia {money(total.toFixed(2))}</p>}
        <section className="customer-box">
          <div className="section-title"><div className="customer-heading"><UserRound size={19} /><div>
            <h3>Cliente de la venta</h3>
            <p>{customer ? customer.name + " · " + customer.document : "Venta sin cliente identificado"}</p>
          </div></div>
            <Button variant="outline" aria-expanded={customerOpen} disabled={busy || savingCustomer}
              onClick={() => setCustomerOpen(!customerOpen)}>{customerOpen ? "Cerrar" : customer ? "Cambiar" : "Seleccionar"}</Button>
          </div>
          {customer && <Button variant="ghost" disabled={busy || savingCustomer} onClick={() => chooseCustomer(null)}>Quitar cliente</Button>}
          {customerOpen && <>
            {op.connection === "offline" && <p className="muted">Modo sin internet. Los registros nuevos se sincronizan al reconectar.</p>}
            <Field label="Buscar cliente por nombre o documento">
              <input type="search" value={customerQuery} disabled={busy || savingCustomer}
                placeholder="Nombre o cédula" onChange={(event) => setCustomerQuery(event.target.value)} />
            </Field>
            {customerMatches.length ? <ul className="customer-results">
              {customerMatches.slice(0, 8).map((row) => <li key={row.id}>
                <Button variant="ghost" disabled={busy || savingCustomer} onClick={() => chooseCustomer(row)}>
                  <span>{row.name}</span><small>{row.document}</small>
                </Button>
              </li>)}
            </ul> : <p className="muted">Sin clientes para esta búsqueda.</p>}
            {customerMatches.length > 8 && <p className="muted">Refina la búsqueda para ver otros resultados.</p>}
            <Button variant="outline" disabled={busy || savingCustomer} onClick={() => setCustomerCreate(!customerCreate)}>
              <UserPlus size={17} /> {customerCreate ? "Cerrar registro" : "Registrar cliente"}
            </Button>
            {customerCreate && <form className="stack" onSubmit={async (event) => {
              event.preventDefault();
              if (savingCustomer || busy) return;
              const data = new FormData(event.currentTarget);
              setCustomerError(""); setSavingCustomer(true);
              try { chooseCustomer(await op.registerCustomer(data)); }
              catch (error) { setCustomerError(accessError(error)); }
              finally { setSavingCustomer(false); }
            }}>
              {customerError && <Notice>{customerError}</Notice>}
              <Field label="Nombre completo"><input name="name" autoComplete="off" required maxLength={160} /></Field>
              <div className="form-grid">
                <Field label="Cédula o documento"><input name="document" autoComplete="off" required maxLength={40} /></Field>
                <Field label="Teléfono (opcional)"><input name="phone" type="tel" maxLength={40} /></Field>
              </div>
              <Button type="submit" disabled={savingCustomer || busy}>{savingCustomer ? "Guardando…" : "Guardar y asignar cliente"}</Button>
            </form>}
          </>}
        </section>
        <div className="section-title payment-heading"><h3>Pagos</h3></div>
        {payments.map((line, index) => {
          const remainder = balance.plus(paymentValues[index]);
          const exact = remainder.gt(0) ? amountInCurrency(remainder.toFixed(2), line.currency, rate) : null;
          let canFill = false;
          if (exact && !busy && !invalidDiscount && lines.length && methods.some((method) => method.code === line.method)) {
            try { canFill = remainder.eq(paymentValue({ ...line, amount: exact, change_amount: "0" }, rate).usd); } catch { /* The rounded value is not an exact payment. */ }
          }
          return <div key={index}>
            <div className="payment-row">
              <Field label="Moneda"><select aria-label="Moneda" value={line.currency} disabled={busy} onChange={(e) => editPayment(index, { currency: e.target.value as Currency, amount: "", change_amount: "0" })}>
                {currencies.map((c) => <option key={c} value={c}>{c === "VES" ? "Bs. (VES)" : c}</option>)}
              </select></Field>
              <Field label="Método"><select aria-label="Método" value={line.method} disabled={busy} onChange={(e) => editPayment(index, { method: e.target.value, change_amount: "0" })}>
                {methods.map((m) => <option key={m.code} value={m.code}>{m.label}</option>)}
              </select></Field>
              <Field label="Recibido"><input value={line.amount} disabled={busy} inputMode="decimal"
                placeholder={currencyScale(line.currency) ? "0,00" : "0"}
                onChange={(e) => editPayment(index, { amount: e.target.value.replace(",", ".") })} /></Field>
              {line.method === "cash" && <Field label="Cambio"><input value={line.change_amount} disabled={busy} inputMode="decimal" onChange={(e) => editPayment(index, { change_amount: e.target.value.replace(",", ".") })} /></Field>}
              {payments.length > 1 && <Button className="icon-button" aria-label="Eliminar pago" variant="ghost" disabled={busy} onClick={() => { draft.current = null; setPayments(payments.filter((_, i) => i !== index)); }}><Trash2 size={16} /></Button>}
            </div>
            {exact && canFill && <Button variant="ghost" onClick={() => editPayment(index, { amount: exact, change_amount: "0" })}>
              Usar monto exacto · {displayPayment(exact, line.currency)}
            </Button>}
          </div>;
        })}
        <Button variant="outline" disabled={busy || payments.length >= 20} onClick={() => { draft.current = null; setPayments([...payments, payment()]); }}><Plus size={16} /> Añadir pago</Button>
        {rate && <p className="muted">1 USD = {rate.ves} VES · {rate.cop} COP. Tasa del {displayDate(rate.created_at)}.</p>}
        {foreign && stale && <Notice>{local?.grant.stale_policy === "block" ? "La tasa venció y bloquea cobros en otras monedas." :
          <label className="checkline"><input type="checkbox" checked={staleConfirmed} onChange={(event) => { draft.current = null; setStaleConfirmed(event.target.checked); }} /> Confirmo el uso de la tasa guardada.</label>}</Notice>}
        <div className="total small-total"><span>{balance.lt(0) ? "Cobro por ajustar" : "Pendiente por cobrar"}</span>
          <strong>{convertedBalance === null ? money(balance.abs().toFixed(2)) : displayPayment(convertedBalance, displayCurrency)}</strong>
        </div>
        {!local && <>
          <Notice>{op.prepared ? "Desbloquea este dispositivo para confirmar la venta." : "Prepara este dispositivo con internet para confirmar la venta."}</Notice>
          <Button variant="outline" className="full" onClick={onPrepareDevice}>
            {op.prepared ? "Desbloquear este dispositivo" : "Preparar este dispositivo"}
          </Button>
        </>}
        <Button className="full" disabled={needsShift || busy || savingCustomer || !local || localExpired || invalidCart || invalidDiscount || !lines.length} onClick={() => void confirm()}>
          <Check size={18} /> {busy ? "Guardando…" : "Confirmar venta"}
        </Button>
      </section>
    </div>
  </>;
}
