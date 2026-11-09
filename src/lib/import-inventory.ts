import { normalize, productFields, productSchema, type Product, type ProductField } from "./domain";

const importProductSchema = productSchema.extend({ price: productSchema.shape.price.optional() });

type Mapping = Partial<Record<ProductField, number>>;
const aliases: Partial<Record<ProductField, string[]>> = {
  code: ["codigo", "codigo interno", "sku", "referencia", "cod", "code"], barcode: ["codigo de barras", "ean", "barcode"],
  name: ["nombre", "descripcion", "producto", "articulo", "name"], ingredient: ["principio activo", "ingrediente"],
  strength: ["concentracion"], presentation: ["presentacion", "formato"], category: ["categoria", "grupo"],
  laboratory: ["laboratorio", "marca"], price: ["precio usd", "precio", "pvp", "precio de venta", "price"],
  stock: ["stock", "existencias", "cantidad", "inventario"], min_stock: ["minimo", "stock minimo"],
  batch: ["lote"], expiration: ["vencimiento", "fecha de vencimiento", "caducidad"],
};
export function initialMapping(headers: string[]) {
  const result: Mapping = {};
  for (const [field] of productFields) {
    const index = headers.findIndex((name) => aliases[field]?.includes(normalize(name.trim().replace(/[_-]/g, " "))));
    if (index >= 0) result[field] = index;
  }
  return result;
}

export async function readInventory(file: File) {
  if (file.size > 3_000_000) throw new Error("El archivo debe pesar menos de 3 MB.");
  const extension = file.name.split(".").at(-1)?.toLowerCase();
  const bytes = await file.arrayBuffer();
  let matrix: string[][];
  if (extension === "csv") {
    const { default: Papa } = await import("papaparse");
    let csv: string;
    try { csv = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { csv = new TextDecoder("windows-1252").decode(bytes); }
    const parsed = Papa.parse<string[]>(csv, { skipEmptyLines: "greedy" });
    if (parsed.errors.some((error) => error.type === "Quotes")) throw new Error("Revisa las comillas y separadores del CSV.");
    matrix = parsed.data;
  } else if (extension === "xlsx" || extension === "xls") {
    const XLSX = await import("xlsx");
    const book = XLSX.read(bytes, { sheetRows: 1002, sheets: 0, cellText: true });
    if (!book.SheetNames[0]) throw new Error("No encontramos una hoja de inventario.");
    matrix = XLSX.utils.sheet_to_json<string[]>(book.Sheets[book.SheetNames[0]], {
      header: 1, raw: false, defval: "", blankrows: false, dateNF: "yyyy-mm-dd",
    });
  } else {
    throw new Error("Selecciona un archivo CSV, XLS o XLSX.");
  }
  const [headers, ...rows] = matrix;
  if (!headers || !rows.length || rows.length > 1000 || headers.length > 100) {
    throw new Error("Usa la primera fila para los encabezados y entre 1 y 1000 filas de hasta 100 columnas.");
  }
  return { headers, rows };
}

function normalizedValue(field: ProductField, value: string) {
  if (field === "price") return value.replace(",", ".");
  return value;
}

export function reviewInventory(rows: string[][], mapping: Mapping, selected: Set<ProductField>, products: Product[]) {
  const byCode = new Map(products.map((p) => [p.code, p]));
  const byBarcode = new Map(products.filter((p) => p.barcode).map((p) => [p.barcode, p]));
  const codeCount = new Map<string, number>();
  const barcodeCount = new Map<string, number>();
  const raw = rows.map((row) => {
    const values: Partial<Record<ProductField, string>> = {};
    for (const [field] of productFields) {
      const index = mapping[field];
      if (index !== undefined) values[field] = normalizedValue(field, String(row[index] ?? "").trim());
    }
    if (values.price === "") delete values.price;
    const code = values.code?.toUpperCase();
    if (code) codeCount.set(code, (codeCount.get(code) ?? 0) + 1);
    if (values.barcode) barcodeCount.set(values.barcode, (barcodeCount.get(values.barcode) ?? 0) + 1);
    return { ...values, code };
  });
  return raw.map((values, i) => {
    const existing = values.code ? byCode.get(values.code) : undefined;
    const claimed = values.barcode ? byBarcode.get(values.barcode) : undefined;
    const repeated = Boolean((values.code && (codeCount.get(values.code) ?? 0) > 1) ||
      (values.barcode && (barcodeCount.get(values.barcode) ?? 0) > 1) || (claimed && claimed.id !== existing?.id));
    const changes = productFields.flatMap(([field, label]) => {
      const incoming = values[field];
      if (field === "code" || field === "stock" || incoming === undefined || !selected.has(field) || !existing) return [];
      const before = String(existing[field] ?? "");
      return before === incoming ? [] : [{ field, label, before, after: incoming }];
    });
    const heldStock = existing && values.stock && String(existing.stock) !== values.stock ? values.stock : null;
    const data = existing ? { code: existing.code, name: existing.name, price: existing.price === null ? undefined : String(existing.price),
      ...Object.fromEntries(changes.map(({ field, after }) => [field, after])) } : values;
    const checked = importProductSchema.safeParse(data);
    const status = repeated ? "duplicate" : !checked.success ? "error" : !existing ? "new" : changes.length ? "update" : "skip";
    const problems = checked.success ? "" : checked.error.issues.map(({ path }) => productFields.find(([field]) => field === path[0])?.[1] ?? String(path[0])).join(", ");
    return { index: i + 2, name: values.name ?? existing?.name ?? "", code: values.code ?? "", status, changes, heldStock,
      problems, data: checked.success ? checked.data : null, expected: existing?.updated_at ?? null };
  });
}
