import { NextResponse } from "next/server";

import { getOptionalEnv } from "@/lib/env";
import { renderPdfFromHtml } from "@/lib/pdf";
import { renderReportHtml } from "@/lib/reportTemplate";
import { resolveReportBackgroundImageUrl, resolveReportFooterLogoUrl } from "@/lib/reportBackground";
import {
  getSampleSaju,
  sampleReportContent,
  sampleParams,
} from "@/lib/sampleReport";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** GET /api/preview/report-pdf — 샘플 리포트 PDF 다운로드 (로컬 스타일링용) */
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

  const pdfBytes = await renderPdfFromHtml({ html });
  const fileName = "sample_saju_report.pdf";

  return new NextResponse(pdfBytes, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${fileName}"`,
    },
  });
}
