import type { ReactNode } from "react";
import { AlertCircle, CheckCircle2, HeartPulse } from "lucide-react";

export function Brand({ compact = false }: { compact?: boolean }) {
  return <div className="brand"><div className="brand-icon"><HeartPulse size={22} /></div><div><strong>Farmacia La Grita</strong>{!compact && <small>CONTROL OPERATIVO</small>}</div></div>;
}
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="field"><span>{label}</span>{children}</label>;
}
export function Notice({ children, success = false }: { children: ReactNode; success?: boolean }) {
  return <div role={success ? "status" : "alert"} className={success ? "notice success" : "notice"}>
    {success ? <CheckCircle2 size={18} /> : <AlertCircle size={18} />}<span>{children}</span></div>;
}
export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}
export function Heading({ label, title, children }: { label: string; title: string; children?: ReactNode }) {
  return <div className="heading"><p className="eyebrow">{label}</p><h1>{title}</h1>{children && <p>{children}</p>}</div>;
}
