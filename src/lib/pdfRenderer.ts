export type PdfRenderer = "html" | "typst";

export function resolvePdfRenderer(): PdfRenderer {
  const raw = (process.env.PDF_RENDERER || "html").toLowerCase();
  return raw === "typst" ? "typst" : "html";
}

export function isStrictRendererMode(): boolean {
  return (process.env.PDF_RENDERER_STRICT || "false").toLowerCase() === "true";
}
