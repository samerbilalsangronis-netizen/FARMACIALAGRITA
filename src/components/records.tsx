"use client";
import { pharmacyBrand, pharmacyDisplayName } from "@/lib/brand";
import { useState } from "react";
import { ArrowDownToLine, ClipboardCheck, FileText, Printer, X } from "lucide-react";
import { currencies, decimal, disclaimer, displayDate, localDay, money, normalize, type Catalog, type Receipt } from "@/lib/domain";
import { exportTable, type ExportCell } from "@/lib/export";
import { rpc } from "@/lib/supabase";
import { accessError, type Operation } from "@/lib/use-operation";
import { Button } from "./ui/button";
import { Empty, Field, Heading, Notice } from "./ui/shared";

export const fiscalLabels = { pending: "Pendiente", review: "En revisión", transferred: "Trasladada", void: "Anulada" };
const syncLabel = (receipt: Receipt) => receipt.local === "error" ? "Error de sincronización" : receipt.local ? "Guardada en el dispositivo" : "Sincronizada";

export function ReceiptView({ receipt, catalog, close }: { receipt: Receipt; catalog: Catalog | null; close: () => void }) {
  const [width, setWidth] = useState("80");
  const [error, setError] = useState("");
  const [exporting, setExporting] = useState(false);
  const paymentName = (method: string) => catalog?.methods.find((m) => m.code === method)?.label ?? method;
  const settings = catalog?.settings;
  const pharmacy = pharmacyDisplayName(settings?.pharmacy_name);
  const number = receipt.id.slice(0, 8).toUpperCase();
  const issued = displayDate(receipt.occurred_at);
  const customer = receipt.customer_name ?? "Sin identificar";
  const fiscal = fiscalLabels[receipt.fiscal_status];
  const subtotal = new decimal(receipt.total).plus(receipt.discount ?? 0).toFixed(2);
  const lineTotal = (item: Receipt["sale_items"][number]) =>
    money(new decimal(item.unit_price).times(item.quantity).toFixed(2));

  async function savePdf() {
    setError(""); setExporting(true);
    try {
      const [{ createReportPdf }, logo] = await Promise.all([import("@/lib/report-pdf"), fetch(pharmacyBrand.logo)]);
      if (!logo.ok) throw new Error("El logo aún no está disponible en este dispositivo. Actualiza la app con internet.");
      const pdf = createReportPdf({
        title: "Comprobante interno", summaryTitle: "Resumen de la venta", pharmacy,
        logo: new Uint8Array(await logo.arrayBuffer()), rif: pharmacyBrand.rif,
        address: settings?.address, phone: settings?.phone,
        period: "Operación " + number + "  ·  " + issued, issuedAt: displayDate(new Date().toISOString()),
        coverage: disclaimer,
        indicators: [
          { label: "TOTAL", value: money(receipt.total) },
          { label: "SUBTOTAL", value: money(subtotal) },
          { label: "DESCUENTO", value: money(receipt.discount ?? 0) },
        ],
        sections: [
          { title: "Identificación y estado", columns: [{ label: "Campo", width: 24 }, { label: "Detalle", width: 68 },
            { label: "Campo", width: 25 }, { label: "Detalle", width: 61 }],
            rows: [["Operación", receipt.id, "Atendido por", receipt.cashier_name],
              ["Cliente", customer, "Documento", receipt.customer_document ?? "-"],
              ["Registro", syncLabel(receipt), "Estado fiscal", fiscal],
              ...(receipt.fiscal_transfers ? [["Ref. fiscal", receipt.fiscal_transfers.invoice, "Fecha fiscal", receipt.fiscal_transfers.fiscal_date]] : [])] },
          { title: "Productos", columns: [{ label: "Producto", width: 76 }, { label: "Cant.", width: 20, align: "right" },
            { label: "Precio unitario", width: 41, align: "right" }, { label: "Importe", width: 41, align: "right" }],
            rows: receipt.sale_items.map((item) => [item.name, String(item.quantity), money(item.unit_price), lineTotal(item)]) },
          { title: "Detalle del cobro", columns: [{ label: "Método", width: 54 },
            { label: "Recibido", width: 40, align: "right" }, { label: "Cambio", width: 40, align: "right" },
            { label: "Tasa por USD", width: 44, align: "right" }],
            rows: receipt.sale_payments.map((line) => [paymentName(line.method), money(line.amount, line.currency),
              money(line.change_amount, line.currency), line.currency === "USD" ? "-" : money(line.rate, line.currency)]) },
        ],
      });
      pdf.save("comprobante-" + number.toLowerCase() + ".pdf");
    } catch (error) { setError(accessError(error)); }
    finally { setExporting(false); }
  }

  return <div className="receipt-overlay" onClick={close}>
    <section className="receipt-dialog" role="dialog" aria-modal="true" aria-label="Comprobante de venta" onClick={(event) => event.stopPropagation()}>
      <div className="receipt-tools"><h2>Comprobante interno</h2><Button aria-label="Cerrar comprobante" variant="ghost" className="icon-button" onClick={close}><X size={20} /></Button></div>
      {error && <Notice>{error}</Notice>}
      <article id="print-receipt" className={"receipt-paper print-" + width}>
        <header className="receipt-header">
          <img src={pharmacyBrand.logo} alt="Logo de FarmaWorld" width={1280} height={539} />
          <h2>{pharmacy}</h2>
          <p>RIF {pharmacyBrand.rif}</p>
          {settings?.address && <p>{settings.address}</p>}
          {settings?.phone && <p>{settings.phone}</p>}
        </header>
        <p className="receipt-warning">{disclaimer}</p>
        <dl className="receipt-meta">
          <div><dt>Operación</dt><dd>{number}</dd></div>
          <div><dt>Fecha y hora</dt><dd>{issued}</dd></div>
          <div><dt>Atendido por</dt><dd>{receipt.cashier_name}</dd></div>
          <div><dt>Cliente</dt><dd>{customer}{receipt.customer_document && <small>Documento {receipt.customer_document}</small>}</dd></div>
        </dl>
        <div className="receipt-lines">
          <h3>Productos</h3>
          {receipt.sale_items.map((item) => <div key={item.product_id}><span>{item.name}<small>{item.quantity} × {money(item.unit_price)}</small></span>
            <strong>{lineTotal(item)}</strong></div>)}
        </div>
        <div className="receipt-totals">
          <div><span>Subtotal</span><span>{money(subtotal)}</span></div>
          {Number(receipt.discount ?? 0) > 0 && <div><span>Descuento</span><span>{money(receipt.discount ?? 0)}</span></div>}
        </div>
        <div className="receipt-total"><span>Total</span><strong>{money(receipt.total)}</strong></div>
        <div className="receipt-lines">
          <h3>Detalle del cobro</h3>
          {receipt.sale_payments.map((line, i) => <div key={i}><span>{paymentName(line.method)}
            {Number(line.change_amount) > 0 && <small>Cambio {money(line.change_amount, line.currency)}</small>}
            {line.currency !== "USD" && <small>Tasa {line.rate} {line.currency} por USD</small>}</span>
            <strong>{money(line.amount, line.currency)}</strong></div>)}
        </div>
        <footer className="receipt-footer">
          <p>{syncLabel(receipt)} · Fiscal {fiscal.toLowerCase()}</p>
          {receipt.fiscal_transfers && <p>Referencia {receipt.fiscal_transfers.invoice} · {receipt.fiscal_transfers.fiscal_date}</p>}
          <small>ID {receipt.id}</small>
        </footer>
      </article>
      <div className="toolbar receipt-tools">
        <select aria-label="Ancho de impresión" value={width} onChange={(e) => setWidth(e.target.value)}>
          <option value="58">Térmica 58 mm</option><option value="80">Térmica 80 mm</option><option value="a4">Convencional</option>
        </select>
        <Button variant="outline" onClick={() => window.print()}><Printer size={17} /> Imprimir</Button>
        <Button variant="outline" disabled={exporting} onClick={() => void savePdf()}><ArrowDownToLine size={17} /> {exporting ? "Generando…" : "PDF"}</Button>
      </div>
    </section>
  </div>;
}

export function Records({ op, fiscal = false, onReceipt }: { op: Operation; fiscal?: boolean; onReceipt: (receipt: Receipt) => void }) {
  const [query, setQuery] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [currency, setCurrency] = useState("");
  const [method, setMethod] = useState("");
  const [status, setStatus] = useState(fiscal ? "open" : "");
  const [sync, setSync] = useState("");
  const [selected, setSelected] = useState<Receipt | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const canEdit = op.profile?.role === "admin" && op.connection !== "offline";
  const rows = op.receipts.filter((r) => {
    const day = localDay(r.occurred_at);
    return (!from || day >= from) && (!to || day <= to) &&
      (!currency || r.sale_payments.some((p) => p.currency === currency)) &&
      (!method || r.sale_payments.some((p) => p.method === method)) &&
      (!status || (status === "open" ? ["pending", "review"].includes(r.fiscal_status) : r.fiscal_status === status)) &&
      (!sync || (sync === "synced" ? !r.local : sync === r.local)) &&
      normalize([r.id, r.cashier_name, r.customer_name, ...r.sale_items.map((p) => p.name)].join(" ")).includes(normalize(query.trim()));
  });
  async function exportSales(format: "csv" | "xlsx" | "pdf") {
    try {
      await exportTable(fiscal ? "pendientes-fiscales" : "historial-ventas",
        ["ID", "Fecha", "Cajero", "Cliente", "Productos", "Cobros", "USD", "Sincronización", "Traslado fiscal", "Referencia"],
        rows.map((r) => [r.id, displayDate(r.occurred_at), r.cashier_name, r.customer_name,
          r.sale_items.map((i) => i.quantity + " × " + i.name).join(", "),
          r.sale_payments.map((p) => [p.method, p.amount, p.currency, "cambio " + p.change_amount, "tasa " + p.rate].join(" ")).join(" · "),
          Number(r.total), syncLabel(r), fiscalLabels[r.fiscal_status], r.fiscal_transfers?.invoice ?? null]), format);
    } catch (error) { setError(accessError(error)); }
  }

  return <>
    <div className="top-actions"><Heading label={fiscal ? "CONTROL FISCAL" : "OPERACIÓN"} title={fiscal ? "Pendientes fiscales" : "Historial de ventas"}>
      {fiscal ? "Revisa las operaciones y registra la referencia emitida por el sistema fiscal de la farmacia." : "Consulta comprobantes y exporta las operaciones registradas."}
    </Heading><div className="actions">{(["csv", "xlsx", "pdf"] as const).map((format) =>
      <Button key={format} disabled={!rows.length} variant="outline" onClick={() => void exportSales(format)}><ArrowDownToLine size={16} /> {format.toUpperCase()}</Button>)}</div></div>
    {op.connection === "offline" && <Notice>Se muestran las operaciones guardadas en el dispositivo y las consultadas en esta sesión.</Notice>}
    <LoadHistory op={op} />
    {error && <Notice>{error}</Notice>}{message && <Notice success>{message}</Notice>}
    {selected && canEdit && <section className="card stack">
      <h2>Revisar venta {selected.id.slice(0, 8)}</h2>
      <p>{displayDate(selected.occurred_at)} · {money(selected.total)}</p>
      <form className="stack" onSubmit={async (event) => {
        event.preventDefault();
        if (busy) return;
        const form = new FormData(event.currentTarget, (event.nativeEvent as SubmitEvent).submitter);
        const action = String(form.get("action"));
        if (action === "void" && !window.confirm("¿Anular esta venta y devolver las unidades al inventario?")) return;
        setBusy(true); setError("");
        try {
          await rpc("set_fiscal_status", { sale: selected.id, next_status: action, invoice: String(form.get("invoice") ?? ""), fiscal_date: form.get("date") || null, note: String(form.get("note") ?? "") });
          setSelected(null); setMessage("Estado fiscal guardado."); await op.sync(true);
        } catch (error) { setError(accessError(error)); } finally { setBusy(false); }
      }}>
        <div className="form-grid">
          <Field label="Número de factura fiscal"><input name="invoice" maxLength={100} /></Field>
          <Field label="Fecha fiscal"><input name="date" type="date" defaultValue={localDay()} /></Field>
          <Field label="Observaciones o motivo de anulación"><input name="note" maxLength={500} /></Field>
        </div>
        <div className="actions"><Button type="submit" disabled={busy} name="action" value="transferred">Marcar trasladada</Button>
          <Button type="submit" variant="outline" disabled={busy} name="action" value="review">En revisión</Button>
          <Button type="submit" variant="danger" disabled={busy} name="action" value="void">Anular venta</Button>
          <Button variant="ghost" onClick={() => setSelected(null)}>Cerrar</Button></div>
      </form>
    </section>}
    <section className="card stack">
      <div className="form-grid">
        <Field label="Buscar"><input placeholder="Producto, cliente, cajero o ID" value={query} onChange={(e) => setQuery(e.target.value)} /></Field>
        <Field label="Desde"><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="Hasta"><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        <Field label="Moneda"><select value={currency} onChange={(e) => setCurrency(e.target.value)}><option value="">Todas</option>{currencies.map((c) => <option key={c}>{c}</option>)}</select></Field>
        <Field label="Método"><select value={method} onChange={(e) => setMethod(e.target.value)}><option value="">Todos</option>{op.catalog?.methods.map((m) => <option key={m.code} value={m.code}>{m.label}</option>)}</select></Field>
        <Field label="Sincronización"><select value={sync} onChange={(e) => setSync(e.target.value)}><option value="">Todas</option><option value="pending">Pendiente</option><option value="error">Error</option><option value="synced">Sincronizada</option></select></Field>
        <Field label="Estado fiscal"><select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Todos</option><option value="open">Pendientes y en revisión</option>
          {Object.entries(fiscalLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
      </div>
      {rows.length ? <div className="table-scroll"><table>
        <thead><tr><th>Operación</th><th>Cajero</th><th>Total</th><th>Sincronización</th><th>Fiscal</th><th>Acciones</th></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.id}>
          <td><strong>{r.id.slice(0, 8)}</strong><small>{displayDate(r.occurred_at)}</small></td><td>{r.cashier_name}<small>{r.customer_name}</small></td><td>{money(r.total)}</td>
          <td><span className={r.local ? "pill warning" : "pill green"}>{syncLabel(r)}</span>{r.reconciliation && <small>Requiere conciliar inventario</small>}{r.error && <small>{r.error}</small>}</td>
          <td>{fiscalLabels[r.fiscal_status]}<small>{r.fiscal_transfers?.invoice}</small></td>
          <td><div className="actions"><Button variant="ghost" onClick={() => onReceipt(r)}><FileText size={16} /> Ver</Button>
            {fiscal && canEdit && !r.local && ["pending", "review"].includes(r.fiscal_status) && <Button variant="outline" onClick={() => setSelected(r)}><ClipboardCheck size={16} /> Revisar</Button>}</div></td>
        </tr>)}</tbody></table></div> : <Empty>No hay operaciones para estos filtros.</Empty>}
    </section>
  </>;
}

export function summarize(receipts: Receipt[]) {
  const rows = receipts.filter((r) => r.fiscal_status !== "void");
  const byPayment = new Map<string, { currency: typeof currencies[number]; method: string; net: InstanceType<typeof decimal> }>();
  const byItem = new Map<string, { name: string; quantity: number }>();
  const byCashier = new Map<string, { count: number; total: InstanceType<typeof decimal> }>();
  const byDay = new Map<string, InstanceType<typeof decimal>>();
  for (const sale of rows) {
    for (const p of sale.sale_payments) {
      const key = p.method + "|" + p.currency;
      const net = new decimal(p.amount).minus(p.change_amount);
      byPayment.set(key, { currency: p.currency, method: p.method, net: (byPayment.get(key)?.net ?? new decimal(0)).plus(net) });
    }
    for (const p of sale.sale_items) byItem.set(p.product_id, { name: p.name, quantity: (byItem.get(p.product_id)?.quantity ?? 0) + p.quantity });
    const staff = byCashier.get(sale.cashier_name) ?? { count: 0, total: new decimal(0) };
    byCashier.set(sale.cashier_name, { count: staff.count + 1, total: staff.total.plus(sale.total) });
    const day = localDay(sale.occurred_at);
    byDay.set(day, (byDay.get(day) ?? new decimal(0)).plus(sale.total));
  }
  const total = rows.reduce((acc, sale) => acc.plus(sale.total), new decimal(0));
  const payments = [...byPayment.values()];
  const products = [...byItem.values()].sort((a, b) => b.quantity - a.quantity);
  const amounts = currencies.map((currency) => ({ currency,
    total: payments.filter((p) => p.currency === currency).reduce((acc, p) => acc.plus(p.net), new decimal(0)) }));
  return { rows, total, payments, products, amounts, byDay, byCashier,
    units: products.reduce((sum, p) => sum + p.quantity, 0),
    localCount: rows.filter((r) => r.local).length,
    fiscalCount: rows.filter((r) => ["pending", "review"].includes(r.fiscal_status)).length,
  };
}

export function Reports({ op }: { op: Operation }) {
  const [from, setFrom] = useState(localDay());
  const [to, setTo] = useState(localDay());
  const [error, setError] = useState("");
  const periodReceipts = op.receipts.filter((r) => {
    const day = localDay(r.occurred_at);
    return (!from || day >= from) && (!to || day <= to);
  });
  const stats = summarize(periodReceipts);
  const labelFor = (method: string) => op.catalog?.methods.find((m) => m.code === method)?.label ?? method;
  const exportName = "reporte-de-ventas";
  const dates = [...stats.byDay.entries()].sort(([a], [b]) => a.localeCompare(b));
  const max = Math.max(1, ...dates.map(([, value]) => value.toNumber()));
  const low = (op.catalog?.products ?? []).filter((p) => p.active && p.stock <= p.min_stock).sort((a, b) => a.stock - b.stock);
  async function exportReportPdf() {
    const [{ createReportPdf }, logo] = await Promise.all([import("@/lib/report-pdf"), fetch(pharmacyBrand.logo)]);
    if (!logo.ok) throw new Error("No se pudo cargar el logo del reporte. Abre la app con internet para actualizarlo.");
    const formatDay = (day: string) => day.split("-").reverse().join("/");
    const period = from && to ? formatDay(from) + " al " + formatDay(to) :
      from ? "Desde el " + formatDay(from) : to ? "Hasta el " + formatDay(to) : "Todo el período disponible";
    const coverage = [
      op.connection === "offline" ? "El informe reúne los datos disponibles sin conexión en este dispositivo y en la sesión." : "",
      op.historyTruncated ? "Hay operaciones anteriores sin cargar que pueden quedar fuera del informe." : "",
      stats.localCount ? "El total incluye ventas aún pendientes de sincronizar." : "",
    ].filter(Boolean).join(" ");
    const settings = op.catalog?.settings;
    const right = (label: string, width: number) => ({ label, width, align: "right" as const });
    const count = new Intl.NumberFormat("es-VE");
    const statusCounts = [
      ["Sincronizadas", stats.rows.filter((r) => !r.local).length],
      ["Por sincronizar", stats.rows.filter((r) => r.local === "pending").length],
      ["Con error de sincronización", stats.rows.filter((r) => r.local === "error").length],
      ["Pendientes fiscales o en revisión", stats.fiscalCount],
      ["Trasladadas al sistema fiscal", stats.rows.filter((r) => r.fiscal_status === "transferred").length],
      ["Con inventario por conciliar", stats.rows.filter((r) => r.reconciliation).length],
      ["Anuladas (excluidas de los totales)", periodReceipts.length - stats.rows.length],
    ] as const;
    const pdf = createReportPdf({
      title: "Reporte de ventas",
      pharmacy: pharmacyDisplayName(settings?.pharmacy_name),
      logo: new Uint8Array(await logo.arrayBuffer()),
      rif: pharmacyBrand.rif,
      address: settings?.address,
      phone: settings?.phone,
      period,
      issuedAt: displayDate(new Date().toISOString()),
      coverage,
      indicators: [
        { label: "TOTAL DE REFERENCIA", value: money(stats.total.toFixed(2)) },
        { label: "VENTAS VIGENTES", value: count.format(stats.rows.length) },
        { label: "UNIDADES VENDIDAS", value: count.format(stats.units) },
        { label: "TICKET PROMEDIO", value: money(stats.rows.length ? stats.total.div(stats.rows.length).toFixed(2) : "0") },
        { label: "POR SINCRONIZAR", value: count.format(stats.localCount) },
        { label: "PENDIENTES FISCALES", value: count.format(stats.fiscalCount) },
      ],
      sections: [
        { title: "Cobros netos por moneda", columns: [{ label: "Moneda", width: 100 }, right("Total neto", 78)],
          rows: stats.amounts.map(({ currency, total }) => [currency, money(total.toString(), currency)]) },
        { title: "Desglose por método de pago", columns: [{ label: "Método", width: 88 }, { label: "Moneda", width: 28 }, right("Total neto", 62)],
          rows: stats.payments.map((p) => [labelFor(p.method), p.currency, money(p.net.toString(), p.currency)]) },
        { title: "Estado de las operaciones", columns: [{ label: "Estado", width: 128 }, right("Operaciones", 50)],
          rows: statusCounts.map(([label, value]) => [label, count.format(value)]) },
        { title: "Productos vendidos", columns: [{ label: "Producto", width: 130 }, right("Unidades", 48)],
          rows: stats.products.map((p) => [p.name, count.format(p.quantity)]) },
        { title: "Ventas por día", columns: [{ label: "Fecha", width: 100 }, right("Total de referencia", 78)],
          rows: dates.map(([day, total]) => [formatDay(day), money(total.toFixed(2))]) },
        { title: "Actividad por cajero", columns: [{ label: "Cajero", width: 78 }, right("Ventas", 36), right("Total de referencia", 64)],
          rows: [...stats.byCashier].map(([cashier, data]) => [cashier, count.format(data.count), money(data.total.toFixed(2))]) },
        { title: "Detalle de operaciones", columns: [{ label: "Fecha y hora", width: 30 }, { label: "Referencia", width: 26 },
          { label: "Cajero", width: 27 }, { label: "Sincronización", width: 35 }, { label: "Estado fiscal", width: 26 }, right("Total", 34)],
          rows: periodReceipts.map((r) => [displayDate(r.occurred_at), r.id.slice(0, 8), r.cashier_name,
            r.local === "error" ? "Error" : r.local ? "Pendiente" : "Sincronizada", fiscalLabels[r.fiscal_status], money(r.total)]) },
      ],
    });
    pdf.save(exportName + ".pdf");
  }

  return <>
    <Heading label="ANÁLISIS" title="Reportes">Revisa ventas por período, productos y actividad por cajero.</Heading>
    {error && <Notice>{error}</Notice>}
    {op.connection === "offline" && <Notice>El reporte usa las operaciones disponibles en este dispositivo y en la sesión.</Notice>}
    <LoadHistory op={op} />
    <section className="card toolbar">
      <Field label="Desde"><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
      <Field label="Hasta"><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
      {(["csv", "pdf"] as const).map((format) => <Button key={format} variant="outline" onClick={async () => {
        try {
          if (format === "pdf") return await exportReportPdf();
          const rows: ExportCell[][] = [
            ["Período", from + " a " + to], ["Ventas", stats.rows.length], ["Total USD de referencia", stats.total.toFixed(2)],
            ["Unidades", stats.units], ["Pendientes de sincronizar", stats.localCount], ["Pendientes fiscales", stats.fiscalCount],
            ...stats.amounts.map(({ currency, total }) => ["Total cobrado", currency, total.toString()]),
            ...stats.payments.map((p) => [labelFor(p.method), p.currency, p.net.toString()]),
            ...stats.products.map((p) => [p.name, "Unidades", p.quantity]),
          ];
          await exportTable(exportName, ["Concepto", "Valor o moneda", "Importe"], rows, format);
        } catch (error) { setError(accessError(error)); }
      }}><ArrowDownToLine size={17} /> {format.toUpperCase()}</Button>)}
    </section>
    <div className="stats-grid">
      {[["Operaciones", stats.rows.length], ["Total USD", money(stats.total.toFixed(2))], ["Unidades vendidas", stats.units],
        ["Por sincronizar", stats.localCount], ["Pendientes fiscales", stats.fiscalCount]].map(([label, value]) => <section className="card stat" key={label}><span>{label}</span><strong>{value}</strong></section>)}
    </div>
    <div className="split">
      <section className="card stack"><h2>Cobros por moneda</h2>
        {stats.amounts.map(({ currency, total }) => <div className="list-line" key={currency}><span>{currency}</span><strong>{money(total.toString(), currency)}</strong></div>)}
        {stats.payments.map((p) => <div className="list-line" key={p.method + p.currency}><span>{labelFor(p.method)} · {p.currency}</span><strong>{money(p.net.toString(), p.currency)}</strong></div>)}
      </section>
      <section className="card stack"><h2>Productos vendidos</h2>{stats.products.length ? stats.products.map((p, i) => <div className="list-line" key={p.name + i}><span>{p.name}</span><strong>{p.quantity}</strong></div>) : <Empty>Sin ventas en el período.</Empty>}</section>
    </div>
    <div className="split">
      <section className="card stack"><h2>Ventas por día</h2>{dates.length ? dates.map(([day, total]) =>
        <div className="chart-row" key={day}><span>{day}</span><div className="chart-track"><span style={{ width: 100 * total.toNumber() / max + "%" }} /></div><b>{money(total.toFixed(2))}</b></div>) : <Empty>Sin ventas en el período.</Empty>}</section>
      <section className="card stack"><h2>Ventas por cajero</h2>{stats.byCashier.size ? [...stats.byCashier.entries()].map(([name, totals]) => <div className="list-line" key={name}><span>{name} · {totals.count} ventas</span><strong>{money(totals.total.toFixed(2))}</strong></div>) : <Empty>Sin ventas en el período.</Empty>}</section>
      <section className="card stack"><h2>Menor existencia</h2>{low.length ? low.slice(0, 20).map((p) => <div className="list-line" key={p.id}><span>{p.name}</span><strong>{p.stock}</strong></div>) : <Empty>Sin productos bajo el mínimo.</Empty>}</section>
    </div>
  </>;
}

function LoadHistory({ op }: { op: Operation }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!op.historyTruncated) return null;
  return <section className="card toolbar">
    <span>Hay ventas más antiguas en el servidor. Cárgalas para incluirlas en los filtros y exportaciones.</span>
    <Button variant="outline" disabled={busy || op.connection === "offline"} onClick={async () => {
      setBusy(true); setError("");
      try { await op.loadMoreHistory(); } catch (error) { setError(accessError(error)); } finally { setBusy(false); }
    }}>{busy ? "Cargando…" : "Cargar ventas anteriores"}</Button>
    {error && <Notice>{error}</Notice>}
  </section>;
}
