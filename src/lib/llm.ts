import { z } from "zod";

import { mustGetEnv } from "@/lib/env";
import { reportContentSchema, type ReportContent } from "@/lib/reportSchema";

export type LlmGenerateInput = {
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

export type ReportSection = ReportContent["sections"][number];

type RawProviderResponse = {
  provider: LlmProvider;
  model: string;
  raw: string;
};

const LLM_REQUEST_TIMEOUT_MS = Number(process.env.LLM_REQUEST_TIMEOUT_MS || "45000");

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

export type ReportSummaryPart = z.infer<typeof summarySchema>;
export type ReportTailPart = z.infer<typeof tailSchema>;
export type ReportSectionBatch = {
  batchIndex: number;
  start: number;
  end: number;
  sections: ReportSection[];
};

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
  const raw = (process.env.LLM_PROVIDER || "openai").toLowerCase();
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

function buildContextBlock(input: LlmGenerateInput): string {
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

export function buildReportPrompt(input: LlmGenerateInput): string {
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
  // gpt-5-mini: faster, cheaper. gpt-5.4: best quality, higher cost. See https://developers.openai.com/api/docs/models
  const model = process.env.OPENAI_MODEL || "gpt-5-mini-2025-08-07";

  const openAiController = new AbortController();
  const openAiTimeout = setTimeout(() => openAiController.abort(), LLM_REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch("https://api.openai.com/v1/chat/completions", {
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
      signal: openAiController.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new LlmRequestError(
        `OpenAI request timed out after ${LLM_REQUEST_TIMEOUT_MS}ms`,
        504,
        "openai",
      );
    }
    throw err;
  } finally {
    clearTimeout(openAiTimeout);
  }

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
  const model = process.env.GEMINI_MODEL || "gemini-3.1-flash";

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model,
  )}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const geminiController = new AbortController();
  const geminiTimeout = setTimeout(() => geminiController.abort(), LLM_REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
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
      signal: geminiController.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new LlmRequestError(
        `Gemini request timed out after ${LLM_REQUEST_TIMEOUT_MS}ms`,
        504,
        "gemini",
      );
    }
    throw err;
  } finally {
    clearTimeout(geminiTimeout);
  }

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

function buildSummaryPrompt(input: LlmGenerateInput): string {
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

function buildSectionsPrompt(input: LlmGenerateInput, start: number, end: number): string {
  const blueprints = SECTION_BLUEPRINTS.slice(start - 1, end);
  const sectionLines = blueprints.map((bp) => `- ${sectionHeadingExample(bp)}`).join("\n");

  return [
    buildContextBlock(input),
    "",
    `## 작업: sections ${start}~${end} 생성`,
    "- 아래 목차만 생성하세요.",
    "- heading은 목차 번호/항목명/점수 형식을 유지하세요.",
    "- 각 bullets는 10~14개, 각 문장은 150~280자로 풍부하게 작성하세요.",
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

function buildSectionsCompactPrompt(input: LlmGenerateInput, start: number, end: number): string {
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

function buildTailPrompt(input: LlmGenerateInput): string {
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
  const maxLen = 350;
  const cleaned = rawBullets
    .map((b) => b.replace(/\s+/g, " ").trim())
    .filter((b) => b.length > 0)
    .map((b) => (b.length > maxLen ? `${b.slice(0, maxLen - 3)}...` : b));

  while (cleaned.length < 6) {
    cleaned.push(fallbackBullet(blueprint));
  }

  return cleaned.slice(0, 16);
}

function normalizeSection(section: { heading: string; bullets: string[] }, sectionNumber: number): ReportSection {
  const blueprint = getSectionBlueprint(sectionNumber);
  return {
    heading: normalizeHeading(section.heading, blueprint),
    bullets: normalizeBullets(section.bullets, blueprint),
  };
}

function buildFallbackSummary(input: LlmGenerateInput): ReportSummaryPart {
  const dayStem = input.saju.dayElement.stem;
  const dayBranch = input.saju.dayElement.branch;
  return {
    title: `${input.name}님의 사주 종합 리포트`,
    summary: {
      oneLine: `${dayStem}/${dayBranch} 기운을 중심으로 강점과 리스크를 균형 있게 해석한 실전형 운세 가이드입니다.`,
      keywords: [
        "오행균형",
        "대운흐름",
        "연간변화",
        "재물관리",
        "직업성장",
        "관계조율",
      ],
      highlights: [
        "강한 추진력과 실행력이 장점이지만, 속도 조절이 성과 안정성에 중요합니다.",
        "기회가 들어오는 시점과 리스크 구간이 분명하므로 일정 관리가 핵심입니다.",
        "재정과 커리어는 단기 성과보다 지속 가능한 구조를 만들 때 상승 폭이 큽니다.",
        "관계운은 대화 방식과 기대치 조절에 따라 체감 운세 차이가 크게 나타납니다.",
      ],
    },
  };
}

function buildFallbackTail(): ReportTailPart {
  return {
    elementBalance: {
      analysis:
        "오행의 편중이 강할수록 특정 시기에는 성과가 빠르게 나타나지만, 반대 시기에는 피로와 시행착오가 늘 수 있습니다. 일정·수면·운동의 기본 루틴을 고정하면 운의 변동 폭을 줄이고 장기 성과를 안정화하는 데 도움이 됩니다.",
      tips: [
        "과로 누적을 막기 위해 주간 단위 휴식 시간을 먼저 캘린더에 고정하세요.",
        "소화·순환·근골격계 컨디션을 점검하고 이상 신호는 초기에 관리하세요.",
        "수면 시간을 일정하게 유지해 집중력 저하 구간을 최소화하세요.",
        "카페인·야식·과음 빈도를 줄여 회복 속도를 높이세요.",
      ],
    },
    disclaimer: "본 문서는 참고용 해석이며, 의학·법률·투자에 대한 확정적 조언이 아닙니다.",
  };
}

function buildFallbackReport(input: LlmGenerateInput): ReportContent {
  const summaryPart = buildFallbackSummary(input);
  const tailPart = buildFallbackTail();
  const sections = SECTION_BLUEPRINTS.map((bp) => buildFallbackSection(bp.number));
  return reportContentSchema.parse({
    title: summaryPart.title,
    summary: summaryPart.summary,
    sections,
    elementBalance: tailPart.elementBalance,
    disclaimer: tailPart.disclaimer,
  });
}

async function generateFullReport(
  provider: RequestedProvider,
  input: LlmGenerateInput,
  debugCapture?: LlmDebugCapture,
): Promise<ReportContent> {
  const prompt = buildReportPrompt(input);
  try {
    return await callProviderJsonWithRetry({
      provider,
      prompt,
      schema: reportContentSchema,
      stage: "full_report",
      maxTokens: 12000,
      debugCapture,
      maxAttempts: 1,
    });
  } catch (err) {
    if (err instanceof LlmRequestError) {
      return buildFallbackReport(input);
    }
    throw err;
  }
}

export function buildFallbackSection(sectionNumber: number): ReportSection {
  const blueprint = getSectionBlueprint(sectionNumber);
  return {
    heading: sectionHeadingFallback(blueprint),
    bullets: normalizeBullets(
      [
        `${blueprint.title}은 시기별 기복이 존재하므로, 결정 전 기준표를 두고 우선순위를 명확히 하면 실수를 줄일 수 있습니다.`,
        `중요한 선택은 단일 이벤트보다 흐름으로 해석해야 하며, ${blueprint.title}은 준비 구간과 실행 구간을 분리할 때 성과가 좋아집니다.`,
        `대인관계와 자원 배분의 균형을 맞추면 ${blueprint.title}의 체감 난이도가 낮아지고, 장기적으로 안정적인 결과를 기대할 수 있습니다.`,
        `변동성 구간에서는 보수적 운영이 유리하며, 기록 기반 점검을 통해 반복 리스크를 줄이는 전략이 효과적입니다.`,
      ],
      blueprint,
    ),
  };
}

async function generateSummary(
  provider: RequestedProvider,
  input: LlmGenerateInput,
  debugCapture?: LlmDebugCapture,
): Promise<z.infer<typeof summarySchema>> {
  const prompt = buildSummaryPrompt(input);
  try {
    return await callProviderJsonWithRetry({
      provider,
      prompt,
      schema: summarySchema,
      stage: "summary",
      maxTokens: 2200,
      debugCapture,
      maxAttempts: 3,
    });
  } catch (err) {
    if (err instanceof LlmRequestError) {
      return buildFallbackSummary(input);
    }
    throw err;
  }
}

async function generateTail(
  provider: RequestedProvider,
  input: LlmGenerateInput,
  debugCapture?: LlmDebugCapture,
): Promise<z.infer<typeof tailSchema>> {
  const prompt = buildTailPrompt(input);
  try {
    return await callProviderJsonWithRetry({
      provider,
      prompt,
      schema: tailSchema,
      stage: "tail",
      maxTokens: 3200,
      debugCapture,
      maxAttempts: 3,
    });
  } catch (err) {
    if (err instanceof LlmRequestError) {
      return buildFallbackTail();
    }
    throw err;
  }
}

async function generateSectionRangeDirect(
  provider: RequestedProvider,
  input: LlmGenerateInput,
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
    maxAttempts: compactMode ? 1 : 2,
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
  input: LlmGenerateInput,
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

    try {
      return await generateSectionRangeDirect(provider, input, start, end, true, debugCapture);
    } catch (compactErr) {
      if (start === end) {
        return [buildFallbackSection(start)];
      }
      throw compactErr;
    }
  }
}

/** Number of sections per LLM call (1 = one call per section, 3 = sections 1-3, 4-6, ...). Higher = fewer polls, but more tokens per call. */
const SECTION_BATCH_SIZE = Math.max(1, Math.min(14, Number(process.env.SECTION_BATCH_SIZE) || 3));

function buildSectionBatches(): Array<[number, number]> {
  if (SECTION_BATCH_SIZE <= 1) {
    return SECTION_BLUEPRINTS.map((bp) => [bp.number, bp.number] as [number, number]);
  }
  const result: Array<[number, number]> = [];
  for (let start = 1; start <= SECTION_BLUEPRINTS.length; start += SECTION_BATCH_SIZE) {
    const end = Math.min(start + SECTION_BATCH_SIZE - 1, SECTION_BLUEPRINTS.length);
    result.push([start, end] as [number, number]);
  }
  return result;
}

export function getReportSectionBatches(): Array<[number, number]> {
  return buildSectionBatches();
}

export async function generateReportSummaryPart(
  input: LlmGenerateInput,
  debugCapture?: LlmDebugCapture,
): Promise<ReportSummaryPart> {
  return generateSummary(resolveRequestedProvider(), input, debugCapture);
}

export async function generateReportSectionsBatchPart(
  input: LlmGenerateInput,
  batchIndex: number,
  debugCapture?: LlmDebugCapture,
): Promise<ReportSectionBatch> {
  const batches = buildSectionBatches();
  const range = batches[batchIndex];
  if (!range) {
    throw new Error(`Invalid batchIndex: ${batchIndex}`);
  }
  const [start, end] = range;
  const sections = await generateSectionsSafely(
    resolveRequestedProvider(),
    input,
    start,
    end,
    debugCapture,
  );
  return { batchIndex, start, end, sections };
}

export async function generateReportTailPart(
  input: LlmGenerateInput,
  debugCapture?: LlmDebugCapture,
): Promise<ReportTailPart> {
  return generateTail(resolveRequestedProvider(), input, debugCapture);
}

export async function generateReportContentWithLlm(
  input: LlmGenerateInput,
  debugCapture?: LlmDebugCapture,
): Promise<ReportContent> {
  const requestedProvider = resolveRequestedProvider();
  return generateFullReport(requestedProvider, input, debugCapture);
}

// Backward compatibility for existing imports.
export const generateReportContentWithGemini = generateReportContentWithLlm;
