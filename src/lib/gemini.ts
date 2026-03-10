import { z } from "zod";

import { mustGetEnv } from "@/lib/env";
import { reportContentSchema, type ReportContent } from "@/lib/reportSchema";

export type GeminiGenerateHtmlInput = {
  name: string;
  gender: string;
  calendar: "solar" | "lunar";
  birth: { year: number; month: number; day: number; hour: number; minute: number };
  saju: {
    fourPillarsKorean: { year: string; month: string; day: string; hour: string };
    fourPillarsHanja: {
      year: { korean: string; hanja: string };
      month: { korean: string; hanja: string };
      day: { korean: string; hanja: string };
      hour: { korean: string; hanja: string };
    };
    fullKorean: string;
    fullHanja: string;
    dayElement: { stem: string; branch: string };
    dayYinYang: { stem: string; branch: string };
  };
};

type GeminiGenerateContentResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
};

type OpenAiChatCompletionsResponse = {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
};

type LlmProvider = "gemini" | "openai";
type RequestedProvider = "gemini" | "openai";
type LlmDebugCapture = (trace: LlmDebugTrace) => void;

type SectionBlueprint = {
  number: number;
  title: string;
  scoreLabel: string;
};

type ReportSection = ReportContent["sections"][number];

type RawProviderResponse = {
  provider: LlmProvider;
  model: string;
  raw: string;
};

const SECTION_BLUEPRINTS: SectionBlueprint[] = [
  { number: 1, title: "사주풀이", scoreLabel: "종합 운명 점수" },
  { number: 2, title: "대운(大運)", scoreLabel: "대운 흐름 점수" },
  { number: 3, title: "세운(歲運)", scoreLabel: "세운 반응 점수" },
  { number: 4, title: "신년운세 및 월운(月運)", scoreLabel: "단기 운세 점수" },
  { number: 5, title: "12운성", scoreLabel: "기동 에너지 점수" },
  { number: 6, title: "12신살 & 천을귀인 여부", scoreLabel: "귀인 조력 점수" },
  { number: 7, title: "기타 신살 풀이", scoreLabel: "신살 활용 점수" },
  { number: 8, title: "십성(十星)", scoreLabel: "사회성 점수" },
  { number: 9, title: "재운(재물운)", scoreLabel: "재물 획득 점수" },
  { number: 10, title: "관운(직업운)", scoreLabel: "사회적 성취 점수" },
  { number: 11, title: "애정운(부부운)", scoreLabel: "배우자 복 점수" },
  { number: 12, title: "자녀운", scoreLabel: "자녀 인연 점수" },
  { number: 13, title: "건강운", scoreLabel: "생체 활력 점수" },
  { number: 14, title: "이동운(이직, 이사운)", scoreLabel: "변화 적응 점수" },
];

const summarySchema = z.object({
  title: z.string().min(1).max(80),
  summary: z.object({
    oneLine: z.string().min(1).max(200),
    keywords: z.array(z.string().min(1).max(30)).min(6).max(12),
    highlights: z.array(z.string().min(1).max(120)).min(4).max(10),
  }),
});

const sectionChunkSchema = z.object({
  sections: z
    .array(
      z.object({
        heading: z.string().min(1).max(120),
        bullets: z.array(z.string().min(1).max(400)).min(1).max(20),
      }),
    )
    .min(1)
    .max(14),
});

const tailSchema = z.object({
  elementBalance: z.object({
    analysis: z.string().min(1).max(900),
    tips: z.array(z.string().min(1).max(180)).min(4).max(10),
  }),
  disclaimer: z.string().min(1).max(300),
});

export type LlmDebugTrace = {
  provider: LlmProvider;
  model: string;
  stage: string;
  prompt: string;
  raw: string;
};

export class LlmRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly provider: LlmProvider,
    readonly retryDelaySeconds?: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "LlmRequestError";
  }
}

function resolveRequestedProvider(): RequestedProvider {
  const raw = (process.env.LLM_PROVIDER || "gemini").toLowerCase();
  return raw === "openai" ? "openai" : "gemini";
}

function getSectionBlueprint(number: number): SectionBlueprint {
  const found = SECTION_BLUEPRINTS[number - 1];
  if (!found) {
    throw new Error(`Invalid section number: ${number}`);
  }
  return found;
}

function sectionHeadingExample(blueprint: SectionBlueprint): string {
  return `${String(blueprint.number).padStart(2, "0")}. ${blueprint.title} [${
    blueprint.scoreLabel
  }: NN/100]`;
}

function sectionHeadingFallback(blueprint: SectionBlueprint): string {
  return `${String(blueprint.number).padStart(2, "0")}. ${blueprint.title} [${
    blueprint.scoreLabel
  }: 70/100]`;
}

function buildContextBlock(input: GeminiGenerateHtmlInput): string {
  const birthLabel = `${input.birth.year}-${String(input.birth.month).padStart(2, "0")}-${String(
    input.birth.day,
  ).padStart(2, "0")} ${String(input.birth.hour).padStart(2, "0")}:${String(input.birth.minute).padStart(2, "0")}`;

  const calLabel = input.calendar === "lunar" ? "음력" : "양력";

  return [
    "# 역할: 세계 최고의 명리 분석가 및 운명 데이터 아키텍트",
    "당신은 세계 최고 수준의 사주팔자 명리학 전문가입니다.",
    "고전 명리 근거와 현대적 실천 조언을 함께 제시하세요.",
    "",
    "## 사용자",
    `- 이름: ${input.name}`,
    `- 성별: ${input.gender}`,
    `- 생년월일/시간: ${birthLabel} (${calLabel})`,
    "",
    "## 사주팔자(만세력 결과)",
    `- 한글: ${input.saju.fullKorean}`,
    `- 한자: ${input.saju.fullHanja}`,
    `- 오행(일간/일지): 천간=${input.saju.dayElement.stem}, 지지=${input.saju.dayElement.branch}`,
    `- 음양(일간/일지): 천간=${input.saju.dayYinYang.stem}, 지지=${input.saju.dayYinYang.branch}`,
  ].join("\n");
}

export function buildReportPrompt(input: GeminiGenerateHtmlInput): string {
  const sectionLines = SECTION_BLUEPRINTS.map((bp) => `- ${sectionHeadingExample(bp)}`).join("\n");
  return [
    buildContextBlock(input),
    "",
    "## 전체 목차(14개)",
    sectionLines,
    "",
    "## 출력 형식",
    "- 반드시 JSON만 출력하세요.",
    "- title/summary/sections(14)/elementBalance/disclaimer를 모두 포함하세요.",
  ].join("\n");
}

function extractJsonObject(raw: string): string {
  let text = raw.trim();

  const fenceStart = text.indexOf("```");
  if (fenceStart !== -1) {
    const fenceEnd = text.lastIndexOf("```");
    if (fenceEnd !== -1 && fenceEnd > fenceStart) {
      text = text.slice(fenceStart + 3, fenceEnd).trim();
      if (/^json\b/i.test(text)) text = text.replace(/^json\b/i, "").trim();
    }
  }

  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) {
    throw new Error("LLM did not return a JSON object");
  }
  return text.slice(first, last + 1);
}

function parseWithSchema<T>(
  raw: string,
  schema: z.ZodType<T>,
  provider: LlmProvider,
  stage: string,
): T {
  try {
    const jsonText = extractJsonObject(raw);
    const obj = JSON.parse(jsonText) as unknown;
    return schema.parse(obj);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown_parse_error";
    throw new LlmRequestError(
      `${provider.toUpperCase()} returned invalid JSON (${stage}): ${message}`,
      502,
      provider,
      undefined,
      {
        stage,
        parseError: message,
        rawLength: raw.length,
        rawPreview: raw.slice(0, 2000),
      },
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestRawFromOpenAI(
  prompt: string,
  maxTokens: number,
): Promise<RawProviderResponse> {
  const apiKey = mustGetEnv("OPENAI_API_KEY");
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content:
            "You write Korean saju reports. Return valid JSON only. No markdown fences or explanations.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
      response_format: { type: "json_object" },
      temperature: 0.6,
      max_tokens: maxTokens,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let parsed: unknown;
    let errorMessage = text;
    try {
      const parsedBody = JSON.parse(text) as { error?: { message?: string } };
      parsed = parsedBody;
      if (typeof parsedBody.error?.message === "string") {
        errorMessage = parsedBody.error.message;
      }
    } catch {
      // Keep raw text if response body is not JSON.
    }

    throw new LlmRequestError(
      `OpenAI request failed: ${res.status} ${res.statusText} ${errorMessage}`,
      res.status,
      "openai",
      undefined,
      parsed,
    );
  }

  const data = (await res.json()) as OpenAiChatCompletionsResponse;
  const raw = data.choices?.[0]?.message?.content?.trim();
  if (!raw) {
    throw new Error("OpenAI returned empty content");
  }

  return { provider: "openai", model, raw };
}

async function requestRawFromGemini(
  prompt: string,
  maxOutputTokens: number,
): Promise<RawProviderResponse> {
  const apiKey = mustGetEnv("GEMINI_API_KEY");
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model,
  )}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }],
        },
      ],
      generationConfig: {
        temperature: 0.6,
        maxOutputTokens,
        responseMimeType: "application/json",
      },
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let errorMessage = text;
    let retryDelaySeconds: number | undefined;
    let parsed: unknown;

    try {
      parsed = JSON.parse(text) as {
        error?: {
          message?: string;
          details?: Array<{ "@type"?: string; retryDelay?: string }>;
        };
      };

      const messageFromBody =
        typeof parsed === "object" &&
          parsed !== null &&
          "error" in parsed &&
          typeof (parsed as { error?: { message?: string } }).error?.message === "string"
          ? (parsed as { error: { message: string } }).error.message
          : undefined;

      if (messageFromBody) {
        errorMessage = messageFromBody;
      }

      const details =
        typeof parsed === "object" &&
          parsed !== null &&
          "error" in parsed &&
          Array.isArray((parsed as { error?: { details?: unknown[] } }).error?.details)
          ? (parsed as { error: { details: Array<{ "@type"?: string; retryDelay?: string }> } })
            .error.details
          : [];

      const retryInfo = details.find(
        (d) => d?.["@type"] === "type.googleapis.com/google.rpc.RetryInfo",
      );
      const retryDelay = retryInfo?.retryDelay;
      if (typeof retryDelay === "string") {
        const parsedDelay = Number.parseInt(retryDelay, 10);
        if (Number.isFinite(parsedDelay)) {
          retryDelaySeconds = parsedDelay;
        }
      }
    } catch {
      // Keep raw text if response body is not JSON.
    }

    throw new LlmRequestError(
      `Gemini request failed: ${res.status} ${res.statusText} ${errorMessage}`,
      res.status,
      "gemini",
      retryDelaySeconds,
      parsed,
    );
  }

  const data = (await res.json()) as GeminiGenerateContentResponse;
  const raw = data.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("")?.trim();
  if (!raw) {
    throw new Error("Gemini returned empty content");
  }

  return { provider: "gemini", model, raw };
}

async function requestRawFromProvider(
  provider: RequestedProvider,
  prompt: string,
  maxTokens: number,
): Promise<RawProviderResponse> {
  if (provider === "openai") {
    return requestRawFromOpenAI(prompt, maxTokens);
  }
  return requestRawFromGemini(prompt, maxTokens);
}

async function callProviderJsonWithRetry<T>(params: {
  provider: RequestedProvider;
  prompt: string;
  schema: z.ZodType<T>;
  stage: string;
  maxTokens: number;
  debugCapture?: LlmDebugCapture;
  maxAttempts?: number;
}): Promise<T> {
  const { provider, prompt, schema, stage, maxTokens, debugCapture, maxAttempts = 3 } = params;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const rawResult = await requestRawFromProvider(provider, prompt, maxTokens);
      debugCapture?.({
        provider: rawResult.provider,
        model: rawResult.model,
        stage: `${stage}:attempt${attempt}`,
        prompt,
        raw: rawResult.raw,
      });

      return parseWithSchema(rawResult.raw, schema, rawResult.provider, stage);
    } catch (err) {
      lastError = err;
      if (attempt >= maxAttempts) break;

      const retryDelayMs =
        err instanceof LlmRequestError && typeof err.retryDelaySeconds === "number"
          ? Math.min(err.retryDelaySeconds * 1000, 6000)
          : Math.min(400 * 2 ** (attempt - 1), 2500);
      await sleep(retryDelayMs);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("unknown_llm_error");
}

function buildSummaryPrompt(input: GeminiGenerateHtmlInput): string {
  return [
    buildContextBlock(input),
    "",
    "## 작업: 리포트 헤더 생성",
    "- title과 summary만 생성하세요.",
    "- JSON만 출력하세요.",
    "",
    "## 출력 제약",
    "- title: 80자 이내",
    "- summary.oneLine: 200자 이내",
    "- summary.keywords: 6~12개",
    "- summary.highlights: 4~10개",
    "",
    "## JSON 스키마",
    "{",
    '  "title": "string",',
    '  "summary": {',
    '    "oneLine": "string",',
    '    "keywords": ["string"],',
    '    "highlights": ["string"]',
    "  }",
    "}",
  ].join("\n");
}

function buildSectionsPrompt(input: GeminiGenerateHtmlInput, start: number, end: number): string {
  const blueprints = SECTION_BLUEPRINTS.slice(start - 1, end);
  const sectionLines = blueprints.map((bp) => `- ${sectionHeadingExample(bp)}`).join("\n");

  return [
    buildContextBlock(input),
    "",
    `## 작업: sections ${start}~${end} 생성`,
    "- 아래 목차만 생성하세요.",
    "- heading은 목차 번호/항목명/점수 형식을 유지하세요.",
    "- 각 bullets는 8~12개, 각 문장은 120~220자로 작성하세요.",
    "- JSON만 출력하세요.",
    "",
    "## 목차",
    sectionLines,
    "",
    "## JSON 스키마",
    "{",
    '  "sections": [',
    '    { "heading": "string", "bullets": ["string"] }',
    "  ]",
    "}",
  ].join("\n");
}

function buildSectionsCompactPrompt(input: GeminiGenerateHtmlInput, start: number, end: number): string {
  const blueprints = SECTION_BLUEPRINTS.slice(start - 1, end);
  const sectionLines = blueprints.map((bp) => `- ${sectionHeadingExample(bp)}`).join("\n");

  return [
    buildContextBlock(input),
    "",
    `## 긴급 작업: sections ${start}~${end} 축약 생성`,
    "- 반드시 유효한 JSON만 출력하세요.",
    "- 각 section은 bullets 4~6개로 작성하세요.",
    "- 각 bullet은 80~140자 문장으로 작성하세요.",
    "",
    "## 목차",
    sectionLines,
    "",
    "## JSON 스키마",
    "{",
    '  "sections": [',
    '    { "heading": "string", "bullets": ["string"] }',
    "  ]",
    "}",
  ].join("\n");
}

function buildTailPrompt(input: GeminiGenerateHtmlInput): string {
  return [
    buildContextBlock(input),
    "",
    "## 작업: elementBalance/disclaimer 생성",
    "- elementBalance.analysis, elementBalance.tips, disclaimer만 생성하세요.",
    "- JSON만 출력하세요.",
    "",
    "## JSON 스키마",
    "{",
    '  "elementBalance": {',
    '    "analysis": "string",',
    '    "tips": ["string"]',
    "  },",
    '  "disclaimer": "string"',
    "}",
  ].join("\n");
}

function normalizeHeading(rawHeading: string, blueprint: SectionBlueprint): string {
  const expectedPrefix = `${String(blueprint.number).padStart(2, "0")}. `;
  let heading = rawHeading.replace(/\s+/g, " ").trim();

  if (!heading) {
    return sectionHeadingFallback(blueprint);
  }

  if (/^\d{1,2}\.\s/.test(heading)) {
    heading = heading.replace(/^\d{1,2}\.\s/, expectedPrefix);
  } else if (!heading.startsWith(expectedPrefix)) {
    heading = `${expectedPrefix}${heading}`;
  }

  if (!/\[.*\d{1,3}\/100\]/.test(heading)) {
    heading = `${heading} [${blueprint.scoreLabel}: 70/100]`;
  }

  if (heading.length > 80) {
    heading = heading.slice(0, 80).trim();
  }

  return heading;
}

function fallbackBullet(blueprint: SectionBlueprint): string {
  return `${blueprint.title}은 시기별 강약이 분명하므로, 성급한 확정보다 기록과 점검을 반복하며 대응하면 변동성 속에서도 안정적인 결과를 만들 수 있습니다.`;
}

function normalizeBullets(rawBullets: string[], blueprint: SectionBlueprint): string[] {
  const cleaned = rawBullets
    .map((b) => b.replace(/\s+/g, " ").trim())
    .filter((b) => b.length > 0)
    .map((b) => (b.length > 220 ? `${b.slice(0, 217)}...` : b));

  while (cleaned.length < 4) {
    cleaned.push(fallbackBullet(blueprint));
  }

  return cleaned.slice(0, 12);
}

function normalizeSection(section: { heading: string; bullets: string[] }, sectionNumber: number): ReportSection {
  const blueprint = getSectionBlueprint(sectionNumber);
  return {
    heading: normalizeHeading(section.heading, blueprint),
    bullets: normalizeBullets(section.bullets, blueprint),
  };
}

async function generateSummary(
  provider: RequestedProvider,
  input: GeminiGenerateHtmlInput,
  debugCapture?: LlmDebugCapture,
): Promise<z.infer<typeof summarySchema>> {
  const prompt = buildSummaryPrompt(input);
  return callProviderJsonWithRetry({
    provider,
    prompt,
    schema: summarySchema,
    stage: "summary",
    maxTokens: 2200,
    debugCapture,
    maxAttempts: 3,
  });
}

async function generateTail(
  provider: RequestedProvider,
  input: GeminiGenerateHtmlInput,
  debugCapture?: LlmDebugCapture,
): Promise<z.infer<typeof tailSchema>> {
  const prompt = buildTailPrompt(input);
  return callProviderJsonWithRetry({
    provider,
    prompt,
    schema: tailSchema,
    stage: "tail",
    maxTokens: 3200,
    debugCapture,
    maxAttempts: 3,
  });
}

async function generateSectionRangeDirect(
  provider: RequestedProvider,
  input: GeminiGenerateHtmlInput,
  start: number,
  end: number,
  compactMode: boolean,
  debugCapture?: LlmDebugCapture,
): Promise<ReportSection[]> {
  const prompt = compactMode
    ? buildSectionsCompactPrompt(input, start, end)
    : buildSectionsPrompt(input, start, end);
  const expectedCount = end - start + 1;

  const parsed = await callProviderJsonWithRetry({
    provider,
    prompt,
    schema: sectionChunkSchema,
    stage: compactMode ? `sections:${start}-${end}:compact` : `sections:${start}-${end}`,
    maxTokens: compactMode ? 2600 : 6200,
    debugCapture,
    maxAttempts: compactMode ? 2 : 3,
  });

  if (parsed.sections.length !== expectedCount) {
    throw new LlmRequestError(
      `Section count mismatch for ${start}-${end}: expected ${expectedCount}, got ${parsed.sections.length}`,
      502,
      provider,
      undefined,
      {
        start,
        end,
        expectedCount,
        actualCount: parsed.sections.length,
      },
    );
  }

  return parsed.sections.map((section, idx) => normalizeSection(section, start + idx));
}

async function generateSectionsSafely(
  provider: RequestedProvider,
  input: GeminiGenerateHtmlInput,
  start: number,
  end: number,
  debugCapture?: LlmDebugCapture,
): Promise<ReportSection[]> {
  try {
    return await generateSectionRangeDirect(provider, input, start, end, false, debugCapture);
  } catch (err) {
    if (start < end) {
      const mid = Math.floor((start + end) / 2);
      const left = await generateSectionsSafely(provider, input, start, mid, debugCapture);
      const right = await generateSectionsSafely(provider, input, mid + 1, end, debugCapture);
      return [...left, ...right];
    }

    if (!(err instanceof LlmRequestError)) {
      throw err;
    }

    return generateSectionRangeDirect(provider, input, start, end, true, debugCapture);
  }
}

function buildSectionBatches(): Array<[number, number]> {
  return [
    [1, 6],
    [7, 10],
    [11, 14],
  ];
}

export async function generateReportContentWithGemini(
  input: GeminiGenerateHtmlInput,
  debugCapture?: LlmDebugCapture,
): Promise<ReportContent> {
  const requestedProvider = resolveRequestedProvider();

  const summaryPart = await generateSummary(requestedProvider, input, debugCapture);

  const sectionChunks = await Promise.all(
    buildSectionBatches().map(([start, end]) =>
      generateSectionsSafely(requestedProvider, input, start, end, debugCapture),
    ),
  );
  const sections = sectionChunks.flat();

  const tailPart = await generateTail(requestedProvider, input, debugCapture);

  const report = {
    title: summaryPart.title,
    summary: summaryPart.summary,
    sections,
    elementBalance: tailPart.elementBalance,
    disclaimer: tailPart.disclaimer,
  };

  return reportContentSchema.parse(report);
}
