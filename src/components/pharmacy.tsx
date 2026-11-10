"use client";
import { useEffect, useState } from "react";
import { pharmacyBrand } from "@/lib/brand";
import { motion, useReducedMotion } from "framer-motion";
import { Activity, ArrowDownToLine, ArrowRight, BarChart3, ClipboardCheck, Clock3, CloudOff, HeartPulse, History, LayoutGrid, LockKeyhole, Menu, Package, RefreshCw, Settings2, ShieldCheck, ShoppingCart, Users, Wifi, X } from "lucide-react";
import { useForm } from "react-hook-form";
import { displayDate, localDay, money, type Receipt } from "@/lib/domain";
import { accessError, useOperation, type Operation } from "@/lib/use-operation";
import { Inventory } from "./inventory";
import { Sales } from "./sales";
import { ReceiptView, Records, Reports, summarize } from "./records";
import { Customers, Settings } from "./admin";
import { Registers } from "./registers";
import { Button } from "./ui/button";
import { Brand, Field, Heading, Notice } from "./ui/shared";

const nav = [
  { id: "dashboard", label: "Resumen", icon: LayoutGrid, admin: false },
  { id: "sales", label: "Punto de venta", icon: ShoppingCart, admin: false },
  { id: "inventory", label: "Inventario", icon: Package, admin: false },
  { id: "history", label: "Historial de ventas", icon: History, admin: false },
  { id: "customers", label: "Clientes", icon: Users, admin: false },
  { id: "fiscal", label: "Pendientes fiscales", icon: ClipboardCheck, admin: true },
  { id: "registers", label: "Cierres diarios", icon: ClipboardCheck, admin: false },
  { id: "reports", label: "Reportes", icon: BarChart3, admin: true },
  { id: "settings", label: "Configuración", icon: Settings2, admin: true },
] as const;
type View = typeof nav[number]["id"];

export function Pharmacy() {
  const op = useOperation();
  const [view, setView] = useState<View>("dashboard");
  const [menu, setMenu] = useState(false);
  const [device, setDevice] = useState(false);
  const [reconnect, setReconnect] = useState(false);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [installPrompt, setInstallPrompt] = useState<(Event & { prompt(): Promise<void> }) | null>(null);
  const reduce = useReducedMotion();
  useEffect(() => {
    const handler = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as Event & { prompt(): Promise<void> });
    };
    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);
  if (!op.profile) return <Login op={op} />;

  const current = nav.find((link) => link.id === view && (!link.admin || op.profile?.role === "admin"))?.id ?? "dashboard";
  const heading = nav.find((link) => link.id === current)?.label;
  const pending = op.local?.sales.filter(({ receipt }) => receipt.local).length ?? 0;
  const connection = { online: "En línea", offline: "Sin conexión", syncing: "Sincronizando", error: "Revisar sincronización" }[op.connection];
  const change = (next: View) => { setView(next); setMenu(false); };
  function openDeviceSetup() {
    setDevice(true);
    requestAnimationFrame(() => document.getElementById("device-passphrase")?.focus());
  }
  return <div className="app-shell">
    {menu && <button className="sidebar-backdrop" aria-label="Cerrar menú" onClick={() => setMenu(false)} />}
    <aside className={"sidebar" + (menu ? " sidebar-open" : "")}>
      <div className="sidebar-brand"><Brand /><Button aria-label="Cerrar menú" className="mobile-only icon-button" variant="ghost" onClick={() => setMenu(false)}><X size={20} /></Button></div>
      <nav aria-label="Módulos" className="nav-links">
        <span className="nav-heading">ESPACIO DE TRABAJO</span>
        {nav.filter((link) => !link.admin || op.profile?.role === "admin").map(({ id, label, icon: Icon }) =>
          <button key={id} className={current === id ? "nav-active" : ""} aria-current={current === id ? "page" : undefined} onClick={() => change(id)}>
            <Icon size={19} /> {label}
          </button>)}
      </nav>
      <div className="sidebar-bottom">
        <div className="sidebar-ready"><ShieldCheck size={20} /><div><b>{op.local && op.workerReady ? "Dispositivo preparado" : op.local ? "Preparando acceso sin conexión" : op.prepared ? "Dispositivo bloqueado" : "Dispositivo sin preparar"}</b><small>{op.local && op.workerReady ? "La app puede abrirse sin red." : "Prepara el acceso con internet."}</small></div></div>
        <div className="sidebar-user"><div className="avatar">{op.profile.username.slice(0, 2).toUpperCase()}</div><div><strong>{op.profile.username}</strong><small>{op.profile.role === "admin" ? "Administrador" : "Cajero"}</small></div>
          <Button variant="ghost" className="icon-button" aria-label="Bloquear sesión" title="Bloquear sesión" onClick={() => {
            setReceipt(null); setView("dashboard"); setDevice(false); setReconnect(false); void op.lock();
          }}><LockKeyhole size={17} /></Button></div>
      </div>
    </aside>
    <div className="workspace">
      <header className="topbar">
        <div className="breadcrumb"><Button variant="ghost" className="mobile-only icon-button" aria-label="Abrir menú" onClick={() => setMenu(true)}><Menu size={21} /></Button><span>Espacio de trabajo</span><b>{heading}</b></div>
        <div className="header-actions">
          <span className={"connection " + op.connection} role="status">{op.connection === "offline" ? <CloudOff size={16} /> :
            op.connection === "syncing" ? <RefreshCw size={16} className="spin" /> : <Wifi size={16} />}{connection}</span>
          {op.needsReconnect ? <Button variant="outline" onClick={() => setReconnect(!reconnect)}>Reconectar</Button> :
            !op.local ? <Button variant="outline" onClick={() => setDevice(!device)}>{op.prepared ? "Desbloquear dispositivo" : "Preparar dispositivo"}</Button> :
              <Button variant="ghost" className="icon-button" aria-label="Actualizar y sincronizar" title="Actualizar y sincronizar" onClick={() => void op.sync(true)}><RefreshCw size={18} /></Button>}
        </div>
      </header>
      <main className="content">
        {device && !op.local && !op.needsReconnect && <DeviceSetup op={op} />}
        {reconnect && op.needsReconnect && <Reconnect op={op} close={() => setReconnect(false)} />}
        {op.local && !op.workerReady && <Notice>El navegador aún no confirmó la caché de la aplicación. Mantén la página abierta con internet hasta que el dispositivo indique que está preparado.</Notice>}
        {installPrompt && op.workerReady && <div className="install-banner"><span><ShieldCheck size={18} /> Instala el acceso directo en este dispositivo.</span>
          <Button variant="outline" onClick={() => { void installPrompt.prompt(); setInstallPrompt(null); }}><ArrowDownToLine size={17} /> Instalar</Button></div>}
        {pending > 0 && <Notice>{pending} {pending === 1 ? "venta pendiente de sincronizar" : "ventas pendientes de sincronizar"}. Conserva los datos de este navegador hasta completar el envío.</Notice>}
        {op.syncProblem && <Notice>{op.syncProblem}</Notice>}
        <motion.div key={current} className="view" initial={reduce ? false : { opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18 }}>
          {current === "dashboard" && <Dashboard op={op} open={change} />}
          {current === "sales" && <Sales op={op} onReceipt={setReceipt} onPrepareDevice={openDeviceSetup} />}
          {current === "inventory" && <Inventory op={op} />}
          {current === "history" && <Records op={op} onReceipt={setReceipt} />}
          {current === "customers" && <Customers op={op} />}
          {current === "fiscal" && <Records op={op} fiscal onReceipt={setReceipt} />}
          {current === "registers" && <Registers op={op} />}
          {current === "reports" && <Reports op={op} />}
          {current === "settings" && <Settings op={op} />}
        </motion.div>
      </main>
    </div>
    {receipt && <ReceiptView receipt={op.receipts.find((r) => r.id === receipt.id) ?? receipt} catalog={op.catalog} close={() => setReceipt(null)} />}
  </div>;
}

function Login({ op }: { op: Operation }) {
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState("");
  const { register, handleSubmit, resetField, formState } = useForm<{ username: string; password: string }>();
  const submit = handleSubmit(async ({ username, password }) => {
    setError("");
    try { await op.login(username.trim().toLowerCase(), password, offline); }
    catch (error) { setError(accessError(error)); }
  });
  return <main className="login-shell">
    <div className="login-left">
      <Brand />
      <div className="login-card">
        <p className="eyebrow">ACCESO DEL PERSONAL</p>
        <h1>{offline ? "Acceso sin conexión" : "Iniciar sesión"}</h1>
        <p>{offline ? "Desbloquea un dispositivo que ya preparaste con internet." : "Ingresa para gestionar las ventas y el inventario de la farmacia."}</p>
        {error && <Notice>{error}</Notice>}
        <form className="stack" onSubmit={submit}>
          <Field label="Nombre de usuario"><input autoComplete="username" autoCapitalize="none" spellCheck={false} placeholder="Tu nombre de usuario" required maxLength={32} {...register("username")} /></Field>
          <Field label={offline ? "Clave del dispositivo" : "Contraseña"}><input type="password" autoComplete={offline ? "off" : "current-password"} placeholder={offline ? "Tu clave local" : "Tu contraseña"} required maxLength={128} {...register("password")} /></Field>
          <Button type="submit" className="full" disabled={formState.isSubmitting}>{formState.isSubmitting ? "Verificando…" : offline ? "Desbloquear" : "Ingresar"}<ArrowRight size={18} /></Button>
        </form>
        <button className="access-toggle" type="button" onClick={() => { setOffline(!offline); setError(""); resetField("password"); }}>
          {offline ? <Wifi size={17} /> : <CloudOff size={17} />}{offline ? "Volver al acceso con internet" : "Acceder sin conexión"}
        </button>
      </div>
      <div className="login-foot">La Grita, Táchira <span>·</span> Acceso interno</div>
    </div>
    <aside className="login-side" aria-label="Sobre el sistema">
      <div className="grid-overlay" aria-hidden="true" />
      <div className="login-aside-inner">
        <div className="login-emblem"><HeartPulse size={46} strokeWidth={1.5} /></div>
        <p className="eyebrow">{pharmacyBrand.name.toUpperCase()}</p>
        <h2>Ventas e inventario durante un apagón</h2>
        <p>Registra ventas y conserva tus comprobantes en un dispositivo preparado. Sincroniza al volver la conexión.</p>
        <div className="login-tags"><span><CloudOff size={16} /> Acceso sin conexión</span><span><ShieldCheck size={16} /> Control interno</span></div>
      </div>
    </aside>
  </main>;
}

function DeviceSetup({ op }: { op: Operation }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return <section className="card stack">
    <h2>{op.prepared ? "Desbloquear dispositivo" : "Preparar este dispositivo"}</h2>
    <p className="muted">{op.prepared ? "Escribe la clave local para recuperar el catálogo y las ventas pendientes." :
      "Crea una clave distinta de tu contraseña de usuario. Se usa para cifrar y abrir tus ventas y el catálogo sin conexión."}</p>
    {error && <Notice>{error}</Notice>}
    <form className="form-grid" onSubmit={async (event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      const passphrase = String(data.get("phrase"));
      if (!op.prepared && passphrase !== data.get("confirm")) { setError("Las claves deben coincidir."); return; }
      setBusy(true); setError("");
      try { await op.prepare(passphrase); } catch (error) { setError(accessError(error)); } finally { setBusy(false); }
    }}>
      <Field label="Clave del dispositivo"><input id="device-passphrase" name="phrase" type="password" autoComplete={op.prepared ? "off" : "new-password"} required minLength={12} maxLength={128} /></Field>
      {!op.prepared && <Field label="Confirmar clave"><input name="confirm" type="password" autoComplete="new-password" required minLength={12} maxLength={128} /></Field>}
      <div><Button type="submit" disabled={busy}>{busy ? "Preparando…" : op.prepared ? "Desbloquear" : "Autorizar dispositivo"}</Button></div>
    </form>
  </section>;
}

function Reconnect({ op, close }: { op: Operation; close: () => void }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return <section className="card stack">
    <h2>Volver a conectar</h2>
    <p>Inicia sesión como {op.profile?.username} para enviar las ventas guardadas.</p>
    {error && <Notice>{error}</Notice>}
    <form className="toolbar" onSubmit={async (event) => {
      event.preventDefault();
      setBusy(true); setError("");
      try { await op.login(op.profile!.username, String(new FormData(event.currentTarget).get("password")), false); close(); }
      catch (error) { setError(accessError(error)); } finally { setBusy(false); }
    }}>
      <Field label="Contraseña de usuario"><input name="password" type="password" autoComplete="current-password" required /></Field>
      <Button type="submit" disabled={busy}>{busy ? "Conectando…" : "Ingresar y sincronizar"}</Button>
    </form>
  </section>;
}

function Dashboard({ op, open }: { op: Operation; open: (page: View) => void }) {
  const today = summarize(op.receipts.filter((receipt) => localDay(receipt.occurred_at) === localDay()));
  const all = summarize(op.receipts);
  const products = op.catalog?.products ?? [];
  const low = products.filter((p) => p.active && p.stock <= p.min_stock);
  const transferred = all.rows.filter((r) => r.fiscal_status === "transferred").length;
  const admin = op.profile?.role === "admin";
  const tiles = [
    { name: "Ventas de hoy", value: today.rows.length, detail: "Operaciones registradas", icon: ShoppingCart, tone: "green" },
    { name: "Total vendido", value: money(today.total.toFixed(2)), detail: "USD de referencia hoy", icon: Activity, tone: "green" },
    { name: "Bajo inventario", value: low.length, detail: "En el mínimo o por debajo", icon: Package, tone: "amber" },
    { name: "Por sincronizar", value: all.localCount, detail: "Guardadas en este dispositivo", icon: CloudOff, tone: "blue" },
  ];
  return <>
    <Heading label="PANEL OPERATIVO" title="Resumen de la farmacia">Consulta las ventas de hoy, las alertas de inventario y el estado de la operación.</Heading>
    <section className="welcome">
      <div><p className="eyebrow">VENTAS E INVENTARIO</p><h2>Registra una venta</h2><p>Agrega medicamentos, registra el pago y emite un comprobante interno.</p></div>
      <Button onClick={() => open("sales")}><ShoppingCart size={19} /> Abrir punto de venta <ArrowRight size={17} /></Button>
    </section>
    <div className="stats-grid dashboard-stats">{tiles.map(({ name, value, detail, icon: Icon, tone }) =>
      <section className="card stat" key={name}><div className="stat-top"><span>{name}</span><div className={"stat-icon " + tone}><Icon size={19} /></div></div>
        <strong>{value}</strong><small>{detail}</small></section>)}</div>
    {admin && <Registers op={op} dashboard />}
    {op.historyTruncated && <Notice>El resumen usa el historial cargado. Las ventas más antiguas pueden consultarse desde Historial de ventas.</Notice>}
    <div className="split">
      <section className="card stack"><div className="section-title"><div><h2>Cobros de hoy</h2><p>Importe neto por moneda</p></div><Activity size={21} /></div>
        {today.amounts.map(({ currency, total }) => <div className="list-line" key={currency}><span>{currency}</span><strong>{money(total.toFixed(currency === "COP" ? 0 : 2), currency)}</strong></div>)}
      </section>
      <section className="card stack"><div className="section-title"><div><h2>Control de operaciones</h2><p>Ventas disponibles en esta sesión</p></div><ClipboardCheck size={21} /></div>
        <div className="list-line"><span>Pendientes fiscales</span><strong>{all.fiscalCount}</strong></div>
        <div className="list-line"><span>Trasladadas al sistema fiscal</span><strong>{transferred}</strong></div>
        <div className="list-line"><span>Última sincronización exitosa</span><strong>{op.local?.lastSync ? displayDate(op.local.lastSync) : "—"}</strong></div>
        {admin && <div><Button variant="ghost" onClick={() => open("fiscal")}>Ver pendientes fiscales <ArrowRight size={16} /></Button></div>}
      </section>
      <section className="card stack"><div className="section-title"><div><h2>Operación durante apagones</h2><p>Estado de la preparación del dispositivo</p></div><Clock3 size={21} /></div>
        <div className="list-line"><span>Autorización local</span><strong>{op.local ? displayDate(op.local.grant.expires_at) : "Por preparar"}</strong></div>
        <div className="list-line"><span>Apertura sin conexión</span><strong>{op.workerReady ? "Caché lista" : "Por verificar"}</strong></div>
      </section>
    </div>
  </>;
}
