import type { ReactNode } from "react";
import { AlertCircle, CheckCircle2 } from "lucide-react";
import { pharmacyBrand } from "@/lib/brand";

export function Brand() {
  return <div className="brand">
    <img src={pharmacyBrand.logo} alt={pharmacyBrand.name} width={1280} height={539} />
    <small>CONTROL OPERATIVO</small>
  </div>;
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
