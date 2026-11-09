"use client";
import { pharmacyDisplayName } from "@/lib/brand";
import { useState, type FormEvent } from "react";
import { amountPattern, decimal, displayDate, money, normalize, type Customer, type Profile } from "@/lib/domain";
import { rpc, supabase } from "@/lib/supabase";
import { accessError, type Operation } from "@/lib/use-operation";
import { Button } from "./ui/button";
import { Empty, Field, Heading, Notice } from "./ui/shared";

export function Settings({ op }: { op: Operation }) {
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [busy, setBusy] = useState(false);
  const [users, setUsers] = useState<(Profile & { active: boolean })[] | null>(null);
  const [methods, setMethods] = useState<{ code: string; label: string; active: boolean }[] | null>(null);
  const [rates, setRates] = useState<{ id: string; ves: number; cop: number; created_at: string; note: string }[] | null>(null);
  const settings = op.catalog?.settings;

  async function save(event: FormEvent<HTMLFormElement>, action: (data: FormData) => Promise<void>, message: string) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError(""); setSuccess("");
    try { await action(new FormData(event.currentTarget)); setSuccess(message); }
    catch (error) { setError(accessError(error)); }
    finally { setBusy(false); }
  }

  async function load() {
    setError("");
    try {
      const client = supabase();
      const [profiles, paymentMethods, exchangeRates] = await Promise.all([
        client.from("profiles").select("id,username,role,active").order("username").limit(500),
        client.from("payment_methods").select("code,label,active").order("label"),
        client.from("exchange_rates").select("id,ves,cop,note,created_at").order("created_at", { ascending: false }).limit(100),
      ]);
      if (profiles.error || paymentMethods.error || exchangeRates.error) throw new Error(profiles.error?.message ?? paymentMethods.error?.message ?? exchangeRates.error?.message);
      setUsers(profiles.data as (Profile & { active: boolean })[]); setMethods(paymentMethods.data); setRates(exchangeRates.data);
    } catch (error) { setError(accessError(error)); }
  }
  return <>
    <Heading label="ADMINISTRACIÓN" title="Configuración">Gestiona las tasas, los métodos de pago y las reglas de operación.</Heading>
    {op.connection === "offline" && <Notice>Conéctate al servidor para modificar la configuración.</Notice>}
    {error && <Notice>{error}</Notice>}{success && <Notice success>{success}</Notice>}
    <div className="split">
      <section className="card stack">
        <h2>Tasas de cambio</h2>
        {op.catalog?.rate ? <p>1 USD = {op.catalog.rate.ves} VES · {op.catalog.rate.cop} COP<br /><small>Vigente desde {displayDate(op.catalog.rate.created_at)}</small></p> : <p className="muted">Aún no hay tasas configuradas.</p>}
        <form className="stack" onSubmit={(event) => void save(event, async (data) => {
          const ves = String(data.get("ves")).replace(",", ".");
          const cop = String(data.get("cop")).replace(",", ".");
          if (![ves, cop].every((value) => amountPattern.test(value) && new decimal(value).gt(0))) throw new Error("Ingresa tasas positivas, con hasta 6 decimales.");
          await rpc("set_rate", { ves_per_usd: ves, cop_per_usd: cop, note: String(data.get("note") ?? "") });
          await op.sync(true);
          if (rates) await load();
        }, "Nueva tasa registrada.")}>
          <div className="form-grid"><Field label="VES por USD"><input name="ves" inputMode="decimal" required /></Field>
            <Field label="COP por USD"><input name="cop" inputMode="decimal" required /></Field></div>
          <Field label="Observaciones"><input name="note" maxLength={500} /></Field>
          <div><Button type="submit" disabled={busy || op.connection === "offline"}>Guardar tasas</Button></div>
        </form>
      </section>
      {settings && <section className="card stack">
        <h2>Farmacia y acceso</h2>
        <form className="stack" onSubmit={(event) => void save(event, async (data) => {
          await rpc("save_settings", { data: Object.fromEntries(data) });
          await op.sync(true);
        }, "Configuración guardada.")}>
          <Field label="Nombre de la farmacia"><input name="pharmacy_name" defaultValue={pharmacyDisplayName(settings.pharmacy_name)} maxLength={120} required /></Field>
          <div className="form-grid">
            <Field label="Dirección"><input name="address" defaultValue={settings.address} maxLength={220} /></Field>
            <Field label="Teléfono"><input name="phone" defaultValue={settings.phone} maxLength={40} /></Field>
            <Field label="Vigencia del acceso offline en horas"><input name="offline_hours" type="number" min="1" max="72" defaultValue={settings.offline_hours} required /></Field>
            <Field label="Antigüedad máxima de la tasa en horas"><input name="rate_hours" type="number" min="1" max="168" defaultValue={settings.rate_hours} required /></Field>
          </div>
          <Field label="Si la tasa está vencida"><select name="stale_policy" defaultValue={settings.stale_policy}><option value="confirm">Solicitar confirmación</option><option value="block">Bloquear cobro en VES o COP</option></select></Field>
          <div><Button type="submit" disabled={busy || op.connection === "offline"}>Guardar configuración</Button></div>
        </form>
      </section>}
    </div>
    <section className="card stack">
      <div className="section-title"><div><h2>Usuarios, medios de pago e historial de tasas</h2><p>Consulta la configuración actual del servidor.</p></div>
        <Button variant="outline" disabled={op.connection === "offline"} onClick={() => void load()}>{users ? "Actualizar" : "Cargar configuración"}</Button></div>
      {users && <><h3>Usuarios</h3><p className="muted">Las nuevas cuentas se crean en Supabase Auth. Aquí puedes cambiar el rol o desactivar una cuenta registrada.</p>
        {users.map((p) => <form className="toolbar inline-setting" key={p.id} onSubmit={(event) => void save(event, async (data) => {
          await rpc("manage_profile", { profile: p.id, new_role: data.get("role"), enabled: data.get("enabled") === "on" });
          await load();
        }, "Cuenta actualizada.")}>
          <strong>{p.username}</strong>
          <select name="role" aria-label={"Rol de " + p.username} defaultValue={p.role} disabled={p.id === op.profile?.id}><option value="cashier">Cajero</option><option value="admin">Administrador</option></select>
          <label className="checkline"><input type="checkbox" name="enabled" defaultChecked={p.active} disabled={p.id === op.profile?.id} /> Activo</label>
          <Button type="submit" variant="outline" disabled={busy || p.id === op.profile?.id}>Guardar</Button>
        </form>)}
      </>}
      {methods && <><h3>Métodos de pago</h3>
        {[...methods, { code: "", label: "", active: true }].map((method) => <form className="toolbar inline-setting" key={method.code || "new"} onSubmit={(event) => void save(event, async (data) => {
          await rpc("save_payment_method", { method_code: String(data.get("code")).trim().toLowerCase(), method_label: String(data.get("label")), enabled: data.get("enabled") === "on" });
          await load(); await op.sync(true);
        }, "Método de pago guardado.")}>
          <input name="code" aria-label="Código del método" placeholder="Código nuevo" defaultValue={method.code} readOnly={Boolean(method.code)} required maxLength={32} />
          <input name="label" aria-label="Nombre del método" placeholder="Nombre visible" defaultValue={method.label} required maxLength={80} />
          <label className="checkline"><input type="checkbox" name="enabled" defaultChecked={method.active} /> Activo</label>
          <Button type="submit" variant="outline" disabled={busy}>{method.code ? "Guardar" : "Añadir método"}</Button>
        </form>)}
      </>}
      {rates && <><h3>Historial de tasas</h3>
        {rates.length ? <div className="table-scroll"><table><thead><tr><th>Fecha</th><th>VES por USD</th><th>COP por USD</th><th>Observaciones</th></tr></thead>
          <tbody>{rates.map((rate) => <tr key={rate.id}><td>{displayDate(rate.created_at)}</td><td>{rate.ves}</td><td>{rate.cop}</td><td>{rate.note}</td></tr>)}</tbody></table></div> : <Empty>Sin tasas registradas.</Empty>}</>}
    </section>
  </>;
}

export function Customers({ op }: { op: Operation }) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Customer | null>(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [busy, setBusy] = useState(false);
  const purchases = selected ? op.receipts.filter((receipt) => receipt.customer_id === selected.id) : [];
  const matches = op.customers.filter((c) => normalize(c.name + " " + c.document).includes(normalize(query.trim())));
  return <>
    <Heading label="OPERACIÓN" title="Clientes">Registra los datos básicos de un cliente cuando la venta lo requiera.</Heading>
    {error && <Notice>{error}</Notice>}{success && <Notice success>{success}</Notice>}
    {op.connection === "offline" && <Notice>Puedes consultar y registrar clientes en un dispositivo preparado. Los registros pendientes se envían al reconectar.</Notice>}
    <section className="card stack"><h2>Registrar cliente</h2>
      <form className="stack" onSubmit={async (event) => {
        event.preventDefault();
        if (busy) return;
        const form = event.currentTarget;
        setBusy(true); setError(""); setSuccess("");
        try {
          await op.registerCustomer(new FormData(form));
          form.reset(); setSuccess("Cliente guardado.");
        } catch (error) { setError(accessError(error)); } finally { setBusy(false); }
      }}>
        <div className="form-grid">
          <Field label="Nombre completo"><input name="name" required maxLength={160} /></Field>
          <Field label="Cédula o documento"><input name="document" required maxLength={40} /></Field>
          <Field label="Teléfono (opcional)"><input name="phone" type="tel" maxLength={40} /></Field>
          <Field label="Observaciones (opcional)"><input name="notes" maxLength={400} /></Field>
        </div>
        <div><Button type="submit" disabled={busy || (op.connection === "offline" && !op.local)}>Guardar cliente</Button></div>
      </form>
    </section>
    <section className="card stack"><div className="section-title"><h2>Clientes registrados</h2>
      <Button variant="outline" disabled={op.connection === "offline"} onClick={() => void op.sync()}>Actualizar</Button></div>
      <Field label="Buscar por nombre o cédula"><input value={query} onChange={(e) => setQuery(e.target.value)} /></Field>
        {matches?.length ? <div className="table-scroll"><table><thead><tr><th>Nombre</th><th>Documento</th><th>Teléfono</th><th></th></tr></thead>
          <tbody>{matches.map((c) => <tr key={c.id}><td>{c.name}</td><td>{c.document}</td><td>{c.phone}</td><td><Button variant="ghost" onClick={() => setSelected(c)}>Ver historial</Button></td></tr>)}</tbody></table></div>
          : <Empty>Sin clientes para esta búsqueda.</Empty>}
      {selected && <div className="stack"><h3>Compras de {selected.name}</h3>
        {purchases.length ? purchases.map((receipt) => <div className="list-line" key={receipt.id}>
          <span>{displayDate(receipt.occurred_at)} · {receipt.sale_items.map((item) => item.name).join(", ")}</span><strong>{money(receipt.total)}</strong>
        </div>) : <Empty>Sin compras en el historial cargado.</Empty>}
        {op.historyTruncated && <p className="muted">Carga más operaciones desde Historial de ventas para ampliar la consulta.</p>}
        <Button variant="ghost" onClick={() => setSelected(null)}>Cerrar</Button></div>}
    </section>
  </>;
}
