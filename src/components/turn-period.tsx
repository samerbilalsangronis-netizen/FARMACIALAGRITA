import { LogIn, LogOut } from "lucide-react";

const date = new Intl.DateTimeFormat("es-VE", { day: "2-digit", month: "short", year: "numeric", timeZone: "America/Caracas" });
const hour = new Intl.DateTimeFormat("es-VE", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "America/Caracas" });

export function TurnPeriod({ startedAt, endedAt }: { startedAt: string; endedAt: string | null }) {
  return <dl className="turn-period" aria-label="Horario del turno">
    <div><dt><LogIn size={14} aria-hidden="true" /> Inicio</dt><dd><time dateTime={startedAt}><strong>{date.format(new Date(startedAt))}</strong><span>{hour.format(new Date(startedAt))}</span></time></dd></div>
    <div><dt><LogOut size={14} aria-hidden="true" /> Cierre</dt><dd>{endedAt ? <time dateTime={endedAt}><strong>{date.format(new Date(endedAt))}</strong><span>{hour.format(new Date(endedAt))}</span></time> : <div className="turn-period-open"><strong>En curso</strong><span>Sin cerrar</span></div>}</dd></div>
  </dl>;
}
