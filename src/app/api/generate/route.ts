import { NextResponse } from "next/server";
import { z } from "zod";

import { isAuthorizedRequest } from "@/lib/auth";
import { getOptionalEnv, mustGetEnv } from "@/lib/env";
import { generateFallbackHtml } from "@/lib/fallbackHtml";
import {
  LlmRequestError,
  type LlmDebugTrace,
  generateReportContentWithLlm,
} from "@/lib/llm";
import { renderPdfFromHtml } from "@/lib/pdf";
import { isStrictRendererMode, resolvePdfRenderer } from "@/lib/pdfRenderer";
import { resolveReportBackgroundImageUrl, resolveReportFooterLogoUrl } from "@/lib/reportBackground";
import { renderReportHtml } from "@/lib/reportTemplate";
import { computeSaju } from "@/lib/saju";
import { renderPdfFromTypst } from "@/lib/typst";
import { optionalGenderSchema } from "@/lib/asyncJob";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const birthSchema = z.object({
  year: z.number().int().min(1900).max(2100),
  month: z.number().int().min(1).max(12),
  day: z.number().int().min(1).max(31),
  hour: z.number().int().min(0).max(23),
  minute: z.number().int().min(0).max(59),
});

const requestSchema = z.object({
  name: z.string().min(1).max(50),
  gender: optionalGenderSchema,
  calendar: z.enum(["solar", "lunar"]),
  birth: birthSchema,
  isLeapMonth: z.boolean().optional(),
  llm: z.object({
    provider: z.enum(["openai", "gemini"]),
    model: z.string().min(1).max(80).optional(),
  }).optional(),
});

function sanitizeFileName(name: string): string {
  // Keep it Drive-friendly but readable in Korean too.
  return name.replace(/[\\/:*?"<>|]/g, "_").trim();
}

export async function POST(req: Request) {
  try {
    const isDev = process.env.NODE_ENV !== "production";
    if (!isAuthorizedRequest(req)) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    if (!mustGetEnv("WEBHOOK_SECRET")) {
      return NextResponse.json({ error: "server_error", message: "Missing WEBHOOK_SECRET" }, { status: 500 });
    }

    const json = await req.json();
    const parsed = requestSchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "invalid_request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const input = parsed.data;
    const saju = computeSaju({
      calendar: input.calendar,
      birth: input.birth,
      isLeapMonth: input.isLeapMonth,
    });

    const birthLabel = `${input.birth.year}-${String(input.birth.month).padStart(2, "0")}-${String(
      input.birth.day,
    ).padStart(2, "0")} ${String(input.birth.hour).padStart(2, "0")}:${String(
      input.birth.minute,
    ).padStart(2, "0")}`;

    const calendarLabel = input.calendar === "lunar" ? "음력" : "양력";
    const backgroundImageUrl = await resolveReportBackgroundImageUrl();
    const footerLogoUrl = await resolveReportFooterLogoUrl();
    const sectionDividerImageUrl = getOptionalEnv("REPORT_SECTION_DIVIDER_IMAGE_URL");
    const assetBaseUrl = new URL(req.url).origin;
    const skipLlm = process.env.SKIP_LLM === "true" || process.env.SKIP_GEMINI === "true";
    const includeDebugOutput = isDev || process.env.REPORT_DEBUG_OUTPUT === "true";
    const llmDebugTraces: LlmDebugTrace[] = [];
    let report;

    if (!skipLlm) {
      report = await generateReportContentWithLlm(
        {
          name: input.name,
          gender: input.gender,
          calendar: input.calendar,
          birth: input.birth,
          saju: {
            fourPillarsKorean: saju.fourPillars.korean,
            fourPillarsHanja: saju.fourPillars.hanja,
            fullKorean: saju.fourPillars.fullKorean,
            fullHanja: saju.fourPillars.fullHanja,
            dayElement: saju.dayElement,
            dayYinYang: saju.dayYinYang,
          },
        },
        includeDebugOutput
          ? (trace) => {
            llmDebugTraces.push(trace);
          }
          : undefined,
        input.llm,
      );
    }

    const renderer = resolvePdfRenderer();
    const strictRenderer = isStrictRendererMode();
    let pdfBytes: Uint8Array;
    let rendererUsed: "html" | "typst" = "html";

    if (renderer === "typst" && report) {
      try {
        pdfBytes = await renderPdfFromTypst({
          name: input.name,
          gender: input.gender,
          calendarLabel,
          birthLabel,
          saju,
          report,
        });
        rendererUsed = "typst";
      } catch (err) {
        if (strictRenderer) throw err;
        const htmlFallback = await renderReportHtml({
          name: input.name,
          gender: input.gender,
          calendarLabel,
          birthLabel,
          assetBaseUrl,
          backgroundImageUrl,
          footerLogoUrl,
          sectionDividerImageUrl,
          saju,
          report,
        });
        pdfBytes = await renderPdfFromHtml({ html: htmlFallback });
      }
    } else {
      const html =
        skipLlm
          ? generateFallbackHtml({
              name: input.name,
              gender: input.gender,
              calendarLabel,
              birthLabel,
              backgroundImageUrl,
              footerLogoUrl,
              saju,
            })
          : await renderReportHtml({
              name: input.name,
              gender: input.gender,
              calendarLabel,
              birthLabel,
              assetBaseUrl,
              backgroundImageUrl,
              footerLogoUrl,
              sectionDividerImageUrl,
              saju,
              report: report!,
            });
      pdfBytes = await renderPdfFromHtml({ html });
    }

    const pdfBase64 = Buffer.from(pdfBytes).toString("base64");
    const fileName = sanitizeFileName(`${input.name}의 사주결과.pdf`);

    const payload: Record<string, unknown> = {
      fileName,
      pdfBase64,
      meta: {
        renderer: rendererUsed,
        llm: input.llm || null,
        fourPillarsKorean: saju.fourPillars.korean,
        fourPillarsHanja: saju.fourPillars.hanja,
        dayElement: saju.dayElement,
        dayYinYang: saju.dayYinYang,
      },
    };

    if (includeDebugOutput && llmDebugTraces.length > 0 && report) {
      payload.debug = {
        traces: llmDebugTraces,
        report,
      };
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
