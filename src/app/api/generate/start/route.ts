import { NextResponse } from "next/server";

import {
  encodeAsyncStateToken,
  generateRequestSchema,
  getAsyncTotalSteps,
  type AsyncGenerateState,
} from "@/lib/asyncJob";
import { mustGetEnv } from "@/lib/env";
import { getReportSectionBatches } from "@/lib/llm";
import { computeSaju } from "@/lib/saju";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  try {
    const isDev = process.env.NODE_ENV !== "production";
    const expectedSecret = isDev ? "dev" : mustGetEnv("WEBHOOK_SECRET");
    if (!isDev) {
      const providedSecret = req.headers.get("x-webhook-secret") || "";
      if (providedSecret !== expectedSecret) {
        return NextResponse.json({ error: "unauthorized" }, { status: 401 });
      }
    }

    const json = await req.json();
    const parsed = generateRequestSchema.safeParse(json);
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

    const state: AsyncGenerateState = {
      version: 1,
      createdAt: new Date().toISOString(),
      stage: "summary",
      completedSteps: 0,
      nextSectionBatchIndex: 0,
      input,
      birthLabel,
      calendarLabel,
      saju,
      report: {
        sections: [],
      },
    };

    const sectionBatchCount = getReportSectionBatches().length;
    const totalSteps = getAsyncTotalSteps(sectionBatchCount);

    return NextResponse.json({
      status: "processing",
      stage: state.stage,
      completedSteps: 0,
      totalSteps,
      progressPercent: 0,
      jobToken: encodeAsyncStateToken(state, expectedSecret),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown_error";
    return NextResponse.json({ error: "server_error", message }, { status: 500 });
  }
}
