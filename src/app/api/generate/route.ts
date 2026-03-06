import { NextResponse } from "next/server";
import { z } from "zod";

import { mustGetEnv } from "@/lib/env";
import { generateFallbackHtml } from "@/lib/fallbackHtml";
import { LlmRequestError, generateReportContentWithGemini } from "@/lib/gemini";
import { renderPdfFromHtml } from "@/lib/pdf";
import { renderReportHtml } from "@/lib/reportTemplate";
import { computeSaju } from "@/lib/saju";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const birthSchema = z.object({
  year: z.number().int().min(1900).max(2100),
  month: z.number().int().min(1).max(12),
  day: z.number().int().min(1).max(31),
  hour: z.number().int().min(0).max(23),
  minute: z.number().int().min(0).max(59),
});

const requestSchema = z.object({
  name: z.string().min(1).max(50),
  gender: z.string().min(1).max(20),
  calendar: z.enum(["solar", "lunar"]),
  birth: birthSchema,
  isLeapMonth: z.boolean().optional(),
});

function sanitizeFileName(name: string): string {
  // Keep it Drive-friendly but readable in Korean too.
  return name.replace(/[\\/:*?"<>|]/g, "_").trim();
}

export async function POST(req: Request) {
  try {
    const expectedSecret = mustGetEnv("WEBHOOK_SECRET");
    const providedSecret = req.headers.get("x-webhook-secret") || "";
    if (providedSecret !== expectedSecret) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
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

    const html =
      process.env.SKIP_GEMINI === "true"
        ? generateFallbackHtml({
            name: input.name,
            gender: input.gender,
            calendarLabel,
            birthLabel,
            saju,
          })
        : renderReportHtml({
            name: input.name,
            gender: input.gender,
            calendarLabel,
            birthLabel,
            coverImageUrl: process.env.REPORT_COVER_IMAGE_URL,
            saju,
            report: await generateReportContentWithGemini({
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
            }),
          });

    const pdfBytes = await renderPdfFromHtml({
      html,
    });

    const pdfBase64 = Buffer.from(pdfBytes).toString("base64");
    const fileName = sanitizeFileName(`${input.name}_saju.pdf`);

    return NextResponse.json({
      fileName,
      pdfBase64,
      meta: {
        fourPillarsKorean: saju.fourPillars.korean,
        fourPillarsHanja: saju.fourPillars.hanja,
        dayElement: saju.dayElement,
        dayYinYang: saju.dayYinYang,
      },
    });
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
