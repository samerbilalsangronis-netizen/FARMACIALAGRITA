"use client";
import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { displayDate, money, type Receipt } from "@/lib/domain";
import { accessError, type Operation } from "@/lib/use-operation";
import { Button } from "./ui/button";
import { Field, Notice } from "./ui/shared";

export function CancelSale({ op, receipt, close, done }: { op: Operation; receipt: Receipt; close: () => void; done: () => void }) {
  const [reason, setReason] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const reasonInput = useRef<HTMLTextAreaElement>(null);
  const admin = op.profile?.role === "admin";
  useEffect(() => { reasonInput.current?.focus(); }, []);
  return <div className="receipt-overlay"><section role="dialog" aria-modal="true" aria-labelledby="cancel-sale-title" className="receipt-dialog cancel-dialog">
    <div className="section-title"><h2 id="cancel-sale-title">Anular factura</h2><Button variant="ghost" className="icon-button" aria-label="Cerrar anulación" disabled={busy} onClick={close}><X size={20} /></Button></div>
    <p><strong>{receipt.id.slice(0,8)} · {money(receipt.total)}</strong><br />{displayDate(receipt.occurred_at)} · {receipt.cashier_name}</p>
    <p>Se comprobará si la operación ya llegó al servidor. La anulación conserva el comprobante y su motivo en el historial, y evita que vuelva a enviarse como venta.</p>
    {error && <Notice>{error}</Notice>}
    <form className="stack" onSubmit={async e => {
      e.preventDefault(); if (busy) return; setBusy(true); setError("");
      try { await op.cancelSale(receipt, reason, admin ? undefined : { username:username.trim().toLowerCase(), password }); done(); }
      catch (error) { setError(accessError(error)); }
      finally { setBusy(false); setPassword(""); }
    }}>
      <Field label="Motivo de anulación"><textarea ref={reasonInput} required minLength={3} maxLength={500} value={reason} onChange={e=>setReason(e.target.value)} disabled={busy} /></Field>
      {!admin && <fieldset className="stack admin-approval"><legend>Autorización de la administradora</legend><small>Autoriza esta operación sin cerrar la sesión de la cajera.</small>
        <Field label="Usuario administrador"><input autoComplete="username" required value={username} onChange={e=>setUsername(e.target.value)} disabled={busy} /></Field>
        <Field label="Contraseña de la administradora"><input type="password" autoComplete="off" required value={password} onChange={e=>setPassword(e.target.value)} disabled={busy} /></Field>
      </fieldset>}
      <div className="actions"><Button type="submit" variant="danger" disabled={busy || reason.trim().length<3}>{busy ? "Verificando y anulando…" : "Confirmar anulación"}</Button><Button variant="outline" disabled={busy} onClick={close}>Volver</Button></div>
    </form>
  </section></div>;
}
