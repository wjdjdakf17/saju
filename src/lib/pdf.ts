import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";

export async function renderPdfFromHtml(params: {
  html: string;
  title?: string;
}): Promise<Uint8Array> {
  const localExecutablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  const executablePath = localExecutablePath || (await chromium.executablePath());
  const isLocalChrome = !!localExecutablePath && !process.env.VERCEL;

  const browser = await puppeteer.launch({
    args: isLocalChrome ? [] : chromium.args,
    executablePath,
    headless: true,
  });

  try {
    const page = await browser.newPage();
    await page.setContent(params.html, { waitUntil: "networkidle0" });
    await page.evaluate(async () => {
      // Ensure web fonts are ready before printing to avoid tofu/square glyphs.
      await document.fonts.ready;
    });
    await page.emulateMediaType("screen");

    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "14mm", right: "14mm", bottom: "14mm", left: "14mm" },
    });

    return pdf;
  } finally {
    await browser.close();
  }
}
