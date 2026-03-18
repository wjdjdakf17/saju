import { existsSync } from "node:fs";
import { platform } from "node:os";
import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";

const MAC_CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PDF_NAVIGATION_TIMEOUT_MS = 120_000;
const PDF_FONT_WAIT_TIMEOUT_MS = 12_000;
const PDF_RENDER_ATTEMPTS = 2;

function isTargetClosedError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("Target closed") || message.includes("Runtime.callFunctionOn");
}

export async function renderPdfFromHtml(params: {
  html: string;
  title?: string;
}): Promise<Uint8Array> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= PDF_RENDER_ATTEMPTS; attempt += 1) {
    try {
      return await renderPdfFromHtmlOnce(params);
    } catch (err) {
      lastError = err;
      if (attempt >= PDF_RENDER_ATTEMPTS) break;
      if (!isTargetClosedError(err)) break;
    }
  }

  if (isTargetClosedError(lastError)) {
    throw new Error("PDF 렌더 중 Chromium target이 종료되었습니다. 문서가 너무 크거나 렌더 중 브라우저가 메모리 부족으로 종료된 상황일 가능성이 큽니다.");
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function renderPdfFromHtmlOnce(params: {
  html: string;
  title?: string;
}): Promise<Uint8Array> {
  let executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  if (!executablePath && platform() === "darwin" && existsSync(MAC_CHROME_PATH)) {
    executablePath = MAC_CHROME_PATH;
  }
  if (!executablePath) {
    executablePath = await chromium.executablePath();
  }
  const isLocalChrome = !!process.env.PUPPETEER_EXECUTABLE_PATH || (platform() === "darwin" && executablePath === MAC_CHROME_PATH);

  const browser = await puppeteer.launch({
    args: isLocalChrome ? ["--no-sandbox", "--disable-setuid-sandbox"] : chromium.args,
    executablePath,
    headless: true,
  });

  try {
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(PDF_NAVIGATION_TIMEOUT_MS);
    page.setDefaultTimeout(PDF_NAVIGATION_TIMEOUT_MS);

    // `networkidle0` is fragile here because external fonts or large embedded assets
    // can keep the page "busy" long enough to hit the default 30s timeout.
    await page.setContent(params.html, {
      waitUntil: ["domcontentloaded", "load"],
      timeout: PDF_NAVIGATION_TIMEOUT_MS,
    });
    await page.evaluate(async (fontWaitTimeoutMs) => {
      // Wait for fonts when possible, but don't fail the whole render if a remote
      // font host is slow. The PDF can still render with the serif fallback stack.
      if (!("fonts" in document)) return;
      await Promise.race([
        document.fonts.ready.catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, fontWaitTimeoutMs)),
      ]);
    }, PDF_FONT_WAIT_TIMEOUT_MS);
    await page.emulateMediaType("print");

    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "0mm", right: "0mm", bottom: "0mm", left: "0mm" },
      scale: 1,
      preferCSSPageSize: true,
    });

    return pdf;
  } finally {
    await browser.close();
  }
}
