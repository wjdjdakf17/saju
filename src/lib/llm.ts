import { z } from "zod";

import { mustGetEnv } from "@/lib/env";
import { reportContentSchema, type ReportContent } from "@/lib/reportSchema";
import { computeDaewoonTable, computeSajuExtended, computeYeonunTable } from "@/lib/sajuExtended";

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

export type LlmProvider = "gemini" | "openai";
export type RequestedProvider = "gemini" | "openai";
export type LlmRuntimeOptions = {
  provider?: RequestedProvider;
  model?: string;
};
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

/** PDF(사주결과) 형식 12장 목차 */
const SECTION_BLUEPRINTS: SectionBlueprint[] = [
  { number: 1, title: "사주의 기초적인 이해", scoreLabel: "소개" },
  { number: 2, title: "나의 사주팔자", scoreLabel: "사주원국" },
  { number: 3, title: "일주로 보는 나의 성격", scoreLabel: "일주 성격" },
  { number: 4, title: "십성 분석", scoreLabel: "십성" },
  { number: 5, title: "십이운성 분석", scoreLabel: "십이운성" },
  { number: 6, title: "십이신살 및 귀인 분석", scoreLabel: "신살·귀인" },
  { number: 7, title: "연애운 및 결혼운 분석", scoreLabel: "연애·결혼" },
  { number: 8, title: "재물운 분석", scoreLabel: "재물운" },
  { number: 9, title: "직업운 분석", scoreLabel: "직업운" },
  { number: 10, title: "건강운 분석", scoreLabel: "건강운" },
  { number: 11, title: "나의 대운", scoreLabel: "대운" },
  { number: 12, title: "나의 6년간 연운", scoreLabel: "연운" },
];

const summarySchema = z.object({
  title: z.string().min(1).max(80),
  summary: z.object({
    oneLine: z.string().min(1).max(200),
    keywords: z.array(z.string().min(1).max(30)).min(6).max(12),
    highlights: z.array(z.string().min(1).max(160)).min(4).max(10),
  }),
});

// First-pass parsing schema. We may expand too-short bodies via a follow-up call,
// then enforce a hard minimum locally to avoid runtime 500s.
const sectionChunkLooseSchema = z.object({
  sections: z
    .array(
      z.object({
        heading: z.string().min(1).max(120),
        body: z.string().min(1).max(12000),
      }),
    )
    .min(1)
    .max(12),
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

function resolveRequestedProvider(options?: LlmRuntimeOptions): RequestedProvider {
  const raw = (options?.provider || process.env.LLM_PROVIDER || "openai").toLowerCase();
  return raw === "openai" ? "openai" : "gemini";
}

function resolveRequestedModel(provider: RequestedProvider, options?: LlmRuntimeOptions): string {
  const override = options?.model?.trim();
  if (override) return override;
  return provider === "openai"
    ? process.env.OPENAI_MODEL || "gpt-5"
    : process.env.GEMINI_MODEL || "gemini-3.1-flash";
}

function getSectionBlueprint(number: number): SectionBlueprint {
  const found = SECTION_BLUEPRINTS[number - 1];
  if (!found) {
    throw new Error(`Invalid section number: ${number}`);
  }
  return found;
}

function sectionHeadingExample(blueprint: SectionBlueprint): string {
  return `${String(blueprint.number).padStart(2, "0")}. ${blueprint.title} [${blueprint.scoreLabel
    }: NN/100]`;
}

function sectionHeadingFallback(blueprint: SectionBlueprint): string {
  return `${String(blueprint.number).padStart(2, "0")}. ${blueprint.title} [${blueprint.scoreLabel
    }: 70/100]`;
}

function buildContextBlock(input: LlmGenerateInput): string {
  const birthLabel = `${input.birth.year}-${String(input.birth.month).padStart(2, "0")}-${String(
    input.birth.day,
  ).padStart(2, "0")} ${String(input.birth.hour).padStart(2, "0")}:${String(input.birth.minute).padStart(2, "0")}`;

  const calLabel = input.calendar === "lunar" ? "음력" : "양력";
  const styleGuide = buildNarrativeStyleGuide(input);

  return [
    "# 역할: 사주결과.pdf 스타일 작가 + 명리 분석가",
    "당신은 ‘사주결과.pdf’와 동일한 말투/전개로 사주 리포트를 작성합니다.",
    "핵심은 사용자가 읽기 편하고 설득력 있게 ‘장(章) 단위로’ 흘러가게 만드는 것입니다.",
    "",
    "## 문체/톤 (강제)",
    "- 존댓말, 따뜻한 안내자 톤. 딱딱한 설명문처럼 쓰지 말고, 독자가 편안하게 읽히는 자연스러운 문장으로 씁니다.",
    "- 공감/정감이 느껴지도록 “~하실 수 있어요/~해보시면 좋겠습니다/괜찮습니다/천천히 살펴보겠습니다” 같은 완곡한 표현을 적절히 섞습니다.",
    "- 과도한 단정(무조건/확실히/반드시)은 피하고, ‘경향/가능성/조언’ 중심으로 조심스럽게 서술합니다.",
    "- 같은 문장 패턴/AI스러운 접속어 반복을 피하고, 문단은 3~6문장 단위로 자연스럽게 끊습니다.",
    "- 한자를 쓰는 경우 반드시 괄호로 한글 독음/설명을 붙이세요. 예: 辛(신금), 偏財(편재), 正官(정관), 甲子(갑자).",
    ...styleGuide,
    "",
    "## 고객 이름 사용 (강제, 신빙성)",
    "- 각 장(섹션)의 본문(body)은 반드시 첫 문장 또는 첫 문단에서 고객 이름을 호칭으로 사용하세요.",
    `- 예: "${input.name}님의 일주는 ~", "${input.name}님은 ~", "${input.name}님께서는 ~" 등 문두에 이름을 넣어 독자가 자신의 리포트임을 명확히 인식하도록 하세요.`,
    "",
    "## 분량 규칙 (강제)",
    "- 각 장(섹션)은 body 하나로 작성합니다. body는 2,200~12,000자.",
    "- body는 최소 9개 이상의 문단으로 구성하고, 문단은 3~6문장 단위로 자연스럽게 끊으세요.",
    "- 같은 표현 반복을 피하고, 원인→해석→사례(생활 장면 1~2개)→생활 조언(실행 단계 포함)→요약 정리까지 전개를 유지하세요.",
    "- 조언은 “무엇을/언제/어떻게”까지 한 단계 더 구체적으로 제시하세요. (예: 주간 루틴, 대화 방식, 의사결정 체크리스트 등)",
    "",
    "## 레이아웃 규칙",
    "- 표/동물 이미지/오행 카드/음양 바 등 그래픽 요소는 시스템이 별도 렌더링합니다.",
    "- 당신은 텍스트 콘텐츠(해설)만 생성하며, HTML/마크다운/표 그리기 지시는 출력하지 마세요.",
    "",
    "## 2장 전개 규칙 (사주결과.pdf 스타일)",
    "- 2장 body는 아래 흐름을 유지: (1) 음양오행 개념 소개 → (2) 나의 오행 분포 해설 → (3) 나의 음양 비율 해설 → (4) 나의 일주(간지) 해설 → (5) 종합 정리",
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

function stableHash(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function pickByHash<T>(arr: readonly T[], seed: number): T {
  return arr[seed % arr.length];
}

function buildNarrativeStyleGuide(input: LlmGenerateInput): string[] {
  const seed = stableHash(
    `${input.name}|${input.gender}|${input.birth.year}-${input.birth.month}-${input.birth.day} ${input.birth.hour}:${input.birth.minute}|${input.saju.fourPillarsKorean.day}`,
  );
  const introTone = pickByHash(
    [
      "문단 도입은 차분한 관찰형 어조를 우선하세요.",
      "문단 도입은 현실적 코칭형 어조를 우선하세요.",
      "문단 도입은 공감형 어조를 우선하세요.",
    ] as const,
    seed + 11,
  );
  const evidenceStyle = pickByHash(
    [
      "해석 근거는 '왜 그런지'를 먼저 설명하고 결론을 제시하세요.",
      "해석 근거는 결론을 먼저 제시한 뒤 생활 근거를 붙이세요.",
      "해석 근거는 비교(강점/부담)를 나란히 배치해 설명하세요.",
    ] as const,
    seed + 23,
  );
  const actionStyle = pickByHash(
    [
      "실행 조언은 주간 루틴(요일/시간대) 중심으로 제시하세요.",
      "실행 조언은 대화 방식(질문/확인/합의) 중심으로 제시하세요.",
      "실행 조언은 의사결정 체크리스트 중심으로 제시하세요.",
    ] as const,
    seed + 37,
  );

  return [
    "",
    "## 개인화 문체 가이드 (강제)",
    `- ${introTone}`,
    `- ${evidenceStyle}`,
    `- ${actionStyle}`,
  ];
}

function buildDerivedPromptFacts(input: LlmGenerateInput): string {
  const ext = computeSajuExtended(input.saju.fourPillarsKorean);
  if (!ext) return "";

  const gwinLabel = (items: string[]) => (items.length ? items.join(", ") : "해당없음");

  const lines: string[] = [
    "## 계산된 해석 데이터",
    `- 일주: ${input.saju.fourPillarsKorean.day} (${ext.pillars[1].stemHanja}(${ext.pillars[1].stemKorean})${ext.pillars[1].branchHanja}(${ext.pillars[1].branchKorean}))`,
    `- 오행 분포: 목 ${ext.elementPcts.목}%(${ext.elementCounts.목}개), 화 ${ext.elementPcts.화}%(${ext.elementCounts.화}개), 토 ${ext.elementPcts.토}%(${ext.elementCounts.토}개), 금 ${ext.elementPcts.금}%(${ext.elementCounts.금}개), 수 ${ext.elementPcts.수}%(${ext.elementCounts.수}개)`,
    `- 음양 비율: 양 ${ext.yinYangPct.yang}%, 음 ${ext.yinYangPct.yin}%`,
    `- 시주: ${ext.pillars[0].stemKorean}${ext.pillars[0].branchKorean}, 천간 십성=${ext.pillars[0].sipseongStem}, 지지 십성=${ext.pillars[0].sipseongBranch}, 십이운성=${ext.pillars[0].sibiunseong}, 십이신살=${ext.pillars[0].sibisinsal}, 귀인=${gwinLabel(ext.pillars[0].gwin)}`,
    `- 일주: ${ext.pillars[1].stemKorean}${ext.pillars[1].branchKorean}, 천간 십성=${ext.pillars[1].sipseongStem}, 지지 십성=${ext.pillars[1].sipseongBranch}, 십이운성=${ext.pillars[1].sibiunseong}, 십이신살=${ext.pillars[1].sibisinsal}, 귀인=${gwinLabel(ext.pillars[1].gwin)}`,
    `- 월주: ${ext.pillars[2].stemKorean}${ext.pillars[2].branchKorean}, 천간 십성=${ext.pillars[2].sipseongStem}, 지지 십성=${ext.pillars[2].sipseongBranch}, 십이운성=${ext.pillars[2].sibiunseong}, 십이신살=${ext.pillars[2].sibisinsal}, 귀인=${gwinLabel(ext.pillars[2].gwin)}`,
    `- 연주: ${ext.pillars[3].stemKorean}${ext.pillars[3].branchKorean}, 천간 십성=${ext.pillars[3].sipseongStem}, 지지 십성=${ext.pillars[3].sipseongBranch}, 십이운성=${ext.pillars[3].sibiunseong}, 십이신살=${ext.pillars[3].sibisinsal}, 귀인=${gwinLabel(ext.pillars[3].gwin)}`,
  ];

  const daewoon = computeDaewoonTable(input.saju.fourPillarsKorean, ext.dayStem, input.gender);
  if (daewoon) {
    lines.push(
      `- 대운 요약: ${daewoon.columns.map((c, i) => `${daewoon.ages[i]}세 ${c.stemHanja}(${c.stem})${c.branchHanja}(${c.branch})/${c.sipseongStem}/${c.sipseongBranch}/${c.sibiunseong}`).join(" | ")}`,
    );
  }

  const yeonun = computeYeonunTable(ext.dayStem, new Date().getFullYear());
  lines.push(
    `- 연운 요약: ${yeonun.columns.map((c) => `${c.year}년 ${c.stemHanja}(${c.stem})${c.branchHanja}(${c.branch})/${c.sipseongStem}/${c.sipseongBranch}/${c.sibiunseong}`).join(" | ")}`,
  );

  return lines.join("\n");
}

function buildSectionFormatSpec(input: LlmGenerateInput, sectionNumber: number): string {
  const dayPillar = input.saju.fourPillarsKorean.day;
  const dayStem = dayPillar[0] ?? "";
  const dayBranch = dayPillar[1] ?? "";

  switch (sectionNumber) {
    case 1:
      return "### 1장 형식 고정\n- 사주가 무엇인지 설명하는 도입 장으로 쓰되, 전체 리포트를 읽는 기준을 잡아주는 역할로 작성하세요.";
    case 2:
      return `### 2장 형식 고정
- 반드시 다음 흐름을 지키세요: 음양 개념 설명 -> 오행 개념 설명 -> 상생/상극 설명 -> '${input.name}님의 음양오행 구성' -> '${input.name}님의 음양에 대한 설명' -> '${input.name}님의 일주에 대한 설명' -> 종합 정리.
- 계산된 오행 분포, 음양 비율, 일주(${dayPillar})를 반영하세요.`;
    case 3:
      return `### 3장 형식 고정
- 첫 문장은 반드시 '${dayPillar} 일주에 대한 성격을 분석해드리겠습니다.'로 시작하세요.
- 반드시 다음 순서를 지키세요: '일간을 기준으로 한 성격 분석' -> 일간 5항목(각 항목은 제목 1줄 + '특징 :' + '영향 :'로 구성) -> '일지를 기준으로 한 성격 분석' -> 일지 5항목(각 항목은 제목 1줄 + '특징 :' + '영향 :'로 구성) -> '일간과 일지를 기준으로 한 종합적인 성격분석'.
- 각 항목(예: 강한 결단력)은 반드시 하나의 독립 문단으로 작성하고, 항목과 항목 사이에는 빈 줄을 넣으세요.
- 슬래시로 압축하지 말고, 제목 줄 다음에 '특징 :'과 '영향 :'을 각각 줄바꿈해서 쓰세요.
- 일간은 ${dayStem}, 일지는 ${dayBranch}의 속성을 반영하세요.`;
    case 4:
      return "### 4장 형식 고정\n- 연주 -> 월주 -> 일주 -> 시주 -> 종합 순서를 지키세요.\n- 각 기둥에서 천간 십성과 지지 십성을 모두 설명하세요.";
    case 5:
      return "### 5장 형식 고정\n- 연주 -> 월주 -> 일주 -> 시주 -> 종합 순서를 지키세요.\n- 각 기둥의 십이운성을 중심으로 의미, 시기, 주의점, 성장 포인트를 설명하세요.";
    case 6:
      return "### 6장 형식 고정\n- '십이신살에 대해 먼저 풀이해보겠습니다!'를 포함하세요.\n- 연주 -> 월주 -> 일주 -> 시주 순으로 신살을 설명한 뒤, '이제 귀인에 대해서 알아볼까요?'로 귀인 파트를 이어서 작성하세요.\n- 마지막은 종합 정리로 마무리하세요.";
    case 7:
      return "### 7장 형식 고정\n- 반드시 다음 소제목 순서를 지키세요: 연애운 풀이 -> 일간 성격과 연애 성향 -> 연애에서 나타나는 장단점 -> 연애 시기와 방법 -> 살과 귀인의 영향 -> 성공적인 연애를 위한 조언 -> 나의 결혼운 -> 이상적인 배우자상과 피해야할 배우자상 -> 배우자와의 관계 전망 -> 연애에서 피해야 할 점 -> 종합분석.\n- 각 소제목 본문은 최소 180자(권장 240~420자), 2~4문장으로 작성하세요. 한 줄 설명으로 끝내지 마세요.";
    case 8:
      return "### 8장 형식 고정\n- 반드시 다음 소제목 순서를 지키세요: 재물운 풀이 -> 일간 성격과 재물운 -> 시간에 따른 재물운의 흐름 -> 재물운이 크게 들어오는 시기 -> 살과 귀인의 영향 -> 주의해야 될 시기 -> 어떻게 재물을 모으게 될까? -> 성공적인 재물의 축적 방법 -> 종합분석.\n- 각 소제목 본문은 최소 180자(권장 240~420자), 2~4문장으로 작성하세요. 숫자/시기/실행 조언을 함께 넣어주세요.";
    case 9:
      return "### 9장 형식 고정\n- 반드시 다음 소제목 순서를 지키세요: 직업운 풀이 -> 나의 일간 성격에 맞는 직업, 직무 -> 나의 직장운 -> 나의 사업운 -> 십이신살과 귀인의 영향 -> 성공적인 직장생활을 위한 조언 -> 종합분석.\n- 각 소제목 본문은 최소 180자(권장 240~420자), 2~4문장으로 작성하세요. 실제 업무 장면 예시를 최소 1개 포함하세요.";
    case 10:
      return "### 10장 형식 고정\n- 반드시 다음 소제목 순서를 지키세요: 건강운 풀이 -> 나의 건강운 -> 십이신살과 귀인의 영향 -> 시기에 따른 나의 건강운 -> 주의해야 할 질병 -> 추천 운동 -> 추천 식단 -> 종합분석.\n- 각 소제목 본문은 최소 180자(권장 240~420자), 2~4문장으로 작성하세요. 주의 포인트와 실행 루틴을 함께 제시하세요.";
    case 11:
      return "### 11장 형식 고정\n- 먼저 대운 전체 흐름 도입 문단 1개를 쓰세요.\n- 그 뒤 10개 대운 칸을 각각 설명하세요.\n- 각 칸은 반드시 다음 순서를 지키세요: '이번 대운의 천간은 ...' -> '이번 대운의 지지는 ...' -> '천간의 십성은 ...' -> '지지의 십성은 ...' -> '십이운성은 ...' -> 정리 문단.";
    case 12:
      return "### 12장 형식 고정\n- 먼저 연운 전체 흐름 도입 문단 1개를 쓰세요.\n- 그 뒤 최근 6개 연도를 각각 설명하세요.\n- 각 연도는 반드시 다음 순서를 지키세요: '나의 20XX년 연운' -> '나의 20XX년 연운 : 천간 ...' -> '나의 20XX년 연운 : 지지 ...' -> '나의 20XX년 연운 : 천간 십성 ...' -> '나의 20XX년 연운 : 지지 십성 ...' -> '나의 20XX년 연운 : 십이운성 ...' -> '나의 20XX년 연운 종합'.";
    default:
      return "";
  }
}

function buildSectionReferenceText(input: LlmGenerateInput, sectionNumber: number): string {
  switch (sectionNumber) {
    case 2:
      return [
        "## 2장 기준 원고/스타일",
        "- 아래 설명의 문장 결, 설명 밀도, 전개 순서를 기준으로 삼으세요.",
        "- 개념 설명은 아래처럼 충분히 길고 자연스럽게 쓰고, 그 다음에 개인 오행/음양/일주 해설로 넘어가세요.",
        "",
        "먼저, 음양은 모든 존재와 현상이 두 가지 상반된 성질을 지닌다는 원리를 의미하는데요, 음은 어두움, 추움, 고요함, 내부 지향성, 수축, 여성적 이미지를 상징하며, 양은 밝음, 따뜻함, 움직임, 외부 지향성, 확장, 남성적 이미지를 상징합니다. 음양은 서로 대립하는 것처럼 보이지만 실상은 상호 보완적이며, 끊임없이 변화를 거듭하며 균형을 이루는 관계를 의미합니다.",
        "오행은 이 음양의 토대 위에 자연계의 변화 원리를 보다 구체적으로 설명하기 위한 다섯 가지 요소입니다. 오행은 목, 화, 토, 금, 수라는 다섯 가지로 구성되며, 이들은 단순히 물질적 요소를 가리키는 것이 아니라 사물과 현상을 바라보는 다원적 관점을 제공합니다.",
        "화(火)는 여름, 열기, 번영, 활발한 외향적 성격을 갖추어 불길처럼 치솟는 생명력을 보여줍니다. 수(水)는 겨울, 차가움, 잠재성, 휴식을 의미하며, 만물을 지탱하고 침전시키며 다음 발아를 준비하는 에너지를 품고 있습니다. 목(木)은 봄, 생장, 탄생, 확장과 같은 성격을 지니며, 나무처럼 위로 뻗는 성장의 에너지를 상징합니다. 금(金)은 가을, 결실, 수축, 단단함을 상징하며, 수확과 응축의 힘을 담당합니다. 토(土)는 간절기, 중앙, 균형, 안정, 중립적 역할을 하며, 다른 네 행이 원활히 소통하고 전환하는 매개체가 됩니다.",
        "이후에는 반드시 개인 데이터 기반으로 'OOO님의 음양오행 구성', 'OOO님의 음양에 대한 설명', 'OOO님의 일주에 대한 설명', 종합 정리 순으로 이어가세요.",
      ].join("\n");
    case 3:
      return [
        "## 3장 기준 원고/스타일",
        "- 아래처럼 '일간 5항목 + 일지 5항목 + 종합' 구조를 유지하세요.",
        "- 각 항목은 반드시 '제목 1줄 -> 특징 : -> 영향 :' 구조를 지키세요.",
        "- 항목과 항목 사이는 반드시 빈 줄로 구분하세요.",
        "",
        "경자 일주에 대한 성격을 분석해드리겠습니다.",
        "일간을 기준으로 한 성격 분석",
        "",
        "강한 결단력",
        "특징 :",
        "영향 :",
        "",
        "책임감 있는 성향",
        "특징 :",
        "영향 :",
        "",
        "원칙과 규율 존중",
        "특징 :",
        "영향 :",
        "",
        "솔직한 표현 방식",
        "특징 :",
        "영향 :",
        "",
        "단단한 끈기와 인내",
        "특징 :",
        "영향 :",
        "일지를 기준으로 한 성격 분석",
        "",
        "유연한 사고방식",
        "특징 :",
        "영향 :",
        "",
        "지혜와 직관",
        "특징 :",
        "영향 :",
        "",
        "내향적인 성향",
        "특징 :",
        "영향 :",
        "",
        "예민함",
        "특징 :",
        "영향 :",
        "",
        "빠른 배움",
        "특징 :",
        "영향 :",
        "",
        "일간과 일지를 기준으로 한 종합적인 성격분석",
        "- 실제 내용은 예시를 복붙하지 말고, 대상자의 일주에 맞게 전부 바꾸세요.",
      ].join("\n");
    case 4:
      return [
        "## 4장 기준 원고/스타일",
        "- 반드시 연주 -> 월주 -> 일주 -> 시주 -> 종합 순서를 지키세요.",
        "- 각 기둥마다 '먼저/다음으로/마지막으로' 전환 문장을 넣고, 천간 십성과 지지 십성을 모두 풀어주세요.",
        "- 예시처럼 초년기/청년기/중년기/말년기 의미를 연결해 서술하세요.",
      ].join("\n");
    case 5:
      return [
        "## 5장 기준 원고/스타일",
        "- 반드시 연주 -> 월주 -> 일주 -> 시주 -> 종합 순서를 지키세요.",
        "- 각 기둥의 십이운성을 삶의 시기, 에너지 강약, 전환점, 주의점까지 포함해 설명하세요.",
        "- 예시처럼 각 운성이 가진 상징을 먼저 풀고, 그 다음 실제 삶의 흐름으로 이어가세요.",
      ].join("\n");
    case 6:
      return [
        "## 6장 기준 원고/스타일",
        "- 먼저 '십이신살에 대해 먼저 풀이해보겠습니다!'를 넣으세요.",
        "- 신살은 연주 -> 월주 -> 일주 -> 시주 순으로 설명하세요.",
        "- 그 다음 '이제 귀인에 대해서 알아볼까요?'를 넣고 귀인을 설명하세요.",
        "- 예시처럼 마지막에는 전체 삶의 흐름을 한 번에 종합 정리하세요.",
      ].join("\n");
    case 7:
      return [
        "## 7장 기준 원고/스타일",
        "- 반드시 다음 소제목을 모두 포함하세요.",
        "연애운 풀이",
        "일간 성격과 연애 성향",
        "연애에서 나타나는 장단점",
        "연애 시기와 방법",
        "살과 귀인의 영향",
        "성공적인 연애를 위한 조언",
        "나의 결혼운",
        "이상적인 배우자상과 피해야할 배우자상",
        "배우자와의 관계 전망",
        "연애에서 피해야 할 점",
        "종합분석",
      ].join("\n");
    case 8:
      return [
        "## 8장 기준 원고/스타일",
        "- 아래 소제목과 순서를 그대로 따르세요.",
        "재물운 풀이",
        "나의 일간 성격과 재물운",
        "시간에 따른 재물운의 흐름",
        "재물운이 크게 들어오는 시기",
        "살과 귀인의 영향",
        "주의해야 될 시기",
        "어떻게 재물을 모으게 될까?",
        "성공적인 재물의 축적 방법",
        "종합분석",
        "- 예시처럼 초년/청년/중년/말년 흐름을 세부적으로 연결해 설명하세요.",
      ].join("\n");
    case 9:
      return [
        "## 9장 기준 원고/스타일",
        "- 아래 소제목과 순서를 그대로 따르세요.",
        "직업운 풀이",
        "나의 일간 성격에 맞는 직업, 직무",
        "나의 직장운",
        "나의 사업운",
        "십이신살과 귀인의 영향",
        "성공적인 직장생활을 위한 조언",
        "종합분석",
      ].join("\n");
    case 10:
      return [
        "## 10장 기준 원고/스타일",
        "- 아래 소제목과 순서를 그대로 따르세요.",
        "건강운 풀이",
        "나의 건강운",
        "십이신살과 귀인의 영향",
        "시기에 따른 나의 건강운",
        "주의해야 할 질병",
        "추천 운동",
        "추천 식단",
        "종합분석",
        "- 예시처럼 초년/청년/중년/말년의 건강 리듬과 질환 주의 포인트를 모두 풀어주세요.",
      ].join("\n");
    case 11:
      return [
        "## 11장 기준 원고/스타일",
        "- 먼저 대운 전체 흐름을 설명하는 도입 문단 1개를 쓰세요.",
        "- 그 다음 개별 대운 설명이 총 10개 나와야 합니다.",
        "- 각 대운은 반드시 다음 순서를 지키세요.",
        "이번 대운의 천간은 ...",
        "이번 대운의 지지는 ...",
        "천간의 십성은 ...",
        "지지의 십성은 ...",
        "십이운성은 ...",
        "정리해보면 ...",
        "- 예시처럼 학업/재물/인간관계/건강 등 실생활 연결 문장을 포함하세요.",
      ].join("\n");
    case 12:
      return [
        "## 12장 기준 원고/스타일",
        "- 먼저 연운 전체 흐름을 설명하는 도입 문단 1개를 쓰세요.",
        "- 그 다음 최근 6개 연도 각각을 설명하세요.",
        "- 각 연도는 반드시 다음 순서를 지키세요.",
        "나의 20XX년 연운",
        "나의 20XX년 연운 : 천간 ...",
        "나의 20XX년 연운 : 지지 ...",
        "나의 20XX년 연운 : 천간 십성 ...",
        "나의 20XX년 연운 : 지지 십성 ...",
        "나의 20XX년 연운 : 십이운성 ...",
        "나의 20XX년 연운 종합",
        "- 예시처럼 각 해마다 활동성, 책임감, 감정선, 선택 조언까지 연결해서 써주세요.",
      ].join("\n");
    default:
      return "";
  }
}

function buildSectionGuardSuffix(input: LlmGenerateInput, sectionNumber: number): string {
  switch (sectionNumber) {
    case 7:
      return `\n\n${input.name}님은 감정이 깊은 만큼 관계의 속도를 조절하는 연습이 중요합니다. 서운함이 쌓이기 전에 작게 표현하고, 확신이 없을 때는 상대를 시험하기보다 사실을 먼저 확인하는 편이 관계를 안정시키는 데 도움이 됩니다. 연애운은 결국 마음의 깊이만이 아니라 표현 방식과 타이밍에 따라 체감 차이가 크게 날 수 있습니다.`;
    case 8:
      return `\n\n${input.name}님은 큰 승부보다 반복 가능한 관리 습관을 먼저 만드는 편이 유리합니다. 소비와 수입을 같이 기록하고, 감정이 흔들리는 날의 지출 패턴을 따로 체크해 보시면 도움이 됩니다. 재물운은 기회 자체보다 관리 방식과 점검 루틴에서 차이가 벌어질 가능성이 큽니다.`;
    case 9:
      return `\n\n${input.name}님은 성과와 책임감이 강점이 될 수 있지만, 중간 조율 대화가 부족하면 피로가 커질 수 있습니다. 중요한 대화 전에는 핵심 포인트를 메모해두는 습관이 도움이 됩니다. 직업운은 역할의 무게를 잘 버티는 힘이 장점이지만, 속도 조절과 소통 방식이 함께 받쳐줘야 안정적으로 이어집니다.`;
    case 10:
      return `\n\n${input.name}님은 몸을 무겁게 만드는 패턴을 먼저 줄이고, 규칙적인 식사와 수면 리듬을 맞추는 편이 건강운을 안정시키는 데 도움이 됩니다. 건강운은 큰 사건보다 작은 무너짐이 반복될 때 체감 차이가 커질 수 있으니, 회복 루틴을 먼저 안정시키는 편이 좋습니다.`;
    case 11:
      return `\n\n정리해보면 이번 대운은 ${input.name}님이 기준을 어떻게 쓰느냐에 따라 체감 차이가 크게 벌어질 수 있는 시기입니다. 무리한 확장보다 흐름 점검과 생활 리듬 조절을 함께 가져가시는 편이 좋습니다.`;
    case 12:
      return `\n\n나의 연운 종합\n정리하면 이 해의 흐름은 결과 하나보다 선택의 순서와 감정 조절 방식에서 차이가 벌어질 수 있습니다. ${input.name}님은 기준을 먼저 세우고 움직일수록 훨씬 안정적으로 흐름을 활용하실 수 있어요.`;
    default:
      return `\n\n정리하면 ${input.name}님은 이 장에서 보이는 흐름을 생활 장면과 함께 읽을수록 훨씬 현실적으로 적용하실 수 있습니다. 중요한 것은 한 번에 전부 바꾸는 것이 아니라, 지금 당장 조절할 수 있는 행동 하나를 정해 반복하는 것입니다.`;
  }
}

function buildFallbackPaddingParagraphs(
  input: LlmGenerateInput,
  sectionNumber: number,
  sectionTitle: string,
  dayPillar: string,
): string[] {
  switch (sectionNumber) {
    case 1:
      return [
        `${input.name}님은 사주를 읽을 때 한 문장으로 운명을 단정하기보다, 각 장에서 반복해서 드러나는 공통 주제를 먼저 잡아두시면 이후 해석이 훨씬 자연스럽게 이어집니다.`,
        `${dayPillar} 일주를 중심축으로 삼아 다른 기둥을 함께 보시면 성격과 운의 흐름이 왜 연결되는지도 더 쉽게 이해하실 수 있습니다.`,
      ];
    case 2:
      return [
        `${input.name}님은 오행의 많고 적음만 볼 것이 아니라, 어떤 기운이 생활에서 지나치게 앞서고 어떤 기운이 비어 있는지까지 함께 살펴보셔야 균형점을 찾기 쉽습니다.`,
        `${dayPillar} 일주를 기준으로 보면 부족한 기운을 생활 습관과 환경 선택으로 보완하는 방식이 실제 체감에 더 도움이 될 수 있습니다.`,
      ];
    case 3:
      return [
        `${input.name}님의 성격은 한 가지 단어로 정리되기보다, 일간의 기준감과 일지의 정서 반응이 함께 작용하면서 상황마다 다른 결로 드러날 가능성이 큽니다.`,
        `그래서 ${dayPillar} 일주의 장점은 밀고, 피로가 쌓이는 반응은 조절하는 방식으로 읽으시는 편이 훨씬 현실적입니다.`,
      ];
    case 4:
      return [
        `${input.name}님은 십성을 볼 때 좋은 십성, 나쁜 십성으로 단순히 나누기보다 시기마다 어떤 역할이 강하게 올라오는지를 먼저 파악하시는 편이 좋습니다.`,
        `특히 ${dayPillar} 일주 기준으로 연주와 월주, 일주와 시주가 맡는 역할의 차이를 구분해서 보시면 실제 삶의 흐름과 더 잘 맞아떨어질 수 있습니다.`,
      ];
    case 5:
      return [
        `${input.name}님은 십이운성을 결과표처럼 보기보다, 에너지가 올라오는 시기와 쉬어야 하는 시기를 읽는 리듬표처럼 이해하시면 훨씬 활용도가 높아집니다.`,
        `${dayPillar} 일주를 중심으로 삶의 속도를 조절하시면 강한 시기에는 밀고, 약한 시기에는 정비하는 전략을 세우기 쉬워집니다.`,
      ];
    case 6:
      return [
        `${input.name}님은 신살과 귀인을 사건 자체보다 인간관계의 흐름, 환경 변화, 도움을 받는 타이밍과 연결해서 읽으시는 편이 실제 체감에 더 가깝습니다.`,
        `${dayPillar} 일주 기준으로 보면 부담이 커지는 시기와 숨통이 트이는 시기가 번갈아 나타날 수 있으니, 완충 장치를 같이 보는 해석이 중요합니다.`,
      ];
    case 7:
      return [
        `${input.name}님은 연애에서 마음의 깊이만큼 표현의 순서와 속도도 중요하게 작용할 수 있습니다.`,
        `${dayPillar} 일주의 기질을 생각하면 감정이 커질수록 말의 타이밍을 조절하는 연습이 관계 안정에 더 직접적인 도움이 될 수 있습니다.`,
      ];
    case 8:
      return [
        `${input.name}님은 재물운을 볼 때 큰 기회를 기다리기보다 반복 가능한 관리 습관을 먼저 만드는 편이 훨씬 유리할 수 있습니다.`,
        `${dayPillar} 일주의 판단 기준을 잘 살리면 지출과 수입의 리듬을 정리하는 과정에서 안정감이 더 빨리 잡힐 가능성이 큽니다.`,
      ];
    case 9:
      return [
        `${input.name}님은 직업운에서 능력 자체만큼 역할의 무게를 어떻게 분산하고 소통하느냐가 오래 가는 성과에 큰 영향을 줄 수 있습니다.`,
        `${dayPillar} 일주의 기준감을 강점으로 쓰되, 조율 대화를 놓치지 않으면 일의 지속성과 만족도가 함께 높아질 수 있습니다.`,
      ];
    case 10:
      return [
        `${input.name}님은 건강운에서 큰 사건보다 작은 피로 누적이 반복될 때 체감 차이가 더 크게 나타날 수 있습니다.`,
        `${dayPillar} 일주의 리듬에 맞춰 수면, 식사, 회복 루틴을 먼저 안정시키는 편이 몸의 균형을 되찾는 데 더 현실적인 출발점이 됩니다.`,
      ];
    case 11:
      return [
        `${input.name}님은 대운을 볼 때 한 시기의 성패보다 그 10년 동안 무엇을 밀고 무엇을 정리해야 하는지 큰 방향부터 잡으시는 편이 좋습니다.`,
        `${dayPillar} 일주 기준으로 대운의 변화가 역할감과 인간관계, 생활 리듬에 어떤 순서로 영향을 주는지 함께 보시면 계획을 세우기 훨씬 수월합니다.`,
      ];
    case 12:
      return [
        `${input.name}님은 연운을 해석할 때 결과를 미리 단정하기보다, 해마다 어떤 선택 방식이 유리한지 세밀하게 조정해 가는 태도가 중요합니다.`,
        `${dayPillar} 일주를 중심으로 각 해의 분위기를 읽어두시면 기회를 살릴 때와 속도를 늦출 때를 더 분명하게 구분하실 수 있습니다.`,
      ];
    default:
      return [
        `${input.name}님은 ${sectionTitle}을 해석할 때 결과를 단정적으로 받아들이기보다, 실제 생활에서 반복되는 선택 습관과 감정 반응을 함께 살펴보시는 편이 좋습니다.`,
        `${dayPillar} 일주를 중심으로 보면 지금 장에서 보이는 흐름도 결국 생활 장면과 연결해서 읽을수록 더 선명해질 수 있습니다.`,
      ];
  }
}

function buildLastResortPaddingParagraph(
  input: LlmGenerateInput,
  sectionNumber: number,
  sectionTitle: string,
): string {
  switch (sectionNumber) {
    case 7:
      return `${input.name}님은 연애와 결혼운을 읽으실 때 감정의 크기보다 표현 방식과 관계의 속도를 함께 조절하는 쪽이 더 실질적인 변화를 만들 수 있습니다.`;
    case 8:
      return `${input.name}님은 재물운을 읽으실 때 큰 승부보다 관리 습관을 먼저 고정하는 편이 실제 결과를 안정적으로 쌓는 데 더 유리할 수 있습니다.`;
    case 9:
      return `${input.name}님은 직업운을 읽으실 때 성과뿐 아니라 협업과 속도 조절 방식까지 함께 다듬을수록 훨씬 오래 가는 흐름을 만들 가능성이 큽니다.`;
    case 10:
      return `${input.name}님은 건강운을 읽으실 때 몸이 무너지는 순간만 보지 마시고 피로가 누적되는 생활 패턴을 먼저 정리하시는 편이 더 현실적입니다.`;
    case 11:
      return `${input.name}님은 대운을 읽으실 때 그 10년 전체의 방향을 먼저 잡고, 언제 밀고 언제 정리할지를 나눠 보는 방식이 훨씬 도움이 됩니다.`;
    case 12:
      return `${input.name}님은 연운을 읽으실 때 한 해의 결과보다 선택의 순서와 감정 조절 방식을 함께 보셔야 실제 활용도가 높아질 수 있습니다.`;
    default:
      return `${input.name}님은 ${sectionTitle} 장면을 읽으실 때 결론 하나만 보지 마시고, 최근 자주 반복되는 감정선과 생활 패턴을 함께 떠올려 보시면 좋습니다.`;
  }
}

function buildGuaranteedPaddingParagraph(
  input: LlmGenerateInput,
  sectionNumber: number,
  sectionTitle: string,
  round: number,
): string {
  const angleVariants = [
    "최근 3개월의 반복 장면을 먼저 기록해두세요.",
    "일·관계·건강 중 체감 변화가 큰 한 영역부터 실행해보세요.",
    "무엇을/언제/어떻게 할지 행동 단위로 적어두세요.",
    "결과보다 대응 순서를 바꿨을 때의 변화를 점검해보세요.",
  ];
  const riskVariants = [
    "강점을 밀어붙일수록 과잉 반응이 나오는 구간을 함께 관리해야 안정적입니다.",
    "감정이 올라오는 날의 결정은 하루 간격을 두면 시행착오를 줄일 수 있습니다.",
    "속도보다 지속성을 우선하면 장기 흐름이 훨씬 안정됩니다.",
    "한 번에 크게 바꾸기보다 주간 단위의 미세 조정이 더 효과적입니다.",
  ];
  const categoryHint =
    sectionNumber === 7 ? "관계 운영 방식" :
      sectionNumber === 8 ? "재정 관리 구조" :
        sectionNumber === 9 ? "직무/역할 운영 방식" :
          sectionNumber === 10 ? "회복 루틴과 생활 리듬" :
            sectionNumber === 11 ? "10년 단위 전략 전환" :
              sectionNumber === 12 ? "연도별 선택 우선순위" :
                `${sectionTitle}의 핵심 흐름`;

  const variants = [
    `${input.name}님은 ${categoryHint}을 기준으로 ${sectionTitle} 내용을 정리해보시면 적용력이 높아집니다. ${angleVariants[round % angleVariants.length]}`,
    `${input.name}님은 ${sectionTitle}에서 보이는 신호를 단정적으로 해석하기보다, 생활 장면에서 검증하며 조정하는 방식이 좋습니다. ${riskVariants[round % riskVariants.length]}`,
  ];
  return variants[round % variants.length];
}

export function buildReportPrompt(input: LlmGenerateInput): string {
  const sectionLines = SECTION_BLUEPRINTS.map((bp) => `- ${sectionHeadingExample(bp)}`).join("\n");
  return [
    buildContextBlock(input),
    "",
    "## 전체 목차(12장)",
    sectionLines,
    "",
    "## 출력 형식",
    "- 반드시 JSON만 출력하세요.",
    "- title/summary/sections(12)/elementBalance/disclaimer를 모두 포함하세요.",
    "- sections[n].heading은 예시처럼 `01. 제목 [라벨: NN/100]` 형식을 유지하세요.",
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
  options?: LlmRuntimeOptions,
): Promise<RawProviderResponse> {
  const apiKey = mustGetEnv("OPENAI_API_KEY");
  const model = resolveRequestedModel("openai", options);

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
  options?: LlmRuntimeOptions,
): Promise<RawProviderResponse> {
  const apiKey = mustGetEnv("GEMINI_API_KEY");
  const model = resolveRequestedModel("gemini", options);

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
  options?: LlmRuntimeOptions,
): Promise<RawProviderResponse> {
  if (provider === "openai") {
    return requestRawFromOpenAI(prompt, maxTokens, options);
  }
  return requestRawFromGemini(prompt, maxTokens, options);
}

async function callProviderJsonWithRetry<T>(params: {
  provider: RequestedProvider;
  prompt: string;
  schema: z.ZodType<T>;
  stage: string;
  maxTokens: number;
  debugCapture?: LlmDebugCapture;
  maxAttempts?: number;
  llmOptions?: LlmRuntimeOptions;
}): Promise<T> {
  const { provider, prompt, schema, stage, maxTokens, debugCapture, maxAttempts = 3, llmOptions } = params;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const rawResult = await requestRawFromProvider(provider, prompt, maxTokens, llmOptions);
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
    "- summary.highlights: 6~10개, 각 항목 80~120자로 구체적으로 작성",
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
  const formatSpecs = blueprints.map((bp) => buildSectionFormatSpec(input, bp.number)).filter(Boolean).join("\n\n");
  const referenceTexts = blueprints.map((bp) => buildSectionReferenceText(input, bp.number)).filter(Boolean).join("\n\n");

  return [
    buildContextBlock(input),
    "",
    buildDerivedPromptFacts(input),
    "",
    `## 작업: sections ${start}~${end} 생성`,
    "- 아래 목차만 생성하세요.",
    "- heading은 목차 번호/항목명/점수 형식을 유지하세요.",
    "- 각 section은 body(긴 본문)로 작성하세요.",
    "- [절대 규칙] 각 section.body는 최소 1200자 이상이어야 합니다. 1200자 미만이면 출력 전체가 실패로 간주됩니다.",
    "- body는 2,900~12,000자. 절대 2,700자 미만으로 쓰지 마세요. 최소 10개 이상의 문단으로 구성하고, 문단은 4~7문장 단위로 작성하세요.",
    `- [필수] 각 section body의 첫 문장 또는 첫 문단에는 반드시 고객 이름 "${input.name}님"을 호칭으로 포함하세요. 예: "${input.name}님의 ~", "${input.name}님은 ~". 신빙성을 위해 문두에 이름을 넣어주세요.`,
    "- 동일 주제를 반복하지 말고, 초년·청년·중년·말년·관계·조언 등 서로 다른 관점을 골고루 섞어주세요.",
    "- [중요] 각 장은 문체/서술 구조/예시 장면을 서로 다르게 작성하세요. 특히 문단 첫 문장 패턴과 결론 문장 패턴을 장마다 다르게 쓰세요.",
    "- [중요] 7~10장(소제목형 장)은 각 소제목마다 최소 180자 이상 작성하고, 한 줄 요약형 문장을 금지합니다.",
    "- [중요] 각 장은 '관찰 포인트 2개 + 생활 사례 1~2개 + 실행 단계 2개 이상'을 반드시 포함하세요.",
    "- [중요] 6장은 시주/일주/월주/연주 각각의 귀인 데이터를 반드시 명시하세요. 계산 데이터에 귀인이 없으면 반드시 '해당없음'이라고 쓰고 누락하지 마세요.",
    "- [금지] 아래 표현 톤을 장마다 거의 동일하게 반복하지 마세요: '작은 행동부터', '메모해두시면', '핵심 흐름 하나를 골라', '강점은 유지하고 부담은 줄이는 방향'.",
    "- 전문 용어는 한자(漢字)를 병기하면 가독성이 좋습니다. 예: 재물(財物), 관운(官運).",
    "- 생성 완료 전 각 section.body 글자 수를 스스로 점검하고, 1200자 미만이 하나라도 있으면 스스로 확장 후 출력하세요.",
    "- JSON만 출력하세요.",
    "",
    "## 목차",
    sectionLines,
    "",
    "## 장별 형식 규칙",
    formatSpecs,
    "",
    "## 장별 기준 원고/설명 스타일",
    referenceTexts,
    "",
    "## JSON 스키마",
    "{",
    '  "sections": [',
    '    { "heading": "string", "body": "string" }',
    "  ]",
    "}",
  ].join("\n");
}

function buildSectionsCompactPrompt(input: LlmGenerateInput, start: number, end: number): string {
  const blueprints = SECTION_BLUEPRINTS.slice(start - 1, end);
  const sectionLines = blueprints.map((bp) => `- ${sectionHeadingExample(bp)}`).join("\n");
  const formatSpecs = blueprints.map((bp) => buildSectionFormatSpec(input, bp.number)).filter(Boolean).join("\n\n");
  const referenceTexts = blueprints.map((bp) => buildSectionReferenceText(input, bp.number)).filter(Boolean).join("\n\n");

  return [
    buildContextBlock(input),
    "",
    buildDerivedPromptFacts(input),
    "",
    `## 긴급 작업: sections ${start}~${end} 축약 생성`,
    "- 반드시 유효한 JSON만 출력하세요.",
    "- 각 section은 body로 작성하세요.",
    "- [절대 규칙] 각 section.body는 최소 1200자 이상이어야 합니다. 1200자 미만이면 출력 전체가 실패로 간주됩니다.",
    "- body는 2,600~6,000자. 절대 2,300자 미만으로 쓰지 마세요. 최소 9개 이상의 문단으로 구성하세요.",
    `- [필수] 각 section body의 첫 문장에는 고객 이름 "${input.name}님"을 호칭으로 포함하세요. 예: "${input.name}님의 ~", "${input.name}님은 ~".`,
    "- [중요] 장마다 문단 시작 패턴과 결론 패턴을 다르게 작성하고, 같은 조언 문구를 반복하지 마세요.",
    "- [중요] 7~10장(소제목형 장)은 각 소제목마다 최소 160자 이상 작성하고, 한 줄 요약형 문장을 금지합니다.",
    "- [중요] 각 장은 생활 사례 1개 이상과 실행 단계 2개 이상을 포함하세요.",
    "- [중요] 6장은 시주/일주/월주/연주 각각의 귀인 데이터를 반드시 명시하세요. 계산 데이터에 귀인이 없으면 반드시 '해당없음'이라고 쓰고 누락하지 마세요.",
    "- 생성 완료 전 각 section.body 글자 수를 스스로 점검하고, 1200자 미만이 하나라도 있으면 스스로 확장 후 출력하세요.",
    "- 전문 용어는 한자(漢字) 병기를 권장합니다.",
    "",
    "## 목차",
    sectionLines,
    "",
    "## 장별 형식 규칙",
    formatSpecs,
    "",
    "## 장별 기준 원고/설명 스타일",
    referenceTexts,
    "",
    "## JSON 스키마",
    "{",
    '  "sections": [',
    '    { "heading": "string", "body": "string" }',
    "  ]",
    "}",
  ].join("\n");
}

function buildTailPrompt(input: LlmGenerateInput): string {
  return [
    buildContextBlock(input),
    "",
    "## 작업: elementBalance/disclaimer 생성",
    "- elementBalance.analysis(500~900자), elementBalance.tips(5~10개, 각 100~180자), disclaimer만 생성하세요.",
    "- 내용이 부실하지 않도록 구체적으로 작성하고, 전문 용어는 한자 병기를 권장합니다.",
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

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const HANJA_PRONUNCIATION_MAP: Record<string, string> = {
  陰陽五行: "음양오행",
  四柱八字: "사주팔자",
  四柱: "사주",
  十神: "십신",
  十星: "십성",
  十二運星: "십이운성",
  天干: "천간",
  地支: "지지",
  甲: "갑",
  乙: "을",
  丙: "병",
  丁: "정",
  戊: "무",
  己: "기",
  庚: "경",
  辛: "신",
  壬: "임",
  癸: "계",
  子: "자",
  丑: "축",
  寅: "인",
  卯: "묘",
  辰: "진",
  巳: "사",
  午: "오",
  未: "미",
  申: "신",
  酉: "유",
  戌: "술",
  亥: "해",
};

function annotateKnownHanjaWithReading(text: string): string {
  const terms = Object.keys(HANJA_PRONUNCIATION_MAP).sort((a, b) => b.length - a.length);
  if (terms.length === 0) return text;
  const pattern = new RegExp(`(${terms.map(escapeRegex).join("|")})(?!\\s*\\()`, "g");
  return text.replace(pattern, (match) => `${match}(${HANJA_PRONUNCIATION_MAP[match]})`);
}

function dedupeParagraphs(text: string): string {
  const parts = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  const kept: string[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    const key = part.replace(/\s+/g, " ").toLowerCase();
    if (key.length < 24) {
      kept.push(part);
      continue;
    }
    const shortKey = key.slice(0, 140);
    if (seen.has(shortKey)) continue;
    seen.add(shortKey);
    kept.push(part);
  }
  return kept.join("\n\n");
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

// NOTE: 기존 bullets 기반 코드 제거됨 (body 기반으로 전환).

function normalizeSection(section: { heading: string; body: string }, sectionNumber: number): ReportSection {
  const blueprint = getSectionBlueprint(sectionNumber);
  const body = annotateKnownHanjaWithReading(String(section.body || "").trim());
  return {
    heading: normalizeHeading(section.heading, blueprint),
    body: dedupeParagraphs(body),
  };
}

function extractPlainText(raw: string): string {
  let text = String(raw ?? "").trim();
  const fenceStart = text.indexOf("```");
  if (fenceStart !== -1) {
    const fenceEnd = text.lastIndexOf("```");
    if (fenceEnd !== -1 && fenceEnd > fenceStart) {
      text = text.slice(fenceStart + 3, fenceEnd).trim();
      if (/^text\b/i.test(text)) text = text.replace(/^text\b/i, "").trim();
      if (/^markdown\b/i.test(text)) text = text.replace(/^markdown\b/i, "").trim();
      if (/^json\b/i.test(text)) text = text.replace(/^json\b/i, "").trim();
    }
  }
  return text.trim();
}

async function expandSectionBodyIfNeeded(params: {
  provider: RequestedProvider;
  input: LlmGenerateInput;
  sectionNumber: number;
  section: ReportSection;
  targetMinChars: number;
  llmOptions?: LlmRuntimeOptions;
}): Promise<ReportSection> {
  const { provider, input, sectionNumber, section, targetMinChars, llmOptions } = params;
  if (section.body.length >= targetMinChars) return section;

  const blueprint = getSectionBlueprint(sectionNumber);
  const prompt = [
    buildContextBlock(input),
    "",
    buildDerivedPromptFacts(input),
    "",
    "## 작업",
    `아래는 ${String(sectionNumber).padStart(2, "0")}장 본문 초안입니다. 같은 의미를 반복하지 말고, 내용 밀도를 유지하면서 더 풍부하게 확장해 주세요.`,
    "",
    "## 출력 규칙 (강제)",
    "- 텍스트만 출력 (JSON/마크다운/코드블록 금지).",
    "- 존댓말, 부드럽고 정감 있는 어투.",
    `- 첫 문장 또는 첫 문단은 반드시 "${input.name}님"으로 시작.`,
    `- 최소 ${targetMinChars}자 이상. 가능하면 3,300자 내외까지 밀도 있게 확장.`,
    "- 문단은 9개 이상. 문단당 3~6문장.",
    `- 장 주제("${blueprint.title}")에 맞게: 원인 → 해석 → 생활 장면 사례 1~2개 → 실행 단계 포함 조언(무엇/언제/어떻게) → 요약 정리.`,
    "- 기존 초안의 표현을 그대로 반복하지 말고, 문장 구조와 사례를 새롭게 재작성.",
    "- 각 확장 문단마다 정보 밀도(근거/맥락/실행)가 보이도록 작성하세요. 빈 수식어만 늘리지 마세요.",
    buildSectionFormatSpec(input, sectionNumber),
    buildSectionReferenceText(input, sectionNumber),
    "- 체크리스트/고정 표현을 그대로 복붙하지 말고, 이 장에 맞게 새 문장으로 작성.",
    "",
    "## 초안(확장 대상)",
    section.body,
  ].join("\n");

  const expandedRaw = await requestRawFromProvider(provider, prompt, 4600, llmOptions);
  const expanded = extractPlainText(expandedRaw.raw);
  if (!expanded) return section;
  return { ...section, body: expanded };
}

function ensureMinSectionBody(params: {
  input: LlmGenerateInput;
  sectionNumber: number;
  section: ReportSection;
  minChars: number;
}): ReportSection {
  const { input, sectionNumber, section, minChars } = params;
  if (section.body.length >= minChars) return section;

  if (section.body.trim().length < 400) {
    return buildFallbackSection(input, sectionNumber);
  }

  let body = section.body.trim();
  if (!body.startsWith(`${input.name}님`) && !body.slice(0, 80).includes(input.name)) {
    body = `${input.name}님, ${body}`;
  }

  const fallbackBody = buildFallbackSection(input, sectionNumber).body;
  const fallbackParagraphs = fallbackBody
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);

  for (const paragraph of fallbackParagraphs) {
    if (body.length >= minChars) break;
    const marker = paragraph.replace(/\s+/g, " ").slice(0, 32);
    if (marker && body.replace(/\s+/g, " ").includes(marker)) continue;
    body += `\n\n${paragraph}`;
  }

  if (body.length < minChars) {
    const guard = buildSectionGuardSuffix(input, sectionNumber).trim();
    if (guard && !body.includes(guard)) {
      body += `\n\n${guard}`;
    }
  }

  if (body.length < minChars) {
    const blueprint = getSectionBlueprint(sectionNumber);
    let round = 0;
    while (body.length < minChars) {
      const next = buildGuaranteedPaddingParagraph(input, sectionNumber, blueprint.title, round).trim();
      if (next) {
        body += `\n\n${next}`;
      }
      round += 1;
      if (round > 24) break;
    }
  }

  if (body.length < minChars) {
    const blueprint = getSectionBlueprint(sectionNumber);
    body += `\n\n${buildLastResortPaddingParagraph(input, sectionNumber, blueprint.title)}`;
  }

  if (body.length < minChars) {
    // Absolute final safeguard: duplicate the last meaningful paragraph to satisfy schema minimum.
    // This path should be extremely rare and only triggers when model output is unexpectedly short.
    const paragraphs = body.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    const last = paragraphs.at(-1) || `${input.name}님, 현재 흐름을 점검하며 다음 선택을 차분히 정리해보시면 좋습니다.`;
    while (body.length < minChars) {
      body += `\n\n${last}`;
    }
  }

  return { ...section, body: annotateKnownHanjaWithReading(body) };
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
  const sections = SECTION_BLUEPRINTS.map((bp) => buildFallbackSection(input, bp.number));
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
  llmOptions?: LlmRuntimeOptions,
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
      llmOptions,
    });
  } catch (err) {
    if (err instanceof LlmRequestError) {
      return buildFallbackReport(input);
    }
    throw err;
  }
}

export function buildFallbackSection(input: LlmGenerateInput, sectionNumber: number): ReportSection {
  const blueprint = getSectionBlueprint(sectionNumber);
  const heading = sectionHeadingFallback(blueprint);

  const ext = computeSajuExtended(input.saju.fourPillarsKorean);
  const dayPillar = input.saju.fourPillarsKorean.day;
  const named = (label: string, text: string) => `${label}\n${text}`;
  let body = "";

  switch (sectionNumber) {
    case 1:
      body = [
        `${input.name}님, 사주에 대한 장은 본격적인 해석에 앞서 전체 리포트를 읽는 기준을 잡아드리는 부분입니다.`,
        "사주는 태어난 연월일시의 네 기둥을 통해 성향과 리듬을 읽는 도구이기 때문에, 한 장면만 떼어서 보기보다 흐름 전체를 함께 보는 방식이 중요합니다.",
        `특히 ${dayPillar} 일주를 중심축으로 삼고 다른 기둥과 연결해서 보면, 겉으로 드러나는 성향과 실제로 반복되는 선택 습관을 같이 살펴볼 수 있습니다.`,
        "이 리포트는 장마다 주제가 다르지만 결국 하나의 흐름으로 이어지므로, 앞장에서 잡은 기준이 뒤 장의 성격, 관계, 재물, 건강, 운세 해석과 자연스럽게 연결됩니다.",
        "따라서 이 장은 결과를 단정하는 소개가 아니라, 이후 내용을 어떻게 읽어야 하는지 감을 잡는 장으로 이해하시면 좋습니다.",
      ].join("\n\n");
      break;
    case 2:
      body = [
        `${input.name}님, 먼저 음양은 모든 존재와 현상이 서로 다른 두 성질 사이의 균형으로 움직인다는 원리입니다. 음은 안으로 모으고 가라앉히는 힘, 양은 밖으로 드러내고 확장시키는 힘으로 이해하시면 좋아요.`,
        "오행은 목화토금수의 다섯 기운으로, 사람의 성향과 반응 패턴을 보다 구체적으로 읽기 위한 기준입니다. 중요한 것은 어느 하나가 무조건 좋거나 나쁘다는 것이 아니라, 어떤 기운이 강하고 어떤 기운이 비어 있는지에 따라 생활 방식이 달라진다는 점입니다.",
        "또한 오행은 상생과 상극의 원리로 이어집니다. 서로 도와 성장을 만드는 흐름도 있고, 과한 치우침을 제어하는 흐름도 있기 때문에, 이 관계를 함께 봐야 실제 생활과 연결된 해석이 가능합니다.",
        named(`${input.name}님의 음양오행 구성`, ext ? `${input.name}님의 오행 분포는 목 ${ext.elementPcts.목}%(${ext.elementCounts.목}개), 화 ${ext.elementPcts.화}%(${ext.elementCounts.화}개), 토 ${ext.elementPcts.토}%(${ext.elementCounts.토}개), 금 ${ext.elementPcts.금}%(${ext.elementCounts.금}개), 수 ${ext.elementPcts.수}%(${ext.elementCounts.수}개)입니다. 강한 기운은 생활의 기본 성향으로, 약한 기운은 보완 포인트로 작용할 가능성이 있습니다.` : `${input.name}님의 오행 분포는 일상에서 어떤 기운이 강하고 약한지 확인하는 기준이 됩니다.`),
        named(`${input.name}님의 음양에 대한 설명`, ext ? `${input.name}님의 사주는 양 ${ext.yinYangPct.yang}%, 음 ${ext.yinYangPct.yin}%의 비율로 나타납니다. 이 비율은 외부로 에너지를 발산하는 방식과 내면에서 판단을 정리하는 방식 사이의 균형을 보여줍니다.` : `${input.name}님의 음양 비율은 행동 속도와 관계 반응의 결을 읽는 데 도움이 됩니다.`),
        named(`${input.name}님의 일주에 대한 설명`, `${input.name}님의 일주는 ${dayPillar}입니다. 일주는 사주 전체에서 성격의 중심축처럼 작동하기 때문에, 이후 장들의 해석도 이 기준과 함께 읽을수록 더 선명해집니다.`),
        "종합적으로 보면 이 장은 단순히 오행 개수를 세는 장이 아니라, 어떤 기운이 나를 밀어주고 어떤 기운이 생활에서 자꾸 보완을 요구하는지를 확인하는 장입니다.",
      ].join("\n\n");
      break;
    case 3:
      body = [
        `${input.name}님, ${dayPillar} 일주에 대한 성격을 분석해드리겠습니다.`,
        [
          "일간을 기준으로 한 성격 분석",
          "",
          "강한 결단력",
          "특징 : 일간은 스스로 기준을 세우는 방식과 결단의 리듬을 보여줍니다.",
          "영향 : 일이든 관계든 한 번 방향을 정하면 쉽게 흔들리지 않으려는 모습으로 이어질 수 있습니다.",
          "",
          "책임감 있는 성향",
          "특징 : 책임을 지는 태도가 비교적 분명하게 드러날 수 있습니다.",
          "영향 : 신뢰를 얻는 강점이 되지만 때로는 부담도 혼자 떠안을 수 있습니다.",
          "",
          "원칙과 규율 존중",
          "특징 : 원칙을 먼저 생각하는 순간이 자주 생길 수 있습니다.",
          "영향 : 위기 상황에서는 강점이지만 친밀한 관계에서는 차갑게 보일 수도 있습니다.",
          "",
          "준비된 분야에서의 추진력",
          "특징 : 준비가 된 분야에서는 추진력이 붙는 편입니다.",
          "영향 : 익숙한 영역에서는 성과가 빠르지만 낯선 영역에서는 시작이 늦어질 수 있습니다.",
          "",
          "자기 확신",
          "특징 : 자기 확신이 생긴 뒤에는 의사결정이 단단해집니다.",
          "영향 : 리더십으로 보일 수 있으나 타협이 어려워 보일 여지도 있습니다.",
        ].join("\n"),
        [
          "일지를 기준으로 한 성격 분석",
          "",
          "유연한 사고방식",
          "특징 : 일지는 감정이 머무는 방식과 가까운 관계에서의 반응을 보여줍니다.",
          "영향 : 겉으로 차분해 보여도 안에서는 오래 고민하는 패턴으로 이어질 수 있습니다.",
          "",
          "주변 분위기를 읽는 감각",
          "특징 : 주변 분위기를 읽는 감각이 섬세할 수 있습니다.",
          "영향 : 사람을 세심하게 보지만 그만큼 피로도도 커질 수 있습니다.",
          "",
          "변화에 대한 적응력",
          "특징 : 변화에 대한 적응력이 비교적 빠를 수 있습니다.",
          "영향 : 새로운 환경에서는 강점이 되지만 기준이 흐려지면 우왕좌왕할 수도 있습니다.",
          "",
          "예민한 감각",
          "특징 : 반복되는 불편을 쉽게 지나치지 못합니다.",
          "영향 : 작은 신호를 빨리 알아차리지만 스트레스가 오래 남을 수 있습니다.",
          "",
          "정서적 안전지대",
          "특징 : 정서적 안전지대를 중요하게 생각합니다.",
          "영향 : 믿는 사람에게는 깊이 연결되지만 불편한 관계와는 거리를 크게 둘 수 있습니다.",
        ].join("\n"),
        `일간과 일지를 기준으로 한 종합적인 성격분석\n${input.name}님은 겉으로는 기준감이 있고 안으로는 감정의 결이 섬세한 흐름으로 읽을 수 있습니다. 그래서 자신만의 기준을 지키면서도, 감정 피로를 덜 쌓는 방향으로 속도를 조절하는 것이 중요합니다.`,
      ].join("\n\n");
      break;
    case 4:
      body = `${input.name}님, 먼저 초년기를 의미하는 연주부터 풀이해드리겠습니다.\n연주는 어린 시절의 환경과 초반 사회화 과정에서 형성된 태도를 읽는 데 도움이 됩니다.\n\n다음으로 청년기를 의미하는 월주를 풀이해드리겠습니다.\n월주는 사회생활과 역할 수행, 현실 감각이 가장 강하게 드러나는 자리이므로 직업과 인간관계에서 자주 체감되는 패턴으로 이어질 가능성이 큽니다.\n\n다음으로 중년기를 의미하는 일주를 풀이해드리겠습니다.\n일주는 자기 자신과 가까운 관계의 의미를 함께 지니므로, 실제 성격의 중심과 반복 반응을 읽는 핵심 기준이 됩니다.\n\n마지막으로 말년기를 의미하는 시주를 풀이해드리겠습니다.\n시주는 시간이 갈수록 더 선명해지는 가치관과 인생 후반의 정리 방식을 보여주기 때문에, 장기 계획과 후반부 인간관계를 볼 때 중요합니다.\n\n종합적으로 보면 이 사주의 십성 흐름은 시기마다 강조되는 역할이 조금씩 다르게 나타날 가능성이 있습니다. 결국 중요한 것은 강한 기운을 무조건 밀어붙이는 것이 아니라, 시기마다 필요한 역할을 어떻게 조절하느냐에 있습니다.`;
      break;
    case 5:
      body = `${input.name}님, 이 사주의 십이운성을 보면 각각의 운성이 삶의 시기마다 다른 리듬을 만들어내고 있습니다.\n\n먼저 초년기를 의미하는 연주부터 보겠습니다.\n연주의 십이운성은 어린 시절의 에너지 표현 방식과 초반 환경 적응력을 보여줍니다.\n\n다음으로 청년기를 의미하는 월주를 풀이해드리겠습니다.\n월주의 십이운성은 사회적 역할, 직업 감각, 현실에서 부딪히는 시행착오와 연결되기 쉽습니다.\n\n다음으로 중년기를 의미하는 일주를 풀이해드리겠습니다.\n일주의 십이운성은 자기 중심과 관계 피로, 삶의 방향을 다시 정리하는 전환점으로 읽히는 경우가 많습니다.\n\n마지막으로 말년기를 의미하는 시주를 풀이해드리겠습니다.\n시주의 십이운성은 후반부의 마무리, 정신적 안정, 인생의 결실과 관련해 해석할 수 있습니다.\n\n종합적으로 보면 이 장은 한 번에 강약을 판정하는 장이 아니라, 어느 시기에 에너지가 올라오고 어느 시기에 속도 조절이 필요한지를 읽는 장입니다.`;
      break;
    case 6: {
      const gwinByPillar = ext
        ? {
            year: ext.pillars[3].gwin.length ? ext.pillars[3].gwin.join(", ") : "해당없음",
            month: ext.pillars[2].gwin.length ? ext.pillars[2].gwin.join(", ") : "해당없음",
            day: ext.pillars[1].gwin.length ? ext.pillars[1].gwin.join(", ") : "해당없음",
            hour: ext.pillars[0].gwin.length ? ext.pillars[0].gwin.join(", ") : "해당없음",
          }
        : { year: "해당없음", month: "해당없음", day: "해당없음", hour: "해당없음" };
      body = `${input.name}님, 이 사주를 보면 십이신살과 귀인의 조합이 삶의 장면마다 다른 방식으로 작용할 가능성이 있습니다.\n\n십이신살에 대해 먼저 풀이해보겠습니다!\n먼저 초년기를 의미하는 연주부터 분석해보겠습니다.\n연주는 초반 환경에서 어떤 인연과 긴장감을 먼저 배우게 되는지 읽는 데 도움이 됩니다.\n\n다음으로 청년기를 의미하는 월주를 알아보겠습니다.\n월주는 사회 진입기나 직업 환경에서 반복되는 변화와 이동, 관계의 강약으로 체감될 수 있습니다.\n\n다음으로 중년기를 의미하는 일주를 보겠습니다.\n일주는 가까운 인간관계와 자기 감정선이 만나는 자리라 실제 생활 피로와 맞닿는 경우가 많습니다.\n\n말년기를 의미하는 시주를 보겠습니다.\n시주는 후반부의 관심사, 내면 성찰, 인간관계 정리 방식과 연결해서 읽어볼 수 있습니다.\n\n이제 귀인에 대해서 알아볼까요?\n연주의 귀인은 ${gwinByPillar.year}, 월주의 귀인은 ${gwinByPillar.month}, 일주의 귀인은 ${gwinByPillar.day}, 시주의 귀인은 ${gwinByPillar.hour}입니다.\n귀인은 어려운 순간에 누구의 도움을 받기 쉬운지, 혹은 어떤 환경에서 숨통이 트이는지를 보여주는 보조 지표입니다.\n\n종합적으로 보면 이 사주는 신살이 주는 사건성만 볼 것이 아니라, 귀인이 그 흐름을 어떻게 완충해 주는지까지 같이 읽어야 합니다.`;
      break;
    }
    case 7:
      body = [
        named("연애운 풀이", `${input.name}님의 연애운은 감정의 깊이와 관계의 속도 조절을 함께 봐야 하는 흐름입니다. 감정이 생겼을 때 빠르게 확신을 만들기보다, 상대와의 대화 빈도·약속 이행·갈등 해결 방식이 안정적인지 시간을 두고 확인할수록 만족도가 높아질 가능성이 큽니다.`),
        named("일간 성격과 연애 성향", `${input.name}님은 신뢰가 쌓일수록 관계에 깊게 들어가는 편일 가능성이 있습니다. 다만 마음이 커질수록 기대치도 함께 올라갈 수 있으니, 원하는 관계 방식과 불편한 지점을 초반부터 구체적으로 공유하면 관계 피로를 줄이는 데 도움이 됩니다.`),
        named("연애에서 나타나는 장단점", "장점은 진지함과 책임감으로 관계의 안정감을 만들 수 있다는 점입니다. 반면 단점은 기준이 높아지면서 실망도 커질 수 있다는 부분이므로, 상대의 표현 방식이 나와 다를 수 있다는 전제를 두고 대화를 이어가는 태도가 필요합니다."),
        named("연애 시기와 방법", "관계가 급하게 진전되기보다 일상 속 대화와 신뢰를 통해 깊어지는 방식이 더 잘 맞을 수 있습니다. 특히 바쁜 시기일수록 짧더라도 규칙적인 연락 리듬을 유지하면 오해를 줄이고 관계의 안정성을 높일 수 있습니다."),
        named("살과 귀인의 영향", "신살의 작용이 강한 시기에는 관계의 기복이 커질 수 있고, 귀인의 흐름이 좋을 때는 좋은 인연이 들어올 가능성이 있습니다. 이 시기에는 감정 반응을 즉시 결론으로 연결하지 말고, 최소 하루 간격으로 생각을 정리한 뒤 대화하는 방식이 도움이 됩니다."),
        named("성공적인 연애를 위한 조언", "서운함이 쌓이기 전에 작은 단위로 말하는 습관이 중요합니다. '무엇이 불편했는지-왜 힘들었는지-앞으로 어떻게 맞출지' 순서로 전달하면 감정 소모를 줄이면서도 관계를 실제로 개선할 수 있습니다."),
        named("나의 결혼운", "결혼운은 감정보다 생활 리듬과 책임 분담이 맞는 사람과 안정적으로 이어질 가능성이 큽니다. 결혼을 고려할수록 가치관보다도 생활 운영 방식(시간, 돈, 가족, 휴식)에 대한 합의가 중요한 판단 기준이 됩니다."),
        named("이상적인 배우자상과 피해야할 배우자상", "이상적인 배우자는 감정 표현이 안정적이고 약속을 가볍게 넘기지 않는 사람입니다. 반대로 중요한 문제를 회피하거나 감정 기복이 큰 상황에서 대화를 끊어버리는 유형은 장기적으로 피로를 키울 수 있으니 주의가 필요합니다."),
        named("배우자와의 관계 전망", "서로 기준을 존중하고 대화 속도를 맞춘다면 오래 갈 가능성이 있습니다. 갈등이 생겼을 때 승부를 보려는 태도보다 문제를 구조적으로 나눠 해결하는 태도를 유지하면, 관계 만족도와 신뢰가 함께 높아질 수 있습니다."),
        named("연애에서 피해야 할 점", "마음속 결론을 먼저 내리고 상대를 시험하듯 보는 태도는 피하시는 편이 좋습니다. 확인되지 않은 추측을 사실처럼 다루면 관계가 빠르게 소모될 수 있으니, 감정이 커질수록 사실 확인과 질문 중심 대화로 방향을 잡으세요."),
        named("종합분석", `${input.name}님의 연애와 결혼운은 진심의 깊이는 충분하지만 표현 방식과 타이밍에 따라 체감 차이가 크게 나타날 수 있습니다. 핵심은 감정의 크기보다 관계 운영 방식이며, 대화 루틴과 기대 조율을 함께 가져갈수록 안정적인 흐름을 만들 가능성이 큽니다.`),
      ].join("\n\n");
      break;
    case 8:
      body = [
        named("재물운 풀이", `${input.name}님의 재물운은 한 번의 기회보다 관리 습관과 선택의 속도에서 차이가 벌어질 가능성이 있습니다. 큰 수입이 들어오는 순간보다, 그 수입을 지키고 다시 불릴 구조를 얼마나 일찍 만들었는지가 장기 성과를 좌우할 수 있습니다.`),
        named("일간 성격과 재물운", "기준과 계획을 중시하는 태도는 재물 관리에서 강점이 될 수 있습니다. 다만 계획이 세밀할수록 실행이 늦어질 수 있으니, 월 단위 점검표처럼 간단한 운영 도구를 먼저 고정하고 점차 정교화하는 방식이 효율적입니다."),
        named("시간에 따른 재물운의 흐름", "초년은 기반, 청년은 탐색, 중년은 축적과 확장, 말년은 안정과 보전의 흐름으로 읽는 방식이 현실적입니다. 각 시기마다 목표가 달라야 하며, 특히 중년기에는 수입 다변화와 리스크 분산을 함께 설계해야 변동성에 흔들리지 않을 수 있습니다."),
        named("재물운이 크게 들어오는 시기", "수입 자체보다 성과를 구조화할 수 있는 시기가 더 중요하게 작용할 수 있습니다. 운이 들어오는 구간에서는 지출 확대보다 안전자산·현금흐름·고정비 관리 순서로 정리하면 상승 흐름을 더 오래 유지할 수 있습니다."),
        named("살과 귀인의 영향", "신살은 돈이 들어오고 나가는 사건성을 키울 수 있고, 귀인은 좋은 조언을 받을 통로로 작용할 수 있습니다. 즉, 변동성이 커질 때는 단독 판단보다 검증 가능한 조언 루트를 확보하는 것이 손실을 줄이는 데 실질적으로 도움이 됩니다."),
        named("주의해야 될 시기", "감정 피로가 큰 시기에는 보상 소비나 조급한 판단이 겹칠 수 있으니 주의가 필요합니다. 이때는 고정 지출부터 재점검하고, 큰 금액의 결정은 최소 24시간 숙려 규칙을 두는 방식이 재정 안전성을 높입니다."),
        named("어떻게 재물을 모으게 될까?", "반복 가능한 관리 습관과 지출 점검 구조를 먼저 만드는 편이 유리합니다. 월별 저축률보다도 '자동이체-지출 분류-주간 점검'의 3단 구조를 고정하면 재물 축적 속도가 훨씬 안정적으로 올라갈 수 있습니다."),
        named("성공적인 재물의 축적 방법", "예산 금액만이 아니라 점검 횟수와 소비 패턴을 함께 관리하시는 편이 좋습니다. 특히 지출의 감정 트리거(스트레스, 피로, 비교심리)를 파악하면 불필요한 누수를 줄이고 실질적인 순자산 증가로 연결하기 쉬워집니다."),
        named("종합분석", `${input.name}님의 재물운은 기회의 크기보다 관리 방식에 따라 체감 차이가 커질 수 있는 구조입니다. 핵심은 운이 좋을 때 확장만 하지 않고 보전 구조를 함께 만들며, 운이 약할 때는 손실 관리와 루틴 유지로 기초 체력을 지키는 데 있습니다.`),
      ].join("\n\n");
      break;
    case 9:
      body = [
        named("직업운 풀이", `${input.name}님의 직업운은 능력을 어디에 쓰느냐 못지않게, 어떤 방식으로 역할을 맡고 유지하느냐가 중요할 수 있습니다. 업무 성과는 단기 폭발력보다 역할의 지속 가능성에서 갈릴 가능성이 크므로, 본인의 강점을 반복 가능한 구조로 만드는 것이 핵심입니다.`),
        named("나의 일간 성격에 맞는 직업, 직무", "성향과 리듬이 맞는 구조를 먼저 보는 편이 좋습니다. 즉흥 대응이 많은 환경보다 기준을 세우고 개선해 나갈 수 있는 직무에서 강점이 오래 유지되며, 문제 해결형 업무에서 만족도와 성과가 함께 올라갈 가능성이 큽니다."),
        named("나의 직장운", "직장운은 조직 안에서 신뢰를 쌓는 흐름과 연결되기 쉽습니다. 상사·동료와의 커뮤니케이션에서 '결론-근거-요청사항' 구조를 유지하면 불필요한 오해를 줄이고, 책임 있는 역할로 빠르게 확장될 가능성이 있습니다."),
        named("나의 사업운", "독립성과 실행력이 살아날 때 강점이 드러날 수 있지만, 속도가 너무 빨라지면 리스크도 커질 수 있습니다. 사업 흐름에서는 매출보다 현금흐름과 재투자 비율을 먼저 관리해야 하며, 파트너십 계약은 조건을 문서화해 분쟁 비용을 줄이는 것이 중요합니다."),
        named("십이신살과 귀인의 영향", "신살은 직업 변화나 환경 이동의 사건성으로, 귀인은 협업과 이직에서 도움을 받는 통로로 작용할 수 있습니다. 따라서 변동이 커지는 시기에는 혼자 결정하기보다 검증 가능한 조언과 데이터에 기반해 선택하면 시행착오를 줄일 수 있습니다."),
        named("성공적인 직장생활을 위한 조언", "중요한 대화 전에는 핵심 쟁점을 메모로 정리하고, 감정이 올라온 날에는 즉답보다 간격을 두는 방식이 도움이 됩니다. 또한 주간 단위로 '성과-리스크-다음 행동'을 리뷰하면 직무 안정성과 성장 속도를 동시에 끌어올리기 좋습니다."),
        named("종합분석", `${input.name}님의 직업운은 역할의 무게를 잘 버틸 수 있는 힘이 있지만, 오래 가려면 속도 조절과 소통 방식이 함께 필요합니다. 결국 커리어 성장은 능력 자체보다 역할 운영 능력에서 완성되므로, 기준을 명확히 하고 협업 품질을 높이는 전략이 가장 유효합니다.`),
      ].join("\n\n");
      break;
    case 10:
      body = [
        named("건강운 풀이", `${input.name}님의 건강운은 피로가 누적되는 방식과 회복 리듬이 어떻게 무너지는지를 함께 보는 편이 더 정확합니다. 몸은 갑자기 무너지는 것처럼 보여도 실제로는 수면, 식사, 스트레스 관리가 조금씩 흔들리며 누적된 결과가 많기 때문에 일상 루틴의 안정성이 핵심 지표가 됩니다.`),
        named("나의 건강운", "컨디션은 일정, 수면, 감정 소모와 직접적으로 연결될 가능성이 큽니다. 특히 집중이 오래 필요한 시기에는 회복 시간을 미리 고정하지 않으면 피로가 급격히 쌓일 수 있으므로, 일정표에 휴식 슬롯을 먼저 배치하는 방식이 효과적입니다."),
        named("십이신살과 귀인의 영향", "신살이 강한 시기에는 이동성 피로와 인간관계 스트레스가 몸으로 드러날 수 있고, 귀인은 회복을 돕는 사람이나 환경을 뜻할 수 있습니다. 이 시기에는 무리한 도전보다 회복 우선 전략을 택하고, 필요하면 주변 도움을 적극적으로 요청하는 것이 건강 손실을 줄이는 데 유리합니다."),
        named("시기에 따른 나의 건강운", "초년은 기본 체력, 청년은 과로와 긴장, 중년은 누적 피로, 말년은 회복 속도와 안정 루틴이 핵심이 될 가능성이 큽니다. 시기별로 관리 포인트가 다르므로 같은 방법을 고집하기보다 현재 단계에 맞는 관리 강도를 조정해야 지속 가능한 건강 상태를 만들 수 있습니다."),
        named("주의해야 할 질병", "특정 장기 하나를 단정하기보다, 스트레스가 쌓일 때 취약해지는 부위를 먼저 체크하시는 편이 현실적입니다. 반복되는 두통, 소화 불편, 수면 질 저하처럼 작은 신호를 초기에 관리하면 큰 문제로 번질 가능성을 낮출 수 있습니다."),
        named("추천 운동", "걷기, 가벼운 근력 운동, 스트레칭처럼 회복과 순환을 함께 챙길 수 있는 루틴이 잘 맞을 수 있습니다. 강도보다 지속성이 중요하므로 주 3~4회, 20~40분 단위로 무리 없이 이어가는 계획이 건강운 안정에 더 효과적입니다."),
        named("추천 식단", "규칙적인 식사와 소화가 편안한 식단을 우선하는 편이 좋습니다. 늦은 밤 과식·자극적인 음식·수분 부족을 줄이고, 단백질과 채소 비율을 안정적으로 유지하면 피로 회복 속도와 집중력 유지에 도움이 됩니다."),
        named("종합분석", `${input.name}님의 건강운은 큰 사건보다 작은 무너짐이 반복될 때 체감 차이가 커질 수 있습니다. 따라서 몸이 보내는 초기 신호를 놓치지 않고 루틴을 먼저 정비하는 태도가 가장 현실적인 건강 관리 전략이 됩니다.`),
      ].join("\n\n");
      break;
    case 11: {
      const daewoon = ext ? computeDaewoonTable(input.saju.fourPillarsKorean, ext.dayStem, input.gender) : null;
      body = daewoon
        ? [
          `이 표는 ${input.name}님의 대운표입니다. 대운은 10년 단위의 큰 흐름을 보여주므로, 각 시기의 방향과 속도를 읽는 기준이 됩니다.`,
          ...daewoon.columns.map((c, i) =>
            [
              `나의 ${daewoon.ages[i]}세 대운`,
              `이번 대운의 천간은 ${c.stemHanja}(${c.stem})입니다. ${input.name}님의 역할 수행 방식과 판단 기준에 영향을 줄 수 있습니다.`,
              `이번 대운의 지지는 ${c.branchHanja}(${c.branch})입니다. 생활 환경과 관계의 분위기가 이 지지의 영향을 받을 가능성이 있습니다.`,
              `천간의 십성은 ${c.sipseongStem}입니다. 이 시기에는 ${c.sipseongStem}의 성격이 더 뚜렷하게 체감될 수 있습니다.`,
              `지지의 십성은 ${c.sipseongBranch}입니다. 감정선과 반복 생활 패턴은 ${c.sipseongBranch} 쪽에서 더 선명하게 느껴질 수 있습니다.`,
              `십이운성은 ${c.sibiunseong}입니다. 따라서 이 시기에는 ${c.sibiunseong}의 리듬에 맞춰 준비와 실행의 균형을 잡는 것이 중요합니다.`,
              `정리해보면 ${daewoon.ages[i]}세 대운은 ${input.name}님이 기준을 어떻게 쓰느냐에 따라 체감 차이가 크게 벌어질 수 있는 시기입니다.`,
            ].join("\n\n"),
          ),
        ].join("\n\n")
        : `${input.name}님, 대운은 10년 단위의 큰 흐름을 보여주는 장입니다. 이 장에서는 시기마다 강조되는 역할과 속도 조절 포인트를 함께 보는 방식이 중요합니다.`;
      break;
    }
    case 12: {
      const yeonun = ext ? computeYeonunTable(ext.dayStem, new Date().getFullYear()) : null;
      body = yeonun
        ? [
          `이 표는 ${input.name}님의 연운표입니다. 연운은 매해 달라지는 분위기와 방향성을 보여주므로, 한 해의 선택과 준비 포인트를 세밀하게 읽는 데 도움이 됩니다.`,
          ...yeonun.columns.map((c) =>
            [
              `나의 ${c.year}년 연운`,
              `나의 ${c.year}년 연운 : 천간 ${c.stemHanja}(${c.stem})`,
              `${c.year}년의 천간은 ${c.stemHanja}(${c.stem})로 들어오며 ${input.name}님의 외부 역할과 판단 기준의 변화를 체감하게 할 수 있습니다.`,
              `나의 ${c.year}년 연운 : 지지 ${c.branchHanja}(${c.branch})`,
              `${c.year}년의 지지는 ${c.branchHanja}(${c.branch})입니다. 생활 환경과 관계 분위기가 이 지지의 영향을 받을 가능성이 큽니다.`,
              `나의 ${c.year}년 연운 : 천간 십성 ${c.sipseongStem}`,
              `${c.sipseongStem}의 작용이 강해지면 일 처리 방식과 자기 표현의 결이 평소보다 더 뚜렷해질 수 있습니다.`,
              `나의 ${c.year}년 연운 : 지지 십성 ${c.sipseongBranch}`,
              `${c.sipseongBranch}은 관계와 감정선에서의 체감 변화를 보여줄 수 있습니다.`,
              `나의 ${c.year}년 연운 : 십이운성 ${c.sibiunseong}`,
              `${c.year}년의 십이운성은 ${c.sibiunseong}입니다. 그래서 이 해에는 ${c.sibiunseong}의 리듬에 맞는 속도와 회복 방식을 함께 가져가는 편이 좋습니다.`,
              `나의 ${c.year}년 연운 종합`,
              `${c.year}년은 ${input.name}님에게 작은 선택의 질이 크게 체감될 수 있는 해로 읽힙니다. 기준을 정리하고 실행 순서를 나눠 가져가시면 훨씬 안정적으로 흐름을 활용하실 수 있습니다.`,
            ].join("\n\n"),
          ),
        ].join("\n\n")
        : `${input.name}님, 연운은 해마다 달라지는 세부 흐름을 읽는 장입니다. 이 장에서는 결과보다 선택의 순서와 감정 조절 방식을 함께 보는 것이 중요합니다.`;
      break;
    }
    default:
      body = `${input.name}님, ${blueprint.title}은 현재 흐름을 생활 장면과 연결해 읽는 장입니다. 최근 반복되는 패턴을 떠올리며 차분히 점검해보시면 도움이 됩니다.`;
      break;
  }

  // Hard guard: never allow schema(min 1200) to fail.
  const minChars = 1200;
  if (body.length < minChars) {
    const normalizedBody = () => body.replace(/\s+/g, " ").trim();
    for (const paragraph of buildFallbackPaddingParagraphs(input, sectionNumber, blueprint.title, dayPillar)) {
      if (body.length >= minChars) break;
      const trimmed = paragraph.trim();
      if (!trimmed) continue;
      const marker = trimmed.replace(/\s+/g, " ").slice(0, 48);
      if (marker && normalizedBody().includes(marker)) continue;
      body += `\n\n${trimmed}`;
    }
  }

  if (body.length < minChars) {
    body += `\n\n${buildLastResortPaddingParagraph(input, sectionNumber, blueprint.title)}`;
  }

  let guardRound = 0;
  while (body.length < minChars) {
    body += `\n\n${buildGuaranteedPaddingParagraph(input, sectionNumber, blueprint.title, guardRound)}`;
    guardRound += 1;
  }

  return { heading, body: dedupeParagraphs(annotateKnownHanjaWithReading(body)) };
}

async function generateSummary(
  provider: RequestedProvider,
  input: LlmGenerateInput,
  debugCapture?: LlmDebugCapture,
  llmOptions?: LlmRuntimeOptions,
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
      llmOptions,
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
  llmOptions?: LlmRuntimeOptions,
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
      llmOptions,
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
  llmOptions?: LlmRuntimeOptions,
): Promise<ReportSection[]> {
  const prompt = compactMode
    ? buildSectionsCompactPrompt(input, start, end)
    : buildSectionsPrompt(input, start, end);
  const expectedCount = end - start + 1;

  const parsed = await callProviderJsonWithRetry({
    provider,
    prompt,
    schema: sectionChunkLooseSchema,
    stage: compactMode ? `sections:${start}-${end}:compact` : `sections:${start}-${end}`,
    maxTokens: compactMode ? 3400 : 7600,
    debugCapture,
    maxAttempts: compactMode ? 2 : 3,
    llmOptions,
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

  const normalized = parsed.sections.map((section, idx) => normalizeSection(section, start + idx));

  // If the model returns a too-short body, expand only that section via a follow-up call.
  // This prevents repetitive local filler from appearing across chapters.
  const targetMinChars = 3200;
  const result: ReportSection[] = [];
  for (let i = 0; i < normalized.length; i++) {
    const sectionNumber = start + i;
    let next = normalized[i];
    for (let pass = 0; pass < 2 && next.body.length < targetMinChars; pass += 1) {
      try {
        next = await expandSectionBodyIfNeeded({
          provider,
          input,
          sectionNumber,
          section: next,
          targetMinChars,
          llmOptions,
        });
      } catch {
        // If expansion fails, ensure schema minimum below.
        break;
      }
    }
    next = ensureMinSectionBody({ input, sectionNumber, section: next, minChars: 1800 });
    result.push(next);
  }
  return result;
}

async function generateSectionsSafely(
  provider: RequestedProvider,
  input: LlmGenerateInput,
  start: number,
  end: number,
  debugCapture?: LlmDebugCapture,
  llmOptions?: LlmRuntimeOptions,
): Promise<ReportSection[]> {
  try {
    return await generateSectionRangeDirect(provider, input, start, end, false, debugCapture, llmOptions);
  } catch (err) {
    if (start < end) {
      const mid = Math.floor((start + end) / 2);
      const left = await generateSectionsSafely(provider, input, start, mid, debugCapture, llmOptions);
      const right = await generateSectionsSafely(provider, input, mid + 1, end, debugCapture, llmOptions);
      return [...left, ...right];
    }

    if (!(err instanceof LlmRequestError)) {
      throw err;
    }

    try {
      return await generateSectionRangeDirect(provider, input, start, end, true, debugCapture, llmOptions);
    } catch (compactErr) {
      if (start === end) {
        return [buildFallbackSection(input, start)];
      }
      throw compactErr;
    }
  }
}

/** Number of sections per LLM call. 12장 구조. */
const SECTION_BATCH_SIZE = Math.max(1, Math.min(12, Number(process.env.SECTION_BATCH_SIZE) || 1));

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
  llmOptions?: LlmRuntimeOptions,
): Promise<ReportSummaryPart> {
  return generateSummary(resolveRequestedProvider(llmOptions), input, debugCapture, llmOptions);
}

export async function generateReportSectionsBatchPart(
  input: LlmGenerateInput,
  batchIndex: number,
  debugCapture?: LlmDebugCapture,
  llmOptions?: LlmRuntimeOptions,
): Promise<ReportSectionBatch> {
  const batches = buildSectionBatches();
  const range = batches[batchIndex];
  if (!range) {
    throw new Error(`Invalid batchIndex: ${batchIndex}`);
  }
  const [start, end] = range;
  const sections = await generateSectionsSafely(
    resolveRequestedProvider(llmOptions),
    input,
    start,
    end,
    debugCapture,
    llmOptions,
  );
  return { batchIndex, start, end, sections };
}

export async function generateReportTailPart(
  input: LlmGenerateInput,
  debugCapture?: LlmDebugCapture,
  llmOptions?: LlmRuntimeOptions,
): Promise<ReportTailPart> {
  return generateTail(resolveRequestedProvider(llmOptions), input, debugCapture, llmOptions);
}

export async function generateReportContentWithLlm(
  input: LlmGenerateInput,
  debugCapture?: LlmDebugCapture,
  llmOptions?: LlmRuntimeOptions,
): Promise<ReportContent> {
  const requestedProvider = resolveRequestedProvider(llmOptions);
  return generateFullReport(requestedProvider, input, debugCapture, llmOptions);
}

// Backward compatibility for existing imports.
export const generateReportContentWithGemini = generateReportContentWithLlm;
