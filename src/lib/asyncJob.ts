import { createHmac, timingSafeEqual } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

import { z } from "zod";

import type { LlmDebugTrace } from "@/lib/llm";
import type { ReportContent } from "@/lib/reportSchema";
import type { SajuResult } from "@/lib/saju";

const birthSchema = z.object({
  year: z.number().int().min(1900).max(2100),
  month: z.number().int().min(1).max(12),
  day: z.number().int().min(1).max(31),
  hour: z.number().int().min(0).max(23),
  minute: z.number().int().min(0).max(59),
});

export const generateRequestSchema = z.object({
  name: z.string().min(1).max(50),
  gender: z.string().min(1).max(20),
  calendar: z.enum(["solar", "lunar"]),
  birth: birthSchema,
  isLeapMonth: z.boolean().optional(),
});

export type GenerateRequestInput = z.infer<typeof generateRequestSchema>;

export type AsyncStage = "summary" | "sections" | "tail" | "render";

export type AsyncReportPartial = {
  title?: ReportContent["title"];
  summary?: ReportContent["summary"];
  sections: ReportContent["sections"];
  elementBalance?: ReportContent["elementBalance"];
  disclaimer?: ReportContent["disclaimer"];
};

export type AsyncGenerateState = {
  version: 1;
  createdAt: string;
  stage: AsyncStage;
  completedSteps: number;
  nextSectionBatchIndex: number;
  input: GenerateRequestInput;
  birthLabel: string;
  calendarLabel: string;
  saju: SajuResult;
  backgroundImageUrl?: string;
  footerLogoUrl?: string;
  report: AsyncReportPartial;
  llmDebugTraces?: LlmDebugTrace[];
};

function toBase64Url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromBase64Url(value: string): Buffer {
  const base64 = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Buffer.from(base64, "base64");
}

function signPayload(payload: string, secret: string): string {
  const signature = createHmac("sha256", secret).update(payload).digest();
  return toBase64Url(signature);
}

export function encodeAsyncStateToken(state: AsyncGenerateState, secret: string): string {
  const raw = Buffer.from(JSON.stringify(state), "utf8");
  const compressed = gzipSync(raw, { level: 9 });
  const payload = toBase64Url(compressed);
  const signature = signPayload(payload, secret);
  return `${payload}.${signature}`;
}

export function decodeAsyncStateToken(token: string, secret: string): AsyncGenerateState {
  const parts = token.split(".");
  if (parts.length !== 2) {
    throw new Error("invalid_token_format");
  }

  const [payload, signature] = parts;
  const expected = signPayload(payload, secret);
  const expectedBuf = Buffer.from(expected);
  const givenBuf = Buffer.from(signature);
  if (expectedBuf.length !== givenBuf.length || !timingSafeEqual(expectedBuf, givenBuf)) {
    throw new Error("invalid_token_signature");
  }

  const compressed = fromBase64Url(payload);
  const json = gunzipSync(compressed).toString("utf8");
  const parsed = JSON.parse(json) as AsyncGenerateState;

  if (parsed.version !== 1) {
    throw new Error("unsupported_token_version");
  }

  return parsed;
}

export function getAsyncTotalSteps(sectionBatchCount: number): number {
  // summary + each section batch + tail + render
  return sectionBatchCount + 3;
}
