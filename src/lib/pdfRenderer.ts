export type PdfRenderer = "html" | "typst";

export function resolvePdfRenderer(): PdfRenderer {
  const raw = (process.env.PDF_RENDERER || "typst").toLowerCase();
  return raw === "html" ? "html" : "typst";
}

export function isStrictRendererMode(): boolean {
  return (process.env.PDF_RENDERER_STRICT || "false").toLowerCase() === "true";
}
