import { NextResponse } from "next/server";

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
export async function GET() {
  const saju = getSampleSaju();
  const backgroundImageUrl = await resolveReportBackgroundImageUrl();
  const footerLogoUrl = await resolveReportFooterLogoUrl();
  const sectionDividerImageUrl = getOptionalEnv("REPORT_SECTION_DIVIDER_IMAGE_URL");

  const html = renderReportHtml({
    ...sampleParams,
    backgroundImageUrl,
    footerLogoUrl,
    sectionDividerImageUrl,
    saju,
    report: sampleReportContent,
  });

  return new NextResponse(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
