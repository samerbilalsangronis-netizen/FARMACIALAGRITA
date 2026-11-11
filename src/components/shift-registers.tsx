"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Download, RefreshCw } from "lucide-react";
import { pharmacyBrand, pharmacyDisplayName } from "@/lib/brand";
import { decimal, displayDate, localDay, money, type Currency } from "@/lib/domain";
import { rpc } from "@/lib/supabase";
import { accessError, type Operation } from "@/lib/use-operation";
import { DailyRegisters, type Summary } from "./registers";
import { Button } from "./ui/button";
import { Empty, Field, Heading, Notice } from "./ui/shared";

type Shift = { id: string; register_no: number; cashier_name: string; business_day: string; started_at: string; ended_at: string | null;
  summary: Summary; closure: { revision: number; closed_at: string; summary: Summary } | null; changed: boolean };
const count = new Intl.NumberFormat("es-VE");
const equivalent = (n: number | string | null, c: Currency) => n === null ? "Sin tasa" : money(n, c);

export function Registers({ op, dashboard = false }: { op: Operation; dashboard?: boolean }) {
  const [supported, setSupported] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (dashboard || op.connection === "offline" || supported !== null) return;
    let live = true;
    void rpc("register_shift_day", { report_day: localDay() }).then((value) => { if (live) setSupported(Array.isArray(value)); }).catch((e) => {
      if (!live) return;
      const message = accessError(e);
      if (/could not find.*function|function.*does not exist|schema cache.*register_shift_day/i.test(message)) setSupported(false);
      else setError(message);
    });
    return () => { live = false; };
  }, [dashboard, op.connection, supported]);
  if (dashboard || supported === false) return <DailyRegisters op={op} dashboard={dashboard} />;
  if (supported === null) return <section className="card stack"><h2>Cierres por turno</h2><p>{op.connection === "offline" ? "Conéctate para consultar o cerrar los turnos. Las ventas del turno preparado pueden continuar sin conexión." : "Comprobando los turnos de caja…"}</p>{error && <Notice>{error}</Notice>}<Button variant="outline" onClick={() => { setError(""); setSupported(null); void rpc("register_shift_day", { report_day: localDay() }).then(() => setSupported(true)).catch((e) => setError(accessError(e))); }}>Reintentar</Button></section>;
  return <ShiftRegisters op={op} />;
}

function ShiftRegisters({ op }: { op: Operation }) {
  const admin = op.profile?.role === "admin";
  const [day, setDay] = useState(localDay);
  const [today, setToday] = useState(localDay);
  const [data, setData] = useState<{ day: string; shifts: Shift[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirm, setConfirm] = useState<string | null>(null);
  const [legacy, setLegacy] = useState(false);
  const openingId = useRef(crypto.randomUUID());
  const mutation = useRef(false);
  const sequence = useRef(0);
  const connected = !op.needsReconnect && op.connection !== "offline";
  const pending = Boolean(op.local?.sales.some((s) => s.receipt.local));
  const shifts = data?.day === day ? data.shifts : [];
  const active = shifts.filter((s) => !s.ended_at);
  const history = shifts.filter((s) => s.business_day === day && s.ended_at);
  const load = useCallback(async () => {
    const request = ++sequence.current;
    try { const shifts = await rpc<Shift[]>("register_shift_day", { report_day: day });
      if (request === sequence.current) { setData({ day, shifts }); setError(""); }
    } catch (e) { if (request === sequence.current) setError(accessError(e)); }
  }, [day]);
  useEffect(() => { if (!connected) return; void load(); const timer = window.setInterval(() => { setToday(localDay()); void load(); }, 30_000); return () => { sequence.current++; clearInterval(timer); }; }, [connected, load]);

  async function change(shift?: string) {
    if (mutation.current || pending || op.connection !== "online") return;
    mutation.current = true; setBusy(true); setError(""); setNotice("");
    try {
      if (shift) { await rpc("close_register_shift", { shift }); await op.invalidateShift(shift); setNotice("Cierre del turno guardado. Ya puedes descargar su PDF."); }
      else { await rpc("open_register_shift", { request_id: openingId.current }); openingId.current = crypto.randomUUID(); setDay(localDay()); setNotice("Turno iniciado. Prepara o actualiza el dispositivo para continuar con las ventas."); }
      setConfirm(null);
      await op.sync(true);
      await load();
    } catch (e) { setError(accessError(e)); }
    finally { mutation.current = false; setBusy(false); }
  }

  async function download(entries: Shift[], individual = false) {
    if (busy || !entries.length) return; setBusy(true); setError("");
    try {
      const [{ createReportPdf }, image] = await Promise.all([import("@/lib/report-pdf"), fetch(pharmacyBrand.logo)]);
      if (!image.ok) throw new Error("No se pudo cargar el logo.");
      const summaries = entries.map((s) => s.closure!.summary);
      const total = (key: "usd" | "ves" | "cop") => summaries.some((s) => s[key] === null) ? null : summaries.reduce((n, s) => n.plus(s[key] ?? 0), new decimal(0)).toFixed(key === "cop" ? 0 : 2);
      const settings = op.catalog?.settings;
      const first = entries[0];
      const report = createReportPdf({
        title: individual ? "Cierre de turno · Caja " + first.register_no : "Cierres de turnos consolidados",
        pharmacy: pharmacyDisplayName(settings?.pharmacy_name), logo: new Uint8Array(await image.arrayBuffer()), rif: pharmacyBrand.rif,
        address: settings?.address, phone: settings?.phone, period: "Fecha de apertura " + first.business_day, issuedAt: displayDate(new Date().toISOString()),
        register: { label: individual ? "CIERRE INDIVIDUAL" : "REPORTE DE ADMINISTRACIÓN", facts: individual ? [
          { label: "CAJERA", value: first.cashier_name }, { label: "INICIO", value: displayDate(first.started_at) }, { label: "FIN", value: displayDate(first.ended_at!) },
        ] : [{ label: "TURNOS CERRADOS", value: String(entries.length) }, { label: "CAJAS INCLUIDAS", value: String(new Set(entries.map((s) => s.register_no)).size) + " de 3" }, { label: "VENTAS", value: count.format(summaries.reduce((n,s) => n+s.sales,0)) }] },
        coverage: "Cada turno se incluye una sola vez y pertenece a su fecha de apertura, aunque termine al día siguiente. Equivalentes a la tasa de cada venta. Productos antes de descuentos. " +
          (entries.some((s) => s.changed) ? "Hay movimientos posteriores pendientes de incorporar en alguno de los cierres. " : "") +
          (!individual && active.some((s) => s.business_day === day) ? "Hay turnos abiertos excluidos de este consolidado." : ""),
        summaryTitle: "Total de los turnos cerrados incluidos",
        indicators: [{ label: "VENTAS EN USD", value: equivalent(total("usd"),"USD") }, { label: "EQUIVALENTE EN BS.", value: equivalent(total("ves"),"VES") }, { label: "EQUIVALENTE EN COP", value: equivalent(total("cop"),"COP") }],
        sections: entries.flatMap((s) => {
          const summary = s.closure!.summary;
          const prefix = "Caja " + s.register_no + " · " + displayDate(s.started_at);
          return [{ title: prefix, columns: [{ label: "Cajera / fin / versión", width: 70 }, { label: "Ventas / unidades", width: 40 }, { label: "Total USD", width: 36 }, { label: "Descuento", width: 32 }],
            rows: [[s.cashier_name + " / " + displayDate(s.ended_at!) + " / v" + s.closure!.revision, summary.sales + " / " + summary.units, money(summary.usd), money(summary.discounts)]] },
            { title: "Productos del turno", columns: [{ label: "Producto", width: 96 }, { label: "Unidades", width: 28 }, { label: "Subtotal USD", width: 54 }], rows: summary.products.map((p) => [p.name, count.format(p.units), money(p.subtotal)]) },
            { title: "Cobros netos del turno", columns: [{ label: "Método", width: 78 }, { label: "Moneda", width: 32 }, { label: "Importe", width: 68 }], rows: summary.payments.map((p) => [op.catalog?.methods.find((m) => m.code === p.method)?.label ?? p.method, p.currency, money(p.net,p.currency)]) }];
        }),
      });
      report.save("cierre-turnos-" + first.business_day + (individual ? "-caja-" + first.register_no + "-" + first.id.slice(0,8) : "-consolidado") + ".pdf");
    } catch (e) { setError(accessError(e)); } finally { setBusy(false); }
  }
  function card(s: Shift) {
    const summary = s.closure?.summary ?? s.summary;
    return <section className="card stack" key={s.id}>
      <div className="section-title"><div><h3>Caja {s.register_no} · {s.cashier_name}</h3><p>Inicio: {displayDate(s.started_at)}</p><p>{s.ended_at ? "Fin: " + displayDate(s.ended_at) : "Continúa abierto, incluso después de medianoche."}</p></div><span className={"pill " + (s.changed ? "warning" : "green")}>{s.ended_at ? s.changed ? "Cierre por actualizar" : "Turno cerrado" : "Turno abierto"}</span></div>
      <div className="list-line"><span>Ventas / unidades</span><strong>{count.format(summary.sales)} / {count.format(summary.units)}</strong></div>
      <div className="list-line"><span>Total en USD</span><strong>{money(summary.usd)}</strong></div>
      <div className="list-line"><span>Equivalente en Bs.</span><strong>{equivalent(summary.ves,"VES")}</strong></div>
      <div className="list-line"><span>Equivalente en COP</span><strong>{equivalent(summary.cop,"COP")}</strong></div>
      {s.changed && <Notice>Se sincronizaron ventas o anulaciones después del cierre. La cajera puede actualizarlo sin duplicar el turno.</Notice>}
      <div className="actions">
        {s.closure && <Button variant="outline" disabled={busy} onClick={() => void download([s],true)}><Download size={17} /> PDF del turno</Button>}
        {!admin && (!s.ended_at || s.changed) && <Button disabled={busy || pending || op.connection !== "online"} onClick={() => setConfirm(s.id)}>{s.ended_at ? "Actualizar cierre" : "Cerrar turno"}</Button>}
      </div>
      {s.closure && <small>Versión {s.closure.revision} · {displayDate(s.closure.closed_at)}</small>}
      {confirm === s.id && <div className="stack"><p>¿Confirmar {s.ended_at ? "la actualización de este cierre" : "el cierre de este turno"}? Incluye {s.summary.sales} ventas sincronizadas. Luego podrás iniciar otro turno.</p><div className="actions"><Button disabled={busy || pending || op.connection !== "online"} onClick={() => void change(s.id)}>Confirmar cierre</Button><Button variant="ghost" disabled={busy} onClick={() => setConfirm(null)}>Cancelar</Button></div></div>}
    </section>;
  }
  return <>
    <Heading label="CONTROL DE CAJAS" title="Cierres por turno">Puedes abrir y cerrar varios turnos al día. Los turnos nocturnos mantienen la fecha de apertura hasta su cierre.</Heading>
    {error && <Notice>{error}</Notice>}{notice && <Notice success>{notice}</Notice>}
    {!connected && <Notice>Conéctate para consultar, iniciar o cerrar turnos. Las ventas pueden continuar con el turno preparado en este dispositivo.</Notice>}
    {pending && <Notice>Sincroniza las ventas pendientes de este dispositivo antes de iniciar o cerrar un turno. Revisa también otros equipos que usen esta misma caja.</Notice>}
    <div className="toolbar"><Field label="Fecha de apertura"><input type="date" value={day} max={today} onChange={(e) => { if(e.target.value) { setDay(e.target.value); setConfirm(null); } }} /></Field><Button variant="outline" disabled={!connected || busy} onClick={() => void load()}><RefreshCw size={17} /> Actualizar</Button>
      {admin && <Button disabled={!connected || busy || !history.length} onClick={() => void download(history)}><Download size={17} /> PDF consolidado de turnos</Button>}
      {!admin && data?.day === day && !active.length && <Button disabled={busy || pending || op.connection !== "online"} onClick={() => void change()}>Iniciar turno</Button>}
    </div>
    {active.length > 0 && <><h2>Turnos abiertos</h2><div className="register-grid">{active.map(card)}</div></>}
    <h2>Historial de turnos · {day}</h2>
    {history.length ? <div className="register-grid">{history.map(card)}</div> : <Empty>No hay turnos cerrados con esta fecha de apertura.</Empty>}
    <Button variant="ghost" onClick={() => setLegacy(!legacy)}>{legacy ? "Ocultar historial anterior" : "Consultar cierres diarios anteriores al cambio"}</Button>
    {legacy && <DailyRegisters op={op} readOnly />}
  </>;
}
