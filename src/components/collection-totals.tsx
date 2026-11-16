import { collectionTotals, money, type CollectionSummary } from "@/lib/domain";

export function CollectionTotals({ summaries }: { summaries: CollectionSummary[] }) {
  const totals = collectionTotals(summaries);
  return <div className="currency-totals">
    <div className="currency-total"><span>Ventas en dólares</span><strong>{money(totals.USD, "USD")}</strong></div>
    <div className="currency-total"><span>Ventas en Bs.</span><strong>{money(totals.VES, "VES")}</strong></div>
    <div className="currency-total"><span>Ventas en pesos</span><strong>{money(totals.COP, "COP")}</strong></div>
  </div>;
}
