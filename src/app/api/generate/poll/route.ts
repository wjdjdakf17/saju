import { NextResponse } from "next/server";
import { z } from "zod";

import {
  decodeAsyncStateToken,
  encodeAsyncStateToken,
  getAsyncTotalSteps,
  type AsyncGenerateState,
} from "@/lib/asyncJob";
import {
  LlmRequestError,
  generateReportSectionsBatchPart,
  generateReportSummaryPart,
  generateReportTailPart,
  getReportSectionBatches,
  type LlmDebugTrace,
} from "@/lib/llm";
import { renderPdfFromHtml } from "@/lib/pdf";
import { isStrictRendererMode, resolvePdfRenderer } from "@/lib/pdfRenderer";
import { resolveReportBackgroundImageUrl, resolveReportFooterLogoUrl } from "@/lib/reportBackground";
import { reportContentSchema } from "@/lib/reportSchema";
import { renderReportHtml } from "@/lib/reportTemplate";
import { renderPdfFromTypst } from "@/lib/typst";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const pollRequestSchema = z.object({
  jobToken: z.string().min(20),
});

function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "_").trim();
}

function progressOf(state: AsyncGenerateState, totalSteps: number): number {
  if (totalSteps <= 0) return 0;
  const ratio = state.completedSteps / totalSteps;
  return Math.max(0, Math.min(100, Math.floor(ratio * 100)));
}

export async function POST(req: Request) {
  try {
    const expectedSecret = process.env.WEBHOOK_SECRET;
    if (!expectedSecret) {
      return NextResponse.json({ error: "server_error", message: "Missing WEBHOOK_SECRET" }, { status: 500 });
    }

    const providedSecret = req.headers.get("x-webhook-secret") || "";
    if (providedSecret !== expectedSecret) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const parsed = pollRequestSchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: "invalid_request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    let state: AsyncGenerateState;
    try {
      state = decodeAsyncStateToken(parsed.data.jobToken, expectedSecret);
    } catch (err) {
      const message = err instanceof Error ? err.message : "invalid_token";
      return NextResponse.json({ error: "invalid_job_token", message }, { status: 400 });
    }

    const sectionBatches = getReportSectionBatches();
    const totalSteps = getAsyncTotalSteps(sectionBatches.length);
    const enteredAsRenderStage = state.stage === "render";
    const includeDebugOutput = process.env.REPORT_DEBUG_OUTPUT === "true";
    const stepTraces: LlmDebugTrace[] = [];
    const debugCapture = includeDebugOutput
      ? (trace: LlmDebugTrace) => {
        stepTraces.push(trace);
      }
      : undefined;

    if (state.stage === "summary") {
      const summaryPart = await generateReportSummaryPart(
        {
          name: state.input.name,
          gender: state.input.gender,
          calendar: state.input.calendar,
          birth: state.input.birth,
          saju: {
            fourPillarsKorean: state.saju.fourPillars.korean,
            fourPillarsHanja: state.saju.fourPillars.hanja,
            fullKorean: state.saju.fourPillars.fullKorean,
            fullHanja: state.saju.fourPillars.fullHanja,
            dayElement: state.saju.dayElement,
            dayYinYang: state.saju.dayYinYang,
          },
        },
        debugCapture,
      );

      state.report.title = summaryPart.title;
      state.report.summary = summaryPart.summary;
      state.stage = "sections";
      state.completedSteps += 1;
    } else if (state.stage === "sections") {
      const batch = await generateReportSectionsBatchPart(
        {
          name: state.input.name,
          gender: state.input.gender,
          calendar: state.input.calendar,
          birth: state.input.birth,
          saju: {
            fourPillarsKorean: state.saju.fourPillars.korean,
            fourPillarsHanja: state.saju.fourPillars.hanja,
            fullKorean: state.saju.fourPillars.fullKorean,
            fullHanja: state.saju.fourPillars.fullHanja,
            dayElement: state.saju.dayElement,
            dayYinYang: state.saju.dayYinYang,
          },
        },
        state.nextSectionBatchIndex,
        debugCapture,
      );

      state.report.sections.push(...batch.sections);
      state.nextSectionBatchIndex += 1;
      state.completedSteps += 1;

      if (state.nextSectionBatchIndex >= sectionBatches.length) {
        state.stage = "tail";
      }
    } else if (state.stage === "tail") {
      const tailPart = await generateReportTailPart(
        {
          name: state.input.name,
          gender: state.input.gender,
          calendar: state.input.calendar,
          birth: state.input.birth,
          saju: {
            fourPillarsKorean: state.saju.fourPillars.korean,
            fourPillarsHanja: state.saju.fourPillars.hanja,
            fullKorean: state.saju.fourPillars.fullKorean,
            fullHanja: state.saju.fourPillars.fullHanja,
            dayElement: state.saju.dayElement,
            dayYinYang: state.saju.dayYinYang,
          },
        },
        debugCapture,
      );

      state.report.elementBalance = tailPart.elementBalance;
      state.report.disclaimer = tailPart.disclaimer;
      state.stage = "render";
      state.completedSteps += 1;
    }

    if (!enteredAsRenderStage) {
      const progressPercent = progressOf(state, totalSteps);
      const response: Record<string, unknown> = {
        status: "processing",
        stage: state.stage,
        completedSteps: state.completedSteps,
        totalSteps,
        progressPercent,
        jobToken: encodeAsyncStateToken(state, expectedSecret),
      };
      if (includeDebugOutput && stepTraces.length > 0) {
        response.debug = { traces: stepTraces };
      }
      return NextResponse.json(response);
    }

    const report = reportContentSchema.parse({
      title: state.report.title || "",
      summary: state.report.summary || {
        oneLine: "",
        keywords: [],
        highlights: [],
      },
      sections: state.report.sections,
      elementBalance: state.report.elementBalance || { analysis: "", tips: [] },
      disclaimer: state.report.disclaimer || "",
    });

    const backgroundImageUrl = state.backgroundImageUrl || (await resolveReportBackgroundImageUrl());
    const footerLogoUrl = state.footerLogoUrl || (await resolveReportFooterLogoUrl());

    const renderer = resolvePdfRenderer();
    const strictRenderer = isStrictRendererMode();
    let pdfBytes: Uint8Array;
    let rendererUsed: "html" | "typst" = "html";

    if (renderer === "typst") {
      try {
        pdfBytes = await renderPdfFromTypst({
          name: state.input.name,
          gender: state.input.gender,
          calendarLabel: state.calendarLabel,
          birthLabel: state.birthLabel,
          saju: state.saju,
          report,
        });
        rendererUsed = "typst";
      } catch (err) {
        if (strictRenderer) throw err;
        const htmlFallback = renderReportHtml({
          name: state.input.name,
          gender: state.input.gender,
          calendarLabel: state.calendarLabel,
          birthLabel: state.birthLabel,
          backgroundImageUrl,
          footerLogoUrl,
          saju: state.saju,
          report,
        });
        pdfBytes = await renderPdfFromHtml({ html: htmlFallback });
      }
    } else {
      const html = renderReportHtml({
        name: state.input.name,
        gender: state.input.gender,
        calendarLabel: state.calendarLabel,
        birthLabel: state.birthLabel,
        backgroundImageUrl,
        footerLogoUrl,
        saju: state.saju,
        report,
      });
      pdfBytes = await renderPdfFromHtml({ html });
    }
    const pdfBase64 = Buffer.from(pdfBytes).toString("base64");
    const fileName = sanitizeFileName(`${state.input.name}_saju.pdf`);

    const payload: Record<string, unknown> = {
      status: "completed",
      fileName,
      pdfBase64,
      meta: {
        renderer: rendererUsed,
        fourPillarsKorean: state.saju.fourPillars.korean,
        fourPillarsHanja: state.saju.fourPillars.hanja,
        dayElement: state.saju.dayElement,
        dayYinYang: state.saju.dayYinYang,
      },
    };
    if (includeDebugOutput) {
      payload.debug = { traces: stepTraces, report };
    }
    return NextResponse.json(payload);
  } catch (err) {
    if (err instanceof LlmRequestError) {
      if (err.status === 429) {
        const providerLabel = err.provider === "openai" ? "OpenAI" : "Gemini";
        return NextResponse.json(
          {
            error: `${err.provider}_quota_exceeded`,
            message: `${providerLabel} API quota exceeded. Check API key project quota/billing.`,
            retryDelaySeconds: err.retryDelaySeconds,
            details: err.details,
          },
          { status: 429 },
        );
      }

      return NextResponse.json(
        {
          error: `${err.provider}_request_failed`,
          message: err.message,
          details: err.details,
        },
        { status: err.status >= 400 && err.status < 600 ? err.status : 502 },
      );
    }

    const message = err instanceof Error ? err.message : "unknown_error";
    return NextResponse.json({ error: "server_error", message }, { status: 500 });
  }
}
