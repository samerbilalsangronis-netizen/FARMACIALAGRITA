import type { QueuedSale, Receipt } from "./domain";

export type PendingResolution = { id: string; state: "pending" | "synced" | "cancelled" | "conflict"; reason?: string; fiscal_status?: Receipt["fiscal_status"] };
export function pendingEntries(sales: QueuedSale[]) {
  return sales.filter(s => Boolean(s.receipt.local) && s.receipt.fiscal_status !== "void").map(s => ({ payload: s.payload, receipt: s.receipt }));
}
export function applyPendingResolution(receipt: Receipt, resolution: PendingResolution): Receipt {
  if (resolution.state === "cancelled") return { ...receipt, fiscal_status: "void", local: undefined, error: undefined, cancellation_reason: resolution.reason };
  if (resolution.state === "synced") return { ...receipt, fiscal_status: resolution.fiscal_status ?? receipt.fiscal_status, local: undefined, error: undefined };
  if (resolution.state === "conflict") return { ...receipt, local: "error", error: resolution.reason ?? "El identificador ya existe con otros datos. Requiere revisión de administración." };
  return receipt;
}
