export type ExportCell = string | number | boolean | null;
function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function safeCell(value: ExportCell) {
  const text = String(value ?? "");
  return typeof value === "string" && /^[\s\uFEFF]*[=+@-]|^[\t\r\n]/.test(text) ? "'" + text : text;
}

export async function exportTable(name: string, header: string[], rows: ExportCell[][], format: "csv" | "xlsx" | "pdf" = "csv") {
  if (format === "csv") {
    const csv = [header, ...rows].map((row) => row.map((value) => '"' + safeCell(value).replaceAll('"', '""') + '"').join(";")).join("\r\n");
    download(new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" }), name + ".csv");
  } else if (format === "xlsx") {
    const XLSX = await import("xlsx");
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([header, ...rows]), "Reporte");
    download(new Blob([XLSX.write(book, { type: "array", bookType: "xlsx" })], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }), name + ".xlsx");
  } else {
    const { jsPDF } = await import("jspdf");
    const pdf = new jsPDF();
    pdf.setFontSize(15);
    pdf.text(name.replaceAll("-", " "), 14, 16);
    pdf.setFontSize(9);
    let y = 26;
    for (const row of [header, ...rows]) {
      const lines: string[] = pdf.splitTextToSize(row.map((value) => String(value ?? "")).join("   |   "), 180);
      for (const line of lines) {
        if (y > 279) { pdf.addPage(); y = 16; }
        pdf.text(line, 14, y);
        y += 5;
      }
      y += 1;
    }
    pdf.save(name + ".pdf");
  }
}
