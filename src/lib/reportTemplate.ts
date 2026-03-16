import type { ReportContent } from "@/lib/reportSchema";
import type { SajuResult } from "@/lib/saju";
import { reportContentToDocument } from "@/lib/reportContentToDocument";
import { renderReportFromDocument } from "@/lib/reportDocumentTemplate";

export function renderReportHtml(params: {
  name: string;
  gender: string;
  calendarLabel: string;
  birthLabel: string;
  backgroundImageUrl?: string;
  footerLogoUrl?: string;
  /** Optional image URL shown between each section. Set REPORT_SECTION_DIVIDER_IMAGE_URL in env. */
  sectionDividerImageUrl?: string;
  saju: SajuResult;
  report: ReportContent;
}): string {
  const document = reportContentToDocument(params.report, {
    name: params.name,
    gender: params.gender,
    calendarLabel: params.calendarLabel,
    birthLabel: params.birthLabel,
    saju: params.saju,
  });
  return renderReportFromDocument(document, {
    name: params.name,
    gender: params.gender,
    calendarLabel: params.calendarLabel,
    birthLabel: params.birthLabel,
    backgroundImageUrl: params.backgroundImageUrl,
    footerLogoUrl: params.footerLogoUrl,
    sectionDividerImageUrl: params.sectionDividerImageUrl,
  });
}
