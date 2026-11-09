import { jsPDF } from "jspdf";

export type ReportSection = {
  title: string;
  columns: { label: string; width: number; align?: "right" }[];
  rows: string[][];
};

export type ReportPdf = {
  title: string;
  pharmacy: string;
  logo: Uint8Array;
  rif: string;
  address?: string;
  phone?: string;
  period: string;
  issuedAt: string;
  coverage?: string;
  summaryTitle?: string;
  indicators: { label: string; value: string }[];
  sections: ReportSection[];
};

const colors = {
  forest: "#102E61", teal: "#00738C", green: "#D1F3FA", ink: "#173354", muted: "#4D6377",
  line: "#DAE8EE", mint: "#EAF6FA", pale: "#F4F8FA", white: "#FFFFFF", amber: "#8A5917", sand: "#FFF3DD",
};

function printable(text: string) {
  return text.normalize("NFC")
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+/g, " ")
    .replace(/[^\x20-\x7e\xa0-\xff]/g, "?")
    .trim();
}

export function createReportPdf(report: ReportPdf) {
  const doc = new jsPDF({ format: "a4", unit: "mm", compress: true });
  const left = 16;
  const width = 178;
  const bottom = 278;
  let y = 0;

  const font = (size: number, color: string = colors.ink, bold = false) =>
    doc.setFont("helvetica", bold ? "bold" : "normal").setFontSize(size).setTextColor(color);
  const fill = (x: number, top: number, w: number, h: number, color: string) =>
    doc.setFillColor(color).rect(x, top, w, h, "F");
  const wrap = (value: string, w: number): string[] => doc.splitTextToSize(printable(value), w);
  const lines = (value: string[], x: number, top: number, step: number, align: "left" | "right" = "left") => {
    value.forEach((line, i) => doc.text(line, x, top + i * step, { align }));
  };

  function header(first: boolean) {
    if (first) {
      font(15, colors.white, true);
      const pharmacy = wrap(report.pharmacy, 95);
      const titleTop = Math.max(47, 37 + (pharmacy.length - 1) * 6);
      font(9, colors.green);
      const address = ["RIF " + report.rif, report.address, report.phone].filter(Boolean).join("  |  ");
      const contact = address ? wrap(address, width - 4) : [];
      const headerHeight = titleTop + 19 + contact.length * 4;
      fill(0, 0, 210, headerHeight, colors.forest);
      fill(0, 0, 210, 2, colors.teal);
      const logo = doc.getImageProperties(report.logo);
      const logoWidth = 76;
      doc.addImage(report.logo, "JPEG", left + width - logoWidth, 9, logoWidth, logoWidth * logo.height / logo.width);
      font(8, colors.green, true);
      doc.text("FARMACIA  /  CONTROL OPERATIVO", left, 16);
      font(15, colors.white, true);
      lines(pharmacy, left, 25, 6);
      font(27, colors.white, true);
      doc.text(printable(report.title), left, titleTop);
      font(10, colors.green);
      doc.text(printable(report.period), left, titleTop + 8);
      font(9, colors.green);
      lines(contact, left, titleTop + 14, 4);
      y = headerHeight + 10;
    } else {
      fill(0, 0, 210, 2, colors.teal);
      font(9, colors.ink, true);
      const pharmacy = wrap(report.pharmacy, 109);
      lines(pharmacy, left, 13, 4);
      font(8, colors.muted);
      doc.text(printable(report.title), left + width, 13, { align: "right" });
      const lineAt = 17 + (pharmacy.length - 1) * 4;
      doc.setDrawColor(colors.line).line(left, lineAt, left + width, lineAt);
      y = lineAt + 8;
    }
  }

  function page() { doc.addPage(); header(false); }

  function table(section: ReportSection) {
    const heading = (continued = false) => {
      font(13, colors.forest, true);
      doc.text(printable(section.title + (continued ? " (continuación)" : "")), left, y + 4);
      y += 8;
      fill(left, y, width, 8, colors.forest);
      font(8, colors.white, true);
      let x = left;
      for (const column of section.columns) {
        doc.text(printable(column.label), column.align ? x + column.width - 3 : x + 3, y + 5.2,
          { align: column.align ?? "left" });
        x += column.width;
      }
      y += 8;
    };
    const layout = (row: string[]) => {
      font(9);
      const cells = section.columns.map((column, i) => wrap(row[i] || "-", column.width - 6));
      return { cells, height: Math.max(8, Math.max(...cells.map((cell) => cell.length)) * 3.8 + 4) };
    };
    const initialRows = section.rows.length <= 8 ? section.rows : section.rows.slice(0, 1);
    const initialHeight = initialRows.length ? initialRows.reduce((height, row) => height + layout(row).height, 0) : 9;
    if (y + 16 + initialHeight > bottom) page();
    heading();
    if (!section.rows.length) {
      fill(left, y, width, 9, colors.pale);
      font(9, colors.muted);
      doc.text("Sin registros en este período.", left + 3, y + 6);
      y += 9;
    }
    section.rows.forEach((row, index) => {
      const { cells, height } = layout(row);
      if (y + height > bottom) { page(); heading(true); }
      if (index % 2 === 0) fill(left, y, width, height, colors.pale);
      font(9);
      let x = left;
      section.columns.forEach((column, i) => {
        lines(cells[i], column.align ? x + column.width - 3 : x + 3, y + 5.3, 3.8, column.align);
        x += column.width;
      });
      y += height;
      doc.setDrawColor(colors.line).setLineWidth(0.15).line(left, y, left + width, y);
    });
    y += 9;
  }

  doc.setProperties({ title: report.title, subject: report.period, author: report.pharmacy });
  header(true);
  font(13, colors.forest, true);
  doc.text(printable(report.summaryTitle ?? "Resumen del período"), left, y + 4);
  y += 9;

  const gap = 4;
  const cardWidth = (width - 2 * gap) / 3;
  for (const [index, indicator] of report.indicators.entries()) {
    const x = left + (index % 3) * (cardWidth + gap);
    const top = y + Math.floor(index / 3) * 25;
    const highlight = index === 0;
    fill(x, top, cardWidth, 21, highlight ? colors.teal : colors.mint);
    font(8, highlight ? colors.white : colors.muted, true);
    doc.text(printable(indicator.label), x + 4, top + 7);
    font(17, highlight ? colors.white : colors.forest, true);
    const value = printable(indicator.value);
    const valueWidth = doc.getTextWidth(value);
    if (valueWidth > cardWidth - 8) doc.setFontSize(17 * (cardWidth - 8) / valueWidth);
    doc.text(value, x + 4, top + 16);
  }
  y += Math.ceil(report.indicators.length / 3) * 25 + 4;

  if (report.coverage) {
    font(9, colors.amber);
    const note = wrap(report.coverage, width - 10);
    const height = 6 + note.length * 4;
    fill(left, y, width, height, colors.sand);
    lines(note, left + 5, y + 5.5, 4);
    y += height + 7;
  }

  for (const section of report.sections) table(section);

  const pages = doc.getNumberOfPages();
  for (let current = 1; current <= pages; current++) {
    doc.setPage(current);
    doc.setDrawColor(colors.line).setLineWidth(0.2).line(left, 283, left + width, 283);
    font(8, colors.muted);
    doc.text("Control interno  |  Generado " + printable(report.issuedAt), left, 289);
    doc.text("Página " + current + " de " + pages, left + width, 289, { align: "right" });
  }
  return doc;
}
