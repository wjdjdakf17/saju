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
type LlmDebugCapture = (trace: LlmDebugTrace) => void;
type RequestedProvider = "gemini" | "openai";

export type LlmDebugTrace = {
  provider: LlmProvider;
  model: string;
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
    throw new Error("LLM did not return a JSON object");
  }
  return text.slice(first, last + 1);
}

export function buildReportPrompt(input: GeminiGenerateHtmlInput): string {
  const birthLabel = `${input.birth.year}-${String(input.birth.month).padStart(2, "0")}-${String(
    input.birth.day,
  ).padStart(2, "0")} ${String(input.birth.hour).padStart(2, "0")}:${String(input.birth.minute).padStart(2, "0")}`;

  const calLabel = input.calendar === "lunar" ? "음력" : "양력";

  return [
    "# 역할: 세계 최고의 명리 분석가 및 운명 데이터 아키텍트",
    "당신은 수만 명의 생애를 감명하고 인생의 길흉화복을 데이터와 통찰로 풀어내는 세계 최고 수준의 사주팔자 명리학 전문가입니다.",
    "사용자가 제공한 [생년월일시 및 성별]을 바탕으로 인생 대백과사전형 보고서를 작성하세요.",
    "",
    "## 핵심 수행 지침",
    "1) 정량적 점수화: 14개 항목 모두 heading 시작에 100점 만점 점수를 표기하세요.",
    "2) 고밀도 분석: 고전 명리 근거 + 현대적 해석 + 실제적 조언을 함께 제시하세요.",
    "3) 무질문 원칙: 추가 질문 없이 제공 정보만으로 즉시 최종 보고서를 작성하세요.",
    "",
    "## 출력 제약(매우 중요)",
    "- 반드시 JSON만 출력 (마크다운/설명/코드펜스/주석 금지)",
    "- 키 이름은 영어 camelCase로 고정",
    "- 문자열은 한국어로 작성",
    "- 과장/확정적 단정 금지(참고용 톤)",
    "- sections는 정확히 14개, 아래 순서와 점수 라벨 형식을 반드시 유지",
    "- 각 section의 bullets는 8~12개 작성하고, 각 bullet은 120~220자 분량의 완결 문장으로 작성",
    "- heading 형식: `NN. 항목명 [라벨 점수: NN/100]`",
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
    "## sections 고정 목차",
    "01. 사주풀이 [종합 운명 점수: NN/100]",
    "02. 대운(大運) [대운 흐름 점수: NN/100]",
    "03. 세운(歲運) [세운 반응 점수: NN/100]",
    "04. 신년운세 및 월운(月運) [단기 운세 점수: NN/100]",
    "05. 12운성 [기동 에너지 점수: NN/100]",
    "06. 12신살 & 천을귀인 여부 [귀인 조력 점수: NN/100]",
    "07. 기타 신살 풀이 [신살 활용 점수: NN/100]",
    "08. 십성(十星) [사회성 점수: NN/100]",
    "09. 재운(재물운) [재물 획득 점수: NN/100]",
    "10. 관운(직업운) [사회적 성취 점수: NN/100]",
    "11. 애정운(부부운) [배우자 복 점수: NN/100]",
    "12. 자녀운 [자녀 인연 점수: NN/100]",
    "13. 건강운 [생체 활력 점수: NN/100]",
    "14. 이동운(이직, 이사운) [변화 적응 점수: NN/100]",
    "",
    "## JSON 스키마(반드시 준수)",
    "{",
    '  "title": "string",',
    '  "summary": {',
    '    "oneLine": "string",',
    '    "keywords": ["string", "... 6~12개"],',
    '    "highlights": ["string", "... 4~10개"]',
    "  },",
    '  "sections": [',
    '    { "heading": "string", "bullets": ["string", "... 8~12개"] }',
    "  ],",
    '  "elementBalance": {',
    '    "analysis": "string",',
    '    "tips": ["string", "... 4~10개"]',
    "  },",
    '  "disclaimer": "참고용/의학·법률·투자 조언 아님 포함"',
    "}",
  ].join("\n");
}

async function generateReportContentWithOpenAI(
  input: GeminiGenerateHtmlInput,
  debugCapture?: LlmDebugCapture,
): Promise<ReportContent> {
  const apiKey = mustGetEnv("OPENAI_API_KEY");
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const prompt = buildReportPrompt(input);

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
          content: prompt,
        },
      ],
      response_format: { type: "json_object" },
      temperature: 0.7,
      max_tokens: 7000,
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
  debugCapture?.({ provider: "openai", model, prompt, raw });

  const jsonText = extractJsonObject(raw);
  const obj = JSON.parse(jsonText) as unknown;
  return reportContentSchema.parse(obj);
}

export async function generateReportContentWithGemini(
  input: GeminiGenerateHtmlInput,
  debugCapture?: LlmDebugCapture,
): Promise<ReportContent> {
  const requestedProvider = resolveRequestedProvider();
  if (requestedProvider === "openai") {
    return generateReportContentWithOpenAI(input, debugCapture);
  }

  const apiKey = mustGetEnv("GEMINI_API_KEY");
  const model = process.env.GEMINI_MODEL || "gemini-3.1-flash";
  const prompt = buildReportPrompt(input);

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
        temperature: 0.7,
        maxOutputTokens: 8192,
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
  debugCapture?.({ provider: "gemini", model, prompt, raw });

  const jsonText = extractJsonObject(raw);
  const obj = JSON.parse(jsonText) as unknown;
  return reportContentSchema.parse(obj);
}
