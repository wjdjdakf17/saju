import { getOptionalEnv, mustGetEnv } from "@/lib/env";
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

function extractJsonObject(raw: string): string {
  let text = raw.trim();

  // Strip markdown fences if present.
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
    throw new Error("Gemini did not return a JSON object");
  }
  return text.slice(first, last + 1);
}

function buildPrompt(input: GeminiGenerateHtmlInput): string {
  const birthLabel = `${input.birth.year}-${String(input.birth.month).padStart(2, "0")}-${String(
    input.birth.day,
  ).padStart(2, "0")} ${String(input.birth.hour).padStart(2, "0")}:${String(input.birth.minute).padStart(2, "0")}`;

  const calLabel = input.calendar === "lunar" ? "음력" : "양력";

  return [
    "당신은 한국 사주명리학 리포트를 작성하는 전문가입니다.",
    "아래 정보를 바탕으로, PDF에 들어갈 콘텐츠를 'JSON'으로만 작성하세요.",
    "",
    "## 출력 제약(매우 중요)",
    "- 반드시 JSON만 출력 (마크다운/설명/코드펜스/주석 금지)",
    "- 키 이름은 영어 camelCase로 고정",
    "- 문자열은 한국어로 자연스럽고 간결하게",
    "- 과장/확정적 단정 금지(참고용 톤)",
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
    "",
    "## JSON 스키마(반드시 준수)",
    "{",
    '  "title": "string",',
    '  "summary": {',
    '    "oneLine": "string",',
    '    "keywords": ["string", "... 4~8개"],',
    '    "highlights": ["string", "... 2~6개"]',
    "  },",
    '  "sections": [',
    '    { "heading": "string", "bullets": ["string", "... 2~10개"] }',
    "  ],",
    '  "elementBalance": {',
    '    "analysis": "string",',
    '    "tips": ["string", "... 2~8개"]',
    "  },",
    '  "disclaimer": "참고용/의학·법률·투자 조언 아님 포함"',
    "}",
  ].join("\n");
}

async function generateReportContentWithOpenAI(input: GeminiGenerateHtmlInput): Promise<ReportContent> {
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
            "You are a Korean saju report writer. Return valid JSON only. Do not include markdown fences or explanations.",
        },
        {
          role: "user",
          content: buildPrompt(input),
        },
      ],
      response_format: { type: "json_object" },
      temperature: 0.7,
      max_tokens: 2500,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let parsed: unknown;
    let errorMessage = text;
    try {
      parsed = JSON.parse(text) as { error?: { message?: string } };
      if (typeof parsed?.error?.message === "string") {
        errorMessage = parsed.error.message;
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

  const jsonText = extractJsonObject(raw);
  const obj = JSON.parse(jsonText) as unknown;
  return reportContentSchema.parse(obj);
}

export async function generateReportContentWithGemini(
  input: GeminiGenerateHtmlInput,
): Promise<ReportContent> {
  const openAiKey = getOptionalEnv("OPENAI_API_KEY");
  if (openAiKey) {
    return generateReportContentWithOpenAI(input);
  }

  const apiKey = mustGetEnv("GEMINI_API_KEY");
  const model = process.env.GEMINI_MODEL || "gemini-2.0-flash";

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
          parts: [{ text: buildPrompt(input) }],
        },
      ],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 4096,
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

  const jsonText = extractJsonObject(raw);
  const obj = JSON.parse(jsonText) as unknown;
  return reportContentSchema.parse(obj);
}
