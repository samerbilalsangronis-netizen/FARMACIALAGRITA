"use client";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { createColumnHelper, flexRender, getCoreRowModel, useReactTable } from "@tanstack/react-table";
import { useForm } from "react-hook-form";
import { ArrowDownToLine, FileSpreadsheet, History, Plus, Search } from "lucide-react";
import { decimal, displayDate, localDay, money, normalize, productFields, productSchema, type Product, type ProductField } from "@/lib/domain";
import { exportTable } from "@/lib/export";
import { initialMapping, readInventory, reviewInventory } from "@/lib/import-inventory";
import { rpc, supabase } from "@/lib/supabase";
import { accessError, type Operation } from "@/lib/use-operation";
import { Button } from "./ui/button";
import { Empty, Field, Heading, Notice } from "./ui/shared";

const emptyProducts: Product[] = [];
const coreRowModel = getCoreRowModel<Product>();
const column = createColumnHelper<Product>();
const columns = [
  column.accessor("name", { header: "Producto", cell: ({ row }) => <><strong>{row.original.name}</strong><small>{row.original.code} · {row.original.presentation || "Sin presentación"}</small></> }),
  column.accessor("category", { header: "Categoría", cell: ({ getValue }) => getValue() || "—" }),
  column.accessor("price", { header: "Precio", cell: ({ getValue }) => { const price = getValue(); return price === null ? <span className="pill warning">Pendiente de precio</span> : money(price); } }),
  column.accessor("stock", { header: "Existencias", cell: ({ row }) => <span className={row.original.stock <= row.original.min_stock ? "pill warning" : "pill"}>{row.original.stock} unidades</span> }),
  column.accessor("expiration", { header: "Vencimiento", cell: ({ getValue }) => getValue() ?? "—" }),
  column.accessor("active", { header: "Estado", cell: ({ getValue }) => getValue() ? "Activo" : "Inactivo" }),
];

export function Inventory({ op }: { op: Operation }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [page, setPage] = useState(0);
  const [mode, setMode] = useState<"list" | "import" | "history">("list");
  const [editing, setEditing] = useState<Product | "new" | null>(null);
  const [adjusting, setAdjusting] = useState<Product | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const admin = op.profile?.role === "admin";
  const online = op.connection === "online" || op.connection === "syncing" || (op.connection === "error" && Boolean(op.catalog));
  const products = op.catalog?.products ?? emptyProducts;
  const totals = useMemo(() => products.reduce((sum, p) => {
    const units = Math.max(0, p.stock);
    return { units: sum.units + units, value: sum.value.plus(new decimal(p.price ?? 0).times(units)),
      unpriced: sum.unpriced + (p.price === null ? units : 0), negative: sum.negative + (p.stock < 0 ? 1 : 0) };
  }, { units: 0, value: new decimal(0), unpriced: 0, negative: 0 }), [products]);
  const expiryLimit = localDay(Date.now() + 30 * 86400000);
  const filtered = useMemo(() => {
    const search = normalize(query.trim());
    return products.filter((p) => normalize([p.code, p.barcode, p.name, p.category, p.ingredient].join(" ")).includes(search) &&
      (filter === "all" || (filter === "unpriced" && p.price === null) || (filter === "low" && p.active && p.stock <= p.min_stock) || (filter === "inactive" && !p.active) ||
        (filter === "expiring" && p.active && p.expiration && p.expiration <= expiryLimit)));
  }, [products, query, filter, expiryLimit]);
  const index = Math.min(page, Math.max(0, Math.ceil(filtered.length / 25) - 1));
  const visibleProducts = useMemo(() => filtered.slice(index * 25, index * 25 + 25), [filtered, index]);
  const table = useReactTable({
    data: visibleProducts, columns, getCoreRowModel: coreRowModel, autoResetPageIndex: false,
  });

  async function refresh(text: string) { setMessage(text); setError(""); setEditing(null); setAdjusting(null); await op.sync(true); }

  return <>
    <div className="top-actions"><Heading label="CATÁLOGO" title="Inventario de medicamentos">Consulta existencias, agrega productos o carga un inventario desde un archivo.</Heading>
      {admin && online && <div className="actions">
        <Button variant="outline" onClick={() => setMode(mode === "history" ? "list" : "history")}><History size={17} /> Historial</Button>
        <Button variant="outline" onClick={() => setMode(mode === "import" ? "list" : "import")}><FileSpreadsheet size={17} /> Importar archivo</Button>
        <Button onClick={() => { setMode("list"); setEditing("new"); }}><Plus size={18} /> Nuevo producto</Button>
      </div>}
    </div>
    {admin && <div className="stats-grid">
      <section className="card stack"><span>Unidades en existencia</span><strong className="inventory-total-value">{new Intl.NumberFormat("es-VE").format(totals.units)}</strong><small>Todos los productos con saldo positivo, incluidos los inactivos.</small></section>
      <section className="card stack"><span>Valor del inventario en USD</span><strong className="inventory-total-value">{money(totals.value.toFixed(2))}</strong><small>Existencias × precio de venta actual. Total general, independiente del filtro.</small>
        {totals.unpriced > 0 && <Notice>{totals.unpriced} unidades sin precio están pendientes de valorar.</Notice>}
        {totals.negative > 0 && <Notice>{totals.negative} productos con saldo negativo requieren conciliación y no suman existencias.</Notice>}
      </section>
    </div>}
    {message && <Notice success>{message}</Notice>}
    {error && <Notice>{error}</Notice>}
    {mode === "import" && admin && online ? <ImportWizard products={products} onDone={async () => { await op.sync(true); }} />
      : mode === "history" && admin && online ? <InventoryHistory /> : <>
        {editing === "new" && admin && <ProductForm online={online}
          onCancel={() => setEditing(null)} onSaved={refresh} />}
        <section className="card">
          <div className="toolbar">
            <div className="search"><Search size={17} /><input aria-label="Filtrar inventario" placeholder="Buscar producto o código…" value={query} onChange={(e) => { setQuery(e.target.value); setPage(0); }} /></div>
            <select aria-label="Estado de inventario" value={filter} onChange={(event) => { setFilter(event.target.value); setPage(0); }}>
              <option value="all">Todos los productos</option><option value="unpriced">Pendientes de precio</option><option value="low">Bajo stock</option><option value="expiring">Vencidos o próximos</option><option value="inactive">Inactivos</option>
            </select>
            {admin && <Button variant="outline" onClick={() => void exportTable("inventario", productFields.map(([, label]) => label), filtered.map((p) => productFields.map(([field]) => p[field]))).catch((e) => setError(accessError(e)))}><ArrowDownToLine size={17} /> Exportar CSV</Button>}
          </div>
          {filtered.length === 0 ? <Empty>No hay medicamentos para este filtro.</Empty> : <div className="table-scroll inventory-table"><table>
            <thead>{table.getHeaderGroups().map((group) => <tr key={group.id}>{group.headers.map((head) => <th key={head.id}>{flexRender(head.column.columnDef.header, head.getContext())}</th>)}{admin && online && <th>Acciones</th>}</tr>)}</thead>
            <tbody>{table.getRowModel().rows.map((row) => {
              const isEditing = editing !== "new" && editing?.id === row.original.id;
              const isAdjusting = adjusting?.id === row.original.id;
              return <Fragment key={row.original.id}>
                <tr className={isEditing || isAdjusting ? "inventory-editing" : undefined}>
                  {row.getVisibleCells().map((cell) => <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>)}
                  {admin && online && <td><div className="actions">
                    <Button variant="ghost" aria-expanded={isEditing} onClick={() => { setEditing(isEditing ? null : row.original); setAdjusting(null); }}>Editar</Button>
                    <Button variant="ghost" aria-expanded={isAdjusting} onClick={() => { setAdjusting(isAdjusting ? null : row.original); setEditing(null); }}>Ajustar</Button>
                  </div></td>}
                </tr>
                {isEditing && editing && admin && <tr className="inventory-editing">
                  <td colSpan={columns.length + (online ? 1 : 0)}>
                    <ProductForm product={editing} online={online} onCancel={() => setEditing(null)} onSaved={refresh} />
                  </td>
                </tr>}
                {isAdjusting && adjusting && admin && <tr className="inventory-editing"><td colSpan={columns.length + (online ? 1 : 0)}>
                  <InventoryAdjustment product={adjusting} online={online} onCancel={() => setAdjusting(null)} onSaved={refresh} />
                </td></tr>}
              </Fragment>;
            })}</tbody>
          </table></div>}
          {filtered.length > 25 && <div className="toolbar"><Button variant="outline" disabled={index === 0} onClick={() => setPage(index - 1)}>Anterior</Button><span>{index + 1} de {Math.ceil(filtered.length / 25)}</span><Button variant="outline" disabled={(index + 1) * 25 >= filtered.length} onClick={() => setPage(index + 1)}>Siguiente</Button></div>}
        </section>
      </>}
  </>;
}

function InventoryAdjustment({ product, online, onSaved, onCancel }: { product: Product; online: boolean; onSaved: (text: string) => Promise<void>; onCancel: () => void }) {
  const title = useRef<HTMLHeadingElement>(null);
  const saving = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { title.current?.focus({ preventScroll: true }); title.current?.scrollIntoView({ block: "nearest" }); }, []);
  return <section className="card stack inventory-editor">
    <h2 tabIndex={-1} ref={title}>Ajustar existencias de {product.name}</h2>
    <p className="muted">Saldo registrado {product.stock}. Usa una cantidad positiva para entradas y negativa para salidas.</p>
    {!online && <Notice>Conéctate a internet para guardar este ajuste.</Notice>}
    {error && <Notice>{error}</Notice>}
    <form className="form-grid" onSubmit={async (event) => {
      event.preventDefault(); if (!online || saving.current) return;
      const data = new FormData(event.currentTarget);
      const delta = Number(data.get("delta"));
      if (!Number.isSafeInteger(delta) || delta === 0) { setError("Indica una cantidad entera distinta de cero."); return; }
      saving.current = true; setBusy(true); setError("");
      try { await rpc("adjust_inventory", { product: product.id, delta, reason: String(data.get("reason")) }); await onSaved("Movimiento guardado en el inventario."); }
      catch (error) { setError(accessError(error)); }
      finally { saving.current = false; setBusy(false); }
    }}>
      <Field label="Cantidad de ajuste"><input name="delta" type="number" step="1" required /></Field>
      <Field label="Motivo"><input name="reason" required minLength={3} maxLength={500} /></Field>
      <div className="actions"><Button type="submit" disabled={!online || busy}>{busy ? "Guardando…" : "Registrar ajuste"}</Button><Button variant="ghost" disabled={busy} onClick={onCancel}>Cancelar</Button></div>
    </form>
  </section>;
}

function ProductForm({ product, online, onSaved, onCancel }: { product?: Product; online: boolean; onSaved: (text: string) => Promise<void>; onCancel: () => void }) {
  const { register, handleSubmit, formState } = useForm<Partial<Record<ProductField, string>> & { active: boolean }>({
    defaultValues: { ...Object.fromEntries(productFields.map(([field]) => [field, String(product?.[field] ?? "")])), active: product?.price === null ? true : product?.active ?? true },
  });
  const [error, setError] = useState("");
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!product || !title.current) return;
    title.current.focus({ preventScroll: true });
    title.current.scrollIntoView({ block: "nearest", inline: "start" });
  }, [product]);
  const submit = handleSubmit(async (values) => {
    if (!online) return;
    const clean = { ...values, price: values.price?.replace(",", "."), min_stock: values.min_stock || "0" };
    if (product) delete clean.stock;
    else clean.stock = values.stock || "0";
    const parsed = productSchema.safeParse(clean);
    if (!parsed.success) {
      setError("Revisa " + parsed.error.issues.map(({ path }) => productFields.find(([field]) => field === path[0])?.[1]).filter(Boolean).join(", ") + ".");
      return;
    }
    setError("");
    try {
      await rpc("save_product", { data: { ...parsed.data, code: product?.code ?? parsed.data.code }, expected: product?.updated_at ?? null });
      await onSaved(product ? "Producto actualizado." : "Producto registrado.");
    } catch (error) { setError(accessError(error)); }
  });
  return <section className={product ? "card stack inventory-editor" : "card stack"}>
    <h2 ref={title} tabIndex={product ? -1 : undefined}>{product ? "Editar " + product.name : "Registrar medicamento"}</h2>
    {product?.price === null && <p className="muted">Registra el precio de venta en USD para habilitar este producto en caja.</p>}
    {!online && <Notice>El formulario sigue abierto. Conéctate a internet para guardar el producto.</Notice>}
    {error && <Notice>{error}</Notice>}
    <form className="stack" onSubmit={submit}>
      <div className="form-grid">{productFields.filter(([key]) => !product || key !== "stock").map(([key, label]) =>
        <Field key={key} label={label}><input {...register(key)} readOnly={key === "code" && Boolean(product)}
          type={key === "expiration" ? "date" : "text"} inputMode={key === "price" ? "decimal" : key.includes("stock") ? "numeric" : "text"}
          required={["code", "name", "price"].includes(key)} /></Field>)}</div>
      <label className="checkline"><input type="checkbox" {...register("active")} /> Producto activo</label>
      <div className="actions"><Button type="submit" disabled={!online || formState.isSubmitting}>{formState.isSubmitting ? "Guardando…" : "Guardar producto"}</Button><Button variant="ghost" onClick={onCancel}>Cancelar</Button></div>
    </form>
  </section>;
}

const phases = ["Archivo", "Columnas", "Identificación", "Confirmación", "Resultado"];
const statuses = { new: "Nuevo", update: "Actualizar", duplicate: "Posible duplicado", error: "Error", skip: "Sin cambios" };

function ImportWizard({ products, onDone }: { products: Product[]; onDone: () => Promise<void> }) {
  const [step, setStep] = useState(0);
  const [source, setSource] = useState<{ name: string; headers: string[]; rows: string[][] } | null>(null);
  const [mapping, setMapping] = useState<ReturnType<typeof initialMapping>>({});
  const [selected, setSelected] = useState(new Set<ProductField>(productFields.map(([field]) => field)));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ created: number; updated: number } | null>(null);
  const [reviewed, setReviewed] = useState<ReturnType<typeof reviewInventory>>([]);
  const [attempt, setAttempt] = useState("");
  const [omitted, setOmitted] = useState(new Set<number>());
  const review = useMemo(() => reviewInventory(source?.rows ?? [], mapping, selected, products), [source, mapping, selected, products]);
  const shownReview = step === 4 ? reviewed : review;
  const valid = shownReview.filter((r) => (r.status === "new" || r.status === "update") && !omitted.has(r.index));
  const missingColumns = ["code", "name"].some((field) => mapping[field as ProductField] === undefined);
  const mapped = Object.values(mapping).filter((index) => index !== undefined);
  const repeatedColumn = new Set(mapped).size !== mapped.length;

  async function execute() {
    if (!source || !valid.length || busy) return;
    setBusy(true); setError("");
    try {
      const outcome = await rpc<{ created: number; updated: number }>("import_products", {
        import_id: attempt, filename: source.name, rows: valid.map(({ data, expected }) => ({ data, expected })),
      });
      setReviewed(review);
      setResult(outcome);
      setStep(4);
      await onDone();
    } catch (error) { setError(accessError(error)); } finally { setBusy(false); }
  }

  return <section className="card stack">
    <h2>Importación de inventario</h2>
    <ol className="steps">{phases.map((phase, i) => <li key={phase} aria-current={i === step ? "step" : undefined}><b>{i + 1}</b> {phase}</li>)}</ol>
    {error && <Notice>{error}</Notice>}
    {step === 0 && <><p>Selecciona el inventario de a2 u otro sistema. Para Excel se usa la primera hoja. Incluye encabezados y hasta 1.000 registros.</p>
      <Field label="Archivo de inventario"><input type="file" accept=".csv,.xls,.xlsx" disabled={busy} onChange={async (e) => {
        const file = e.target.files?.[0]; if (!file) return;
        setBusy(true); setError("");
        try {
          const workbook = await readInventory(file);
          setSource({ name: file.name.slice(0, 255), ...workbook }); setMapping(initialMapping(workbook.headers));
          setAttempt(crypto.randomUUID()); setOmitted(new Set()); setStep(1);
        } catch (error) { setError(accessError(error)); } finally { setBusy(false); }
      }} /></Field></>}
    {step === 1 && source && <>
      <p>Relaciona cada columna. Si tienes precios, usa USD con punto o coma decimal y para vencimientos usa AAAA-MM-DD.</p>
      <div className="form-grid">{productFields.map(([field, label]) => <Field key={field} label={label}>
        <select value={mapping[field] ?? ""} onChange={(e) => setMapping({ ...mapping, [field]: e.target.value === "" ? undefined : Number(e.target.value) })}>
          <option value="">Sin asignar</option>{source.headers.map((head, i) => <option key={i} value={i}>{i + 1}. {head || "Sin encabezado"}</option>)}
        </select></Field>)}</div>
      <div className="table-scroll"><table><thead><tr>{source.headers.map((head, i) => <th key={i}>{head || "—"}</th>)}</tr></thead>
        <tbody>{source.rows.slice(0, 3).map((row, i) => <tr key={i}>{source.headers.map((_, j) => <td key={j}>{row[j]}</td>)}</tr>)}</tbody></table></div>
      {(missingColumns || repeatedColumn) && <Notice>Asigna código y nombre a columnas distintas. Cada columna se usa una sola vez.</Notice>}
    </>}
    {step === 2 && <>
      <p>Se identifica cada medicamento por su código interno. Los códigos de barras en conflicto se omiten.</p>
      <div className="check-grid">{productFields.filter(([field]) => !["code", "stock"].includes(field) && mapping[field] !== undefined).map(([field, label]) =>
        <label key={field} className="checkline"><input type="checkbox" checked={selected.has(field)} onChange={(e) => {
          const next = new Set(selected); if (e.target.checked) next.add(field); else next.delete(field); setSelected(next);
        }} /> Actualizar {label.toLowerCase()}</label>)}</div>
      <p>Los productos nuevos sin precio quedan pendientes y fuera de caja hasta que registres un precio en USD.</p>
      <Notice>Las existencias importadas solo se aplican a productos nuevos. Las diferencias de productos existentes requieren un ajuste de inventario auditado.</Notice>
    </>}
    {(step === 2 || step === 3) && <div className="table-scroll tall"><table>
      <thead><tr>{step === 3 && <th>Aplicar</th>}<th>Fila</th><th>Producto</th><th>Estado</th><th>Detalle</th></tr></thead>
      <tbody>{review.map((r) => <tr key={r.index}>
        {step === 3 && <td><input type="checkbox" aria-label={"Aplicar fila " + r.index} disabled={busy || !["new", "update"].includes(r.status)}
          checked={["new", "update"].includes(r.status) && !omitted.has(r.index)} onChange={(e) => {
            const next = new Set(omitted); if (e.target.checked) next.delete(r.index); else next.add(r.index); setOmitted(next);
          }} /></td>}
        <td>{r.index}</td><td>{r.code} {r.name}</td><td>{statuses[r.status as keyof typeof statuses]}</td>
        <td>{r.problems}{r.changes.map((change) => <small key={change.field}>{change.label} · {change.before || "vacío"} → {change.after || "vacío"}</small>)}
          {r.heldStock && <small>Existencia propuesta de {r.heldStock} reservada para conciliación.</small>}</td>
      </tr>)}</tbody></table></div>}
    {step === 3 && <p>{valid.length} filas seleccionadas. La operación se aplica completa o se revierte si hay un conflicto.</p>}
    {step === 4 && result && <>
      <Notice success>{result.created} productos nuevos, {result.updated} actualizados y {reviewed.length - result.created - result.updated} omitidos.</Notice>
      <p>{reviewed.filter((r) => r.status === "duplicate").length} posibles duplicados y {reviewed.filter((r) => r.status === "error").length} filas con errores.</p>
      <Button variant="outline" onClick={() => void exportTable("resultado-importacion", ["Fila", "Código", "Producto", "Estado", "Errores", "Existencia por conciliar"],
        reviewed.map((r) => [r.index, r.code, r.name, omitted.has(r.index) ? "Omitida" : statuses[r.status as keyof typeof statuses], r.problems, r.heldStock]))}>Descargar resultado</Button>
    </>}
    <div className="actions">
      {step > 0 && step < 4 && <Button variant="ghost" disabled={busy} onClick={() => setStep(step - 1)}>Atrás</Button>}
      {step > 0 && step < 3 && <Button disabled={step === 1 && (missingColumns || repeatedColumn)} onClick={() => setStep(step + 1)}>Continuar</Button>}
      {step === 3 && <Button disabled={busy || !valid.length} onClick={() => void execute()}>{busy ? "Importando…" : "Confirmar importación"}</Button>}
      {step === 4 && <Button onClick={() => { setResult(null); setSource(null); setReviewed([]); setStep(0); }}>Importar otro archivo</Button>}
    </div>
  </section>;
}

type Movement = { id: string; product_id: string; kind: string; delta: number; stock_after: number; note: string; created_at: string; products: { code: string; name: string } };
type ImportRun = { id: string; filename: string; created_at: string; summary: { created: number; updated: number }; profiles: { username: string } | null };
function InventoryHistory() {
  const [rows, setRows] = useState<Movement[]>([]);
  const [imports, setImports] = useState<ImportRun[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  async function load() {
    try {
      const client = supabase();
      const [movements, batches] = await Promise.all([
        client.from("inventory_movements").select("id,product_id,kind,delta,stock_after,note,created_at,products(code,name)").order("created_at", { ascending: false }).limit(300),
        client.from("inventory_imports").select("id,filename,created_at,summary,profiles(username)").order("created_at", { ascending: false }).limit(100),
      ]);
      if (movements.error || batches.error) throw new Error(movements.error?.message ?? batches.error?.message);
      setRows(movements.data as unknown as Movement[]); setImports(batches.data as unknown as ImportRun[]); setLoaded(true);
    } catch (error) { setError(accessError(error)); }
  }
  return <>
    <section className="card stack"><div className="section-title"><div><h2>Movimientos de inventario</h2><p>Últimos 300 movimientos registrados.</p></div><Button variant="outline" onClick={() => void load()}>{loaded ? "Actualizar" : "Cargar historial"}</Button></div>
      {error && <Notice>{error}</Notice>}
      {loaded && (rows.length ? <div className="table-scroll"><table><thead><tr><th>Fecha</th><th>Producto</th><th>Tipo</th><th>Variación</th><th>Saldo</th><th>Motivo</th></tr></thead>
        <tbody>{rows.map((m) => <tr key={m.id}><td>{displayDate(m.created_at)}</td><td>{m.products?.name}</td><td>{({initial:"Inicial",sale:"Venta",void:"Anulación",adjustment:"Ajuste",entry:"Entrada"} as Record<string,string>)[m.kind]}</td><td>{m.delta}</td><td>{m.stock_after}</td><td>{m.note}</td></tr>)}</tbody></table></div> : <Empty>No hay movimientos registrados.</Empty>)}
    </section>
    {loaded && <section className="card stack"><h2>Importaciones anteriores</h2>
      {imports.length ? <div className="table-scroll"><table><thead><tr><th>Fecha</th><th>Archivo</th><th>Usuario</th><th>Nuevos</th><th>Actualizados</th></tr></thead>
        <tbody>{imports.map((m) => <tr key={m.id}><td>{displayDate(m.created_at)}</td><td>{m.filename}</td><td>{m.profiles?.username}</td><td>{m.summary.created}</td><td>{m.summary.updated}</td></tr>)}</tbody></table></div> : <Empty>No hay importaciones registradas.</Empty>}
    </section>}
  </>;
}
