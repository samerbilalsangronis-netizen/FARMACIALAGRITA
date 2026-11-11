"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Download, RefreshCw } from "lucide-react";
import { pharmacyBrand, pharmacyDisplayName } from "@/lib/brand";
import { decimal, displayDate, localDay, money, type Currency } from "@/lib/domain";
import type { ReportSection } from "@/lib/report-pdf";
import { rpc } from "@/lib/supabase";
import { accessError, type Operation } from "@/lib/use-operation";
import { Button } from "./ui/button";
import { Empty, Field, Heading, Notice } from "./ui/shared";

export type Summary = {
  sales: number;
  units: number;
  usd: number;
  ves: number | null;
  cop: number | null;
  without_rate: number;
  discounts: number;
  products: { product_id: string; name: string; units: number; subtotal: number }[];
  payments: { currency: Currency; method: string; net: number }[];
};
type Closure = { revision: number; closed_at: string; cashier_name: string; summary: Summary };
type Register = { register_no: number; username: string | null; summary: Summary; closure: Closure | null; changed: boolean };

const count = new Intl.NumberFormat("es-VE");
const equivalent = (value: number | string | null, currency: Currency) => value === null ? "Sin tasa" : money(value, currency);

function status(box: Register) {
  if (box.changed) return "Cierre por actualizar";
  if (box.closure) return "Cerrada";
  return box.username ? "Pendiente de cierre" : "Sin cajera asignada";
}

export function DailyRegisters({ op, dashboard = false, readOnly = false }: { op: Operation; dashboard?: boolean; readOnly?: boolean }) {
  const admin = op.profile?.role === "admin";
  const [today, setToday] = useState(() => localDay());
  const [date, setDate] = useState(today);
  const [result, setResult] = useState<{ day: string; boxes: Register[] } | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const requestId = useRef(0);
  const day = dashboard ? today : date;
  const connected = !op.needsReconnect && op.connection !== "offline";
  const pending = op.local?.sales.some(({ receipt }) => Boolean(receipt.local)) ?? false;
  const boxes = result?.day === day ? result.boxes : null;
  const closed = boxes?.filter((box): box is Register & { closure: Closure } => box.closure !== null) ?? [];

  const load = useCallback(async () => {
    const request = ++requestId.current;
    try {
      const entries = await rpc<Register[]>("register_day", { report_day: day });
      if (request === requestId.current) { setResult({ day, boxes: entries }); setError(""); }
    } catch (error) {
      if (request === requestId.current) setError(accessError(error));
    }
  }, [day]);

  useEffect(() => {
    const timer = window.setInterval(() => setToday(localDay()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!connected) return;
    void load();
    const timer = window.setInterval(() => void load(), 30_000);
    return () => { requestId.current++; window.clearInterval(timer); };
  }, [connected, load]);

  async function close() {
    if (busy || pending || op.connection !== "online") return;
    setBusy(true); setError(""); setNotice("");
    try {
      const revision = await rpc<number>("close_register", { report_day: day });
      setConfirm(false);
      await load();
      setNotice("Cierre registrado · Versión " + revision);
    } catch (error) { setError(accessError(error)); }
    finally { setBusy(false); }
  }

  async function download(only?: number) {
    const entries = only === undefined ? closed : closed.filter((box) => box.register_no === only);
    if (!entries.length || busy) return;
    setBusy(true); setError("");
    try {
      const [{ createReportPdf }, image] = await Promise.all([import("@/lib/report-pdf"), fetch(pharmacyBrand.logo)]);
      if (!image.ok) throw new Error("No se pudo cargar el logo de FarmaWorld.");
      const total = (currency: "usd" | "ves" | "cop") =>
        entries.some(({ closure }) => closure.summary[currency] === null) ? null :
          entries.reduce((sum, { closure }) => sum.plus(closure.summary[currency] ?? 0), new decimal(0)).toFixed(currency === "cop" ? 0 : 2);
      const right = (label: string, width: number) => ({ label, width, align: "right" as const });
      const sections: ReportSection[] = [];
      if (only === undefined) {
        sections.push({
          title: "Comparativo por caja",
          columns: [{ label: "Caja / cajera", width: 38 }, { label: "Estado", width: 35 }, right("Ventas", 18),
            right("Unidades", 21), right("Descuento", 28), right("Total USD", 38)],
          rows: (boxes ?? []).map((box) => {
            const summary = box.closure?.summary;
            const name = box.closure?.cashier_name ?? box.username;
            const state = box.closure ? status(box) + " · v" + box.closure.revision : status(box);
            return [
              "Caja " + box.register_no + (name ? " / " + name : ""), state,
              summary ? count.format(summary.sales) : "—", summary ? count.format(summary.units) : "—",
              summary ? money(summary.discounts) : "—", summary ? money(summary.usd) : "—",
            ];
          }),
        });
      }

      for (const { register_no: box, closure: { summary, closed_at, revision } } of entries) {
        if (only === undefined) sections.push({
          title: "Caja " + box + " · Datos del cierre",
          columns: [{ label: "Fecha y hora", width: 55 }, right("Versión", 23), right("Equiv. Bs.", 50), right("Equiv. COP", 50)],
          rows: [[displayDate(closed_at), String(revision), equivalent(summary.ves, "VES"), equivalent(summary.cop, "COP")]],
        });
        const prefix = only === undefined ? "Caja " + box + " · " : "";
        sections.push({
          title: prefix + "Productos vendidos",
          columns: [{ label: "Producto", width: 96 }, right("Unidades", 28), right("Subtotal USD", 54)],
          rows: summary.products.map((p) => [p.name, count.format(p.units), money(p.subtotal)]),
        }, {
          title: prefix + "Cobros netos",
          columns: [{ label: "Método", width: 78 }, { label: "Moneda", width: 32 }, right("Importe", 68)],
          rows: summary.payments.map((p) => [op.catalog?.methods.find((m) => m.code === p.method)?.label ?? p.method, p.currency, money(p.net, p.currency)]),
        });
      }
      const sales = entries.reduce((sum, { closure }) => sum + closure.summary.sales, 0);
      const units = entries.reduce((sum, { closure }) => sum + closure.summary.units, 0);
      const individual = only === undefined ? null : entries[0].closure;
      const facts = individual ? [
        { label: "CAJERA", value: individual.cashier_name },
        { label: "CIERRE / VERSIÓN " + individual.revision, value: displayDate(individual.closed_at) },
        { label: "VENTAS / UNIDADES", value: count.format(sales) + " / " + count.format(units) },
        { label: "DESCUENTOS", value: money(individual.summary.discounts) },
      ] : [
        { label: "CAJAS INCLUIDAS", value: entries.length + " de 3" },
        { label: "VENTAS", value: count.format(sales) },
        { label: "UNIDADES", value: count.format(units) },
      ];
      const settings = op.catalog?.settings;
      const report = createReportPdf({
        title: only === undefined ? "Cierre diario consolidado" : "Cierre diario · Caja " + only,
        pharmacy: pharmacyDisplayName(settings?.pharmacy_name), logo: new Uint8Array(await image.arrayBuffer()), rif: pharmacyBrand.rif,
        address: settings?.address, phone: settings?.phone, period: "Fecha de operación " + day, issuedAt: displayDate(new Date().toISOString()),
        register: { label: individual ? "CIERRE INDIVIDUAL" : "REPORTE DE ADMINISTRACIÓN", facts },
        coverage: (individual && entries[0].changed ? "Este cierre tiene movimientos posteriores pendientes de incorporar. " : "") +
          "Los equivalentes usan la tasa de cada venta. Los subtotales por producto se muestran antes de descuentos.",
        summaryTitle: individual ? "Total vendido en la caja" : "Total vendido en las cajas incluidas",
        indicators: [
          { label: "VENTAS EN USD", value: equivalent(total("usd"), "USD") },
          { label: "EQUIVALENTE EN BS.", value: equivalent(total("ves"), "VES") },
          { label: "EQUIVALENTE EN COP", value: equivalent(total("cop"), "COP") },
        ],
        sections,
      });
      report.save("cierre-" + day + (only === undefined ? "-consolidado" : "-caja-" + only) + ".pdf");
    } catch (error) { setError(accessError(error)); }
    finally { setBusy(false); }
  }

  return <>
    {dashboard ? <div className="section-title"><div><h2>Ventas de hoy por caja</h2><p>Ventas sincronizadas. Equivalentes según la tasa de cada venta.</p></div></div> :
      <Heading label="OPERACIÓN DE CAJA" title="Cierres diarios">{admin ? "Consulta los cierres de las tres cajas y descarga el consolidado." : "Revisa tus ventas sincronizadas y registra el cierre de tu caja."}</Heading>}
    {!dashboard && <div className="toolbar">
      <Field label="Fecha de operación"><input type="date" value={day} max={today} disabled={busy}
        onChange={(event) => { if (event.target.value) setDate(event.target.value); setConfirm(false); setError(""); setNotice(""); }} /></Field>
      <Button variant="outline" disabled={!connected || busy} onClick={() => void load()}><RefreshCw size={16} /> Actualizar cierres</Button>
      {admin && <Button disabled={!closed.length || busy} onClick={() => void download()}><Download size={17} /> PDF consolidado</Button>}
    </div>}
    {error && <Notice>{error}</Notice>}
    {notice && <Notice success>{notice}</Notice>}
    {!connected && <Notice>Conéctate para consultar datos actualizados y registrar cierres.</Notice>}
    {!dashboard && !admin && pending && <Notice>Sincroniza todas las ventas de este equipo antes de cerrar la caja.</Notice>}
    {!boxes?.length && connected && !error && <Empty>{boxes ? "Tu usuario aún no tiene una caja asignada." : "Cargando datos de las cajas…"}</Empty>}
    <div className={dashboard ? "register-grid" : "stack"}>
      {boxes?.map((box) => {
        const live = box.summary;
        const summary = dashboard ? live : box.closure?.summary ?? live;
        return <section className="card stack" key={box.register_no}>
          <div className="section-title"><div><h3>Caja {box.register_no}</h3><p>{box.username ?? "Sin cajera asignada"}</p></div>
            <div className="actions">
              <span className={"pill " + (box.changed ? "warning" : box.closure ? "green" : "")}>{dashboard ? "Ventas del día" : status(box)}</span>
              {!dashboard && box.closure && <Button variant={admin ? "outline" : "default"} disabled={busy}
                onClick={() => void download(box.register_no)}><Download size={17} /> PDF de la caja</Button>}
            </div></div>
          <div className="list-line"><span>Ventas / unidades</span><strong>{count.format(summary.sales)} / {count.format(summary.units)}</strong></div>
          <div className="list-line"><span>Total en USD</span><strong>{money(summary.usd)}</strong></div>
          <div className="list-line"><span>Equivalente en Bs.</span><strong>{equivalent(summary.ves, "VES")}</strong></div>
          <div className="list-line"><span>Equivalente en pesos</span><strong>{equivalent(summary.cop, "COP")}</strong></div>
          {summary.without_rate > 0 && <p className="muted">{summary.without_rate} ventas carecen de una tasa registrada.</p>}
          {!!summary.products.length && <details><summary>Ver productos vendidos</summary>
            {summary.products.map((p) => <div className="list-line" key={p.product_id + p.name}><span>{p.name}</span><strong>{count.format(p.units)}</strong></div>)}
          </details>}
          {!dashboard && <>
            {!admin && !box.closure && !confirm && <p className="muted">El PDF estará disponible en esta tarjeta al confirmar el cierre.</p>}
            {box.closure && <p className="muted">Versión {box.closure.revision} · {displayDate(box.closure.closed_at)} · {box.closure.cashier_name}</p>}
            {box.changed && <Notice>Hay ventas sincronizadas o anulaciones posteriores al cierre. La cajera puede generar una nueva versión.</Notice>}
            <div className="actions">
              {!admin && !readOnly && (!box.closure || box.changed) && !confirm && <Button disabled={pending || op.connection !== "online" || busy}
                onClick={() => setConfirm(true)}>{box.closure ? "Actualizar cierre" : "Cerrar caja"}</Button>}
            </div>
            {confirm && <div className="stack"><p>Confirma el cierre del {day} con {live.sales} ventas y {count.format(live.units)} unidades sincronizadas.</p>
              <div className="actions"><Button disabled={busy || pending || op.connection !== "online"} onClick={() => void close()}>Confirmar cierre</Button>
                <Button variant="outline" disabled={busy} onClick={() => setConfirm(false)}>Cancelar</Button></div></div>}
          </>}
        </section>;
      })}
    </div>
  </>;
}
