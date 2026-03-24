import { NextResponse } from "next/server";

import { isAuthorizedRequest } from "@/lib/auth";
import { getOptionalEnv } from "@/lib/env";
import { renderReportHtml } from "@/lib/reportTemplate";
import { resolveReportBackgroundImageUrl, resolveReportFooterLogoUrl } from "@/lib/reportBackground";
import {
  getSampleSaju,
  sampleReportContent,
  sampleParams,
} from "@/lib/sampleReport";

export const dynamic = "force-dynamic";

/** GET /api/preview/report-html — 샘플 리포트 HTML (로컬 스타일링용) */
export async function GET(req: Request) {
  if (!isAuthorizedRequest(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const saju = getSampleSaju();
  const backgroundImageUrl = await resolveReportBackgroundImageUrl();
  const footerLogoUrl = await resolveReportFooterLogoUrl();
  const sectionDividerImageUrl = getOptionalEnv("REPORT_SECTION_DIVIDER_IMAGE_URL");
  const assetBaseUrl = new URL(req.url).origin;

  let html = await renderReportHtml({
    ...sampleParams,
    assetBaseUrl,
    backgroundImageUrl,
    footerLogoUrl,
    sectionDividerImageUrl,
    saju,
    report: sampleReportContent,
  });

  const url = new URL(req.url);
  const debug = url.searchParams.get("debug") === "1";
  if (debug) {
    const debugCss = `
      <style>
        /* Debug frame for browser preview only */
        @media screen {
          html, body { background: #ffffff !important; }
          body { padding: 0 !important; }
          .doc-pageBg { display: none !important; }
          .doc-pageFooterLogo { outline: 1px dashed rgba(255,255,255,0.45); outline-offset: 2px; }

          /* A4 page frames */
          .doc-coverPage,
          .doc-contentWrap {
            width: 210mm !important;
            min-height: 297mm !important;
            margin: 0 auto !important;
            background: white;
            box-shadow: none;
            outline: none;
            position: relative;
            padding: 40px;
          }

          /* Show “content safe area” border (approx) */
          .doc-contentInner {
            outline: 1px dashed rgba(220, 38, 38, 0.65);
            outline-offset: 6px;
          }
        }
      </style>
    `.trim();

    html = html.replace("</head>", `${debugCss}\n</head>`);
  }

  return new NextResponse(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      Pragma: "no-cache",
      Expires: "0",
    },
  });
}
