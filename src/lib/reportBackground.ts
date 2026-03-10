import { readFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_BACKGROUND_IMAGE_PATH = path.join(
  process.cwd(),
  "src",
  "asset",
  "images",
  "saju_bg.png",
);
const DEFAULT_FOOTER_LOGO_PATH = path.join(
  process.cwd(),
  "src",
  "asset",
  "images",
  "saju_footer_logo.png",
);

let cachedBackgroundDataUrl: string | undefined;
let cachedFooterLogoDataUrl: string | undefined;

export async function resolveReportBackgroundImageUrl(): Promise<string | undefined> {
  // New explicit override.
  if (process.env.REPORT_BACKGROUND_IMAGE_URL) {
    return process.env.REPORT_BACKGROUND_IMAGE_URL;
  }

  if (cachedBackgroundDataUrl) {
    return cachedBackgroundDataUrl;
  }

  try {
    const png = await readFile(DEFAULT_BACKGROUND_IMAGE_PATH);
    cachedBackgroundDataUrl = `data:image/png;base64,${png.toString("base64")}`;
    return cachedBackgroundDataUrl;
  } catch {
    // Backward compatibility: use legacy env name if local asset is unavailable.
    return process.env.REPORT_COVER_IMAGE_URL;
  }
}

export async function resolveReportFooterLogoUrl(): Promise<string | undefined> {
  if (process.env.REPORT_FOOTER_LOGO_URL) {
    return process.env.REPORT_FOOTER_LOGO_URL;
  }

  if (cachedFooterLogoDataUrl) {
    return cachedFooterLogoDataUrl;
  }

  try {
    const png = await readFile(DEFAULT_FOOTER_LOGO_PATH);
    cachedFooterLogoDataUrl = `data:image/png;base64,${png.toString("base64")}`;
    return cachedFooterLogoDataUrl;
  } catch {
    return undefined;
  }
}
