import { z } from "zod";

import { mustGetEnv } from "@/lib/env";
import { reportContentSchema, type ReportContent } from "@/lib/reportSchema";
import { type FiveElement } from "manseryeok";

import {
  computeDaewoonTable,
  computeSajuExtended,
  computeYeonunTable,
  type YeonunColumn,
} from "@/lib/sajuExtended";

export type LlmGenerateInput = {
  name: string;
  gender?: string;
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
  /** 12개 장의 개인화 한 줄 요약 (장 순서대로) */
  chapterOneLiners: z.array(z.string().min(10).max(120)).length(12),
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
    "# 역할: 사주결과.pdf 스타일 작가 + 생활 상담자(명리 기반)",
    "당신은 ‘사주결과.pdf’와 동일한 말투/전개로 사주 리포트를 작성합니다.",
    "핵심은 사용자가 읽기 편하고 설득력 있게 ‘장(章) 단위로’ 흘러가게 만드는 것입니다.",
    "",
    "## 문체/톤 (강제)",
    "- 존댓말, 따뜻한 안내자 톤. 딱딱한 설명문처럼 쓰지 말고, 독자가 편안하게 읽히는 자연스러운 문장으로 씁니다.",
    "- 공감/정감이 느껴지도록 “~하실 수 있어요/~해보시면 좋겠습니다/괜찮습니다/천천히 살펴보겠습니다” 같은 완곡한 표현을 적절히 섞습니다.",
    "- 과도한 단정(무조건/확실히/반드시)은 피하고, ‘경향/가능성/조언’ 중심으로 조심스럽게 서술합니다.",
    "- 같은 문장 패턴/AI스러운 접속어 반복을 피하고, 문단은 3~6문장 단위로 자연스럽게 끊습니다.",
    "- **일반인이 읽는 글**입니다. 어려운 전문용어(명리 용어·한자어)는 남발하지 말고, 꼭 필요할 때만 쓰세요.",
    "- 전문용어를 썼다면 그 문단 안에서 **바로 한 줄 풀이**를 붙이세요. (예: \"정관(正官)은 ‘규칙·책임·평가’ 쪽 기운\"처럼)",
    "- **한자 최소화(강제)**: 십이운성(목욕·장생·건록·제왕·쇠·병·사·묘·절·태·양·관대), 십성, 십이신살 이름에 한자(沐浴, 長生 등)를 괄호 병기하지 마세요. 한글 이름만 쓰고 일반어 풀이를 괄호로 붙이세요. 예: '목욕(에너지가 정제되는 준비 시기)', '장생(새로운 시작이 붙는 시기)'. 漢字 원문·음양오행 한자(陰金·陽木·沐浴 등)도 본문에서 최대한 줄이세요.",
    ...styleGuide,
    "",
    "## 균형 규칙 (강제: 좋은 말만 금지)",
    "- 각 장(섹션)에는 반드시 **강점(좋은 흐름)**과 **부담/리스크(조심할 점)**를 함께 넣으세요.",
    "- ‘부담/리스크’는 겁주지 말고, \"이럴 때는 이렇게 조절해보세요\"처럼 **대안(행동)**까지 같이 제시하세요.",
    "- 칭찬 문장만 연속으로 3문장 이상 이어지지 않게 하세요. (반드시 현실적인 제약/주의/조건을 섞기)",
    "",
    "## 운세 판정 금지 (강제)",
    "- \"운이 좋다/나쁘다\", \"좋은 기운이 흐른다\", \"성공 가능성이 높다\", \"흉한 시기\" 같은 결과론적 운세 판정 문구는 절대 쓰지 마세요.",
    "- 대신 \"이 시기에는 …이 강해지기 쉬운 리듬입니다. 이를 살리려면 …\" 처럼 **흐름을 읽고 활용·조절하는 언어**로만 서술하세요.",
    "- \"~운이 좋습니다\", \"~에 유리합니다\" 대신 \"~쪽으로 에너지가 실리기 쉬운 시기입니다\", \"~을 시도해볼 흐름입니다\" 식으로 표현하세요.",
    "",
    "## 용어 난이도 규칙 (강제: 일반인 우선)",
    "- **겁재·식신·편재·정관·편관·상관·비견·정인·편인·정재** 같은 십성(十星) 용어는 처음 등장할 때 반드시 괄호로 생활 언어 풀이를 붙이세요.",
    "  예: 겁재(나와 비슷한 에너지로 경쟁·협력이 생기는 기운), 식신(내가 만들어내는 표현·배려의 기운), 편재(바깥에서 들어오는 기회·재물의 기운), 정관(규칙과 책임을 지키는 기운)",
    "- **십이운성 이름(건록·제왕·병·사·묘·절·태·양·장생·목욕·쇠·관대)** 도 처음 나올 때 한 줄 풀이하세요. 예: 병(에너지 회복기), 제왕(에너지 최고조기), 사(마무리·전환기), 묘(내면 정리기)",
    "- **십이신살(역마살·화개살·육해살·년살 등)** 도 마찬가지. 예: 역마살(이동·변화가 자주 일어나는 흐름), 화개살(혼자 집중하고 싶어지는 내면 에너지)",
    "- 부정적으로 들릴 수 있는 단어(병·사·묘·절·흉 등)는 반드시 \"회복기\", \"정리기\", \"전환기\" 같은 중립·성장 언어와 나란히 쓰세요. 독자가 불안해하지 않도록.",
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
    `- 성별: ${input.gender?.trim() ? input.gender.trim() : "미입력"}`,
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
    `${input.name}|${input.gender ?? ""}|${input.birth.year}-${input.birth.month}-${input.birth.day} ${input.birth.hour}:${input.birth.minute}|${input.saju.fourPillarsKorean.day}`,
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

/** 일간·일지 음양+오행을 샘플 형식(예: 양금(陽金))으로 고정 표기 */
function formatYinyangElementKoHanja(yinYang: "양" | "음", elementKo: string): string {
  const elH: Record<string, string> = { 목: "木", 화: "火", 토: "土", 금: "金", 수: "水" };
  const yyH = yinYang === "양" ? "陽" : "陰";
  const h = elH[elementKo] ?? "";
  return `${yinYang}${elementKo}(${yyH}${h})`;
}

/** 십이운성 한글명 → 한자 병기(샘플·PDF 가독성) */
/** 십성 한글명 → 한자 병기(대운·연운 세부 본문 가독성) */
function formatSipseongKoHanja(ko: string): string {
  const h: Record<string, string> = {
    비견: "비견(比肩)",
    겁재: "겁재(劫財)",
    식신: "식신(食神)",
    상관: "상관(傷官)",
    편재: "편재(偏財)",
    정재: "정재(正財)",
    편관: "편관(偏官)",
    정관: "정관(正官)",
    편인: "편인(偏印)",
    정인: "정인(正印)",
  };
  return h[ko] ?? ko;
}

const ELEMENT_ORDER: FiveElement[] = ["목", "화", "토", "금", "수"];
const ELEMENT_HANJA_MAP: Record<FiveElement, string> = { 목: "木", 화: "火", 토: "土", 금: "金", 수: "水" };
const ELEMENT_KO: Record<FiveElement, string> = { 목: "목", 화: "화", 토: "토", 금: "금", 수: "수" };

function stemElementFullLabel(stemKorean: string, stemHanja: string, el: FiveElement): string {
  return `${stemKorean}${el}(${stemHanja}${ELEMENT_HANJA_MAP[el]})`;
}

/** 일간 오행과 대운 천간·지지 오행의 상생·상극을 건강·역량·환경 맥락으로 서술 */
function daewoonElementRelationParagraph(
  name: string,
  dayEl: FiveElement,
  dwEl: FiveElement,
  dwLabel: string,
  slot: "천간" | "지지",
  dayStemFull: string,
): string {
  const dayRef = dayStemFull.trim() || `일간 ${ELEMENT_KO[dayEl]}`;
  const di = ELEMENT_ORDER.indexOf(dayEl);
  const wi = ELEMENT_ORDER.indexOf(dwEl);
  const focusStem =
    slot === "천간"
      ? "역량·판단·학습 몰입·창의적 활동으로 드러나기 쉽고, 스스로를 표현하고 성과를 만드는 데 에너지가 모이기 쉽습니다."
      : "생활 터전·재정·업무 환경·관계의 분위기로 드러나기 쉽고, 현실적인 기반을 다지고 안정감을 쌓으려는 흐름이 강해질 수 있습니다.";
  if (di < 0 || wi < 0) {
    return `${dwLabel}은(는) ${name}님의 일상 리듬과 맞물릴 때 컨디션 차이가 커질 수 있으니, 수면과 식사를 먼저 고정하는 편이 좋습니다.`;
  }
  const next = (a: number) => (a + 1) % 5;
  const ctrl = (a: number) => (a + 2) % 5;
  if (di === wi) {
    return `${dwLabel}은(는) ${dayRef}과(와) 같은 오행 계열로 맞닿아 있어 ${focusStem} 다만 한쪽으로만 몰리면 피로가 빨리 쌓일 수 있으니 속도 조절이 필요합니다.`;
  }
  if (wi === next(di)) {
    return `${dwLabel}은(는) ${name}님의 ${dayRef}과(와) 상생(相生) 관계에 있습니다. ${ELEMENT_KO[dayEl]}이(가) ${ELEMENT_KO[dwEl]}을(를) 생(生)한다는 흐름으로 읽을 수 있어, ${name}님께서 이 시기에 능력과 에너지를 발휘해 무언가를 이루기에 유리한 리듬입니다. 특히 ${slot === "천간" ? "학업·자기 계발·창의적 활동" : "재물·생활 기반"}에서 긍정적인 성과를 기대해볼 수 있으나, 상생이 지나치면 에너지가 소진될 수 있으니 무리하지 않는 것이 중요합니다.`;
  }
  if (di === next(wi)) {
    return `${dwLabel}은(는) ${dayRef}과(와) 상생(相生) 관계에 있습니다. ${ELEMENT_KO[dwEl]}이(가) ${ELEMENT_KO[dayEl]}을(를) 생해 주는 흐름이므로 ${slot === "지지" ? "재물적으로 안정감을 얻으려는 기운이 붙기 쉽고" : "내면의 지지와 회복이 따라붙기 쉽고"}, 현실적인 준비를 차곡차곡 쌓을 때 만족도가 커질 수 있습니다. 다만 과도한 욕심이나 계획 없는 확장은 안정감을 흔들 수 있으니 우선순위를 분명히 하세요.`;
  }
  if (wi === ctrl(di)) {
    return `${dwLabel}이(가) ${dayRef}과(와) 상극(相剋)으로 맞닿을 여지가 있어, ${slot === "천간" ? "결정과 실행" : "환경·관계"}에서 긴장이 커질 수 있습니다. 무리한 확장보다 정리와 점검에 에너지를 쓰는 편이 안전합니다.`;
  }
  if (di === ctrl(wi)) {
    return `${dwLabel}은(는) ${dayRef}이(가) 다스리고 정리할 수 있는 흐름으로 읽힐 수 있어, 부담을 줄이고 체계를 잡을 때 컨디션이 나아질 수 있습니다. 과로만 피하면 회복에도 유리한 방향입니다.`;
  }
  return `${dwLabel}은(는) ${name}님의 ${dayRef}과(와) 중간 톤으로 맞물리므로, 생활 습관을 주간 단위로 점검하면 균형을 유지하기 좋습니다.`;
}

function formatSibiunseongKoHanja(ko: string): string {
  const h: Record<string, string> = {
    장생: "장생(長生)",
    목욕: "목욕(沐浴)",
    관대: "관대(冠帶)",
    건록: "건록(建祿)",
    제왕: "제왕(帝旺)",
    쇠: "쇠(衰)",
    병: "병(病)",
    사: "사(死)",
    묘: "묘(墓)",
    절: "절(絕)",
    태: "태(胎)",
    양: "양(養)",
  };
  return h[ko] ?? ko;
}

/** 대운 칸 폴백: 천간 십성별 서술(식신만 특화하지 않도록 분기) */
function daewoonSipseongStemParagraph(name: string, ko: string): string {
  const h = formatSipseongKoHanja(ko);
  const tail: Record<string, string> = {
    비견: `${ko}은(는) 나와 비슷한 기운이 겹치는 십성으로, 이 시기에는 동료·친구 관계와 자기 주장이 동시에 강해질 수 있습니다. 협력과 경쟁 사이에서 균형을 잡고, 고집만 앞세우지 않도록 대화로 기대치를 맞추면 관계 손실을 줄일 수 있습니다.`,
    겁재: `${ko}은(는) 경쟁과 자원 분배가 겹치기 쉬운 십성입니다. 이 시기에는 주변과의 속도 차이가 커질 수 있으니, 무리한 승부보다 역할을 분명히 하고 손익을 투명히 나누는 편이 안전합니다.`,
    식신: `${ko}은(는) 자신의 역량을 활용해 새로운 것을 창출하거나 나누는 에너지로 읽힙니다. ${name}님이 재능을 발휘해 인정받는 흐름이 붙기 쉬우며, 지나치게 경쟁적으로만 나가기보다 여유와 소통을 섞으면 관계에서도 긍정적인 반응을 기대해볼 수 있습니다.`,
    상관: `${ko}은(는) 표현·비판·창의가 강해지기 쉬운 십성입니다. 이 시기에는 말과 태도가 결과에 직접 영향을 줄 수 있으니, 속도를 조금 늦추고 상대 입장을 확인하는 습관이 갈등을 줄이는 데 도움이 됩니다.`,
    편재: `${ko}은(는) 기회와 변동이 섞인 재물 흐름으로 읽힙니다. 수입원을 다각화하거나 단기 성과를 노릴 여지가 있으나, 충동적 지출과 과도한 레버리지는 피하는 편이 좋습니다.`,
    정재: `${ko}은(는) 규칙과 루틴을 통해 쌓이는 재물 기운에 가깝습니다. 꾸준한 직무·계약·저축 같은 안정형 선택이 만족도를 높일 수 있고, 서두르기보다 약속을 지키는 태도가 신뢰로 이어집니다.`,
    편관: `${ko}은(는) 압박과 변화가 동시에 올 수 있는 십성입니다. 책임이 커질 때 컨디션 관리가 중요하며, 규칙을 활용해 리스크를 줄이면 오히려 실력으로 인정받기 쉽습니다.`,
    정관: `${ko}은(는) 질서·평가·사회적 기준과 맞닿기 쉬운 십성입니다. 이 시기에는 규범을 지키며 성과를 쌓는 방식이 유리하고, 약속과 보고를 명확히 하면 신뢰가 따라붙기 쉽습니다.`,
    편인: `${ko}은(는) 직관·학습·내면의 탐구가 강해질 수 있는 십성입니다. 새로운 방식을 시도하거나 깊이 공부하기 좋은 흐름이나, 고민이 길어지면 에너지가 소모되므로 기록과 휴식으로 균형을 잡는 편이 좋습니다.`,
    정인: `${ko}은(는) 배움과 보호·지지를 받는 구조로 읽히기 쉽습니다. 멘토·자격·체계적인 공부에 도움이 될 수 있으나, 지나치게 타인의 기준에만 맞추면 속도가 느려질 수 있으니 자기 목표를 함께 적어 두면 좋습니다.`,
  };
  const body = tail[ko] ?? `${ko}은(는) 이 시기에 역할 수행 방식과 판단 기준에 영향을 주기 쉬운 십성입니다. 상황에 맞게 속도를 조절하고, 피로 신호를 놓치지 않는 편이 좋습니다.`;
  return `천간의 십성은 ${h}입니다. ${body}`;
}

/** 대운 칸 폴백: 지지 십성별 서술 */
function daewoonSipseongBranchParagraph(name: string, ko: string): string {
  const h = formatSipseongKoHanja(ko);
  const tail: Record<string, string> = {
    비견: `${ko}은(는) 내면의 자존감과 반복되는 생활 패턴에 스며들기 쉽습니다. 주변과 비교하느라 에너지가 새지 않도록, 나만의 기준과 루틴을 먼저 고정하는 편이 좋습니다.`,
    겁재: `${ko}은(는) 관계·자원에서 경쟁이나 마찰이 생기기 쉬운 바탕으로 읽힐 수 있습니다. 경계를 명확히 하되 대립만 키우지 않도록 중재와 합의 타이밍을 의식하면 안정감이 커집니다.`,
    식신: `${ko}은(는) 일상 속 취미·표현·돌봄이 강조되는 흐름입니다. 사람들과 나누는 활동이 정서를 풍성하게 하고, 관계에서도 부드러운 인상을 남기기 쉽습니다.`,
    상관: `${ko}은(는) 말과 행동이 감정선에 바로 닿기 쉬운 십성입니다. 즉흥적 반응이 오해를 부를 수 있으니, 중요한 대화는 시간을 두고 정리해 전달하는 습관이 도움이 됩니다.`,
    편재: `${ko}은(는) 지출·투자·외부 기회가 들뜨기 쉬운 패턴입니다. 현금 흐름을 주간 단위로 점검하고, 검증 없는 확장은 피하면 재정 안정에 유리합니다.`,
    정재: `${ko}은(는) 생활 터전과 재정의 기반이 단단해지기를 원하는 흐름입니다. 장기 계약·저축·주거 같은 현실 기반을 다지면 심리적 안정도 함께 따라올 수 있습니다.`,
    편관: `${ko}은(는) 환경 변화와 압박이 몰릴 수 있는 지지 십성입니다. 몸의 신호를 먼저 돌보고, 책임 범위를 조정할 수 있는지 점검하는 것이 과로를 줄이는 지름길입니다.`,
    정관: `${ko}은(는) 규칙·평가·가문·조직 같은 틀과 맞닿기 쉽습니다. 약속과 역할을 지키면 신뢰가 쌓이고, 무리한 의무 수락은 피로를 키울 수 있으니 선을 분명히 하세요.`,
    편인: `${ko}은(는) 직관과 창의, 깊은 학습 욕구가 올라오기 쉬운 십성입니다. 새로운 관점을 시도하기 좋으나, 의심과 고민이 길어지면 에너지가 소모되므로 스스로 균형을 맞추는 것이 필요합니다.`,
    정인: `${ko}은(는) 배움과 보호의 기운이 환경 쪽에서 강조될 수 있습니다. 스승·제도·자료를 활용하면 성장에 도움이 되고, 정보 과잉만 피하면 몰입도가 높아집니다.`,
  };
  const body = tail[ko] ?? `${ko}은(는) 감정선과 반복 생활 패턴을 만드는 바탕으로, ${name}님의 일상 리듬과 맞물릴 때 체감 차이가 커질 수 있습니다.`;
  return `지지의 십성은 ${h}입니다. ${body}`;
}

/** 천간·지지 한글 + 오행 한글(병화, 오화 등) */
function stemBranchElementCompound(char: string, el: FiveElement): string {
  return `${char}${ELEMENT_KO[el]}`;
}

const YEONUN_STEM_ELEMENT_LINE: Record<FiveElement, string> = {
  목: "봄을 닮아 뻗어 나가는 성장과 시작의 기운을 품습니다.",
  화: "태양에 가까운 밝음과 열기로 활력과 대외적 표현을 상징합니다.",
  토: "중심을 잡아 주는 안정과 현실감을 드러내기 쉽습니다.",
  금: "단단한 결실과 기준, 절제된 힘을 나타냅니다.",
  수: "깊고 넓은 흐름과 유연한 적응, 내면의 지혜를 품습니다.",
};

const YEONUN_BRANCH_ELEMENT_LINE: Record<FiveElement, string> = {
  목: "환경 속 성장과 확장의 리듬이 살아나기 쉽습니다.",
  화: "활동·교류·표현이 두드러지는 한여름 같은 생동감을 띠기 쉽습니다.",
  토: "생활 터전과 현실 과제가 중심에 서기 쉽습니다.",
  금: "정리·평가·원칙이 강조되는 분위기로 읽힐 수 있습니다.",
  수: "변화와 정보, 감정의 파동이 잦아질 여지가 있습니다.",
};

function yeonunStemSipseongBridge(name: string, stemCompound: string, ko: string): string {
  const h = formatSipseongKoHanja(ko);
  const m: Record<string, string> = {
    비견: `또한 ${stemCompound} 천간은 ${name}님에게 ${h}으로 겹치므로, 자기 주장과 동료·친구 관계가 동시에 부각될 수 있습니다. 협력과 경쟁 사이에서 기대치를 말로 맞추면 마찰을 줄이기 좋습니다.`,
    겁재: `또한 ${stemCompound} 천간은 ${name}님에게 ${h}으로 작용해 자원·역할 분배에서 긴장이 생기기 쉽습니다. 승부보다 규칙과 범위를 먼저 정리하면 에너지 소모를 줄일 수 있습니다.`,
    식신: `또한 ${stemCompound} 천간은 ${name}님에게 ${h}으로 작용해 재능을 드러내고 나누는 흐름이 강해질 수 있습니다. 여유와 소통을 섞으면 인정받는 속도가 붙기 쉽습니다.`,
    상관: `또한 ${stemCompound} 천간은 ${name}님에게 ${h}으로 작용해 표현·비판·창의가 앞으로 나오기 쉽습니다. 말과 태도의 온도를 조절하면 결과가 좋아집니다.`,
    편재: `또한 ${stemCompound} 천간은 ${name}님에게 ${h}으로 작용해 기회와 변동이 섞인 재물 흐름이 붙기 쉽습니다. 검증 없는 확장과 충동 지출만 피하면 수익 구조를 넓히기 좋습니다.`,
    정재: `또한 ${stemCompound} 천간은 ${name}님에게 ${h}으로 작용해 약속·루틴·계약을 통해 쌓이는 안정형 재물 기운이 강해질 수 있습니다.`,
    편관: `또한 ${stemCompound} 천간은 ${name}님에게 ${h}으로 작용하기 때문에 책임감과 도전의식이 자연스레 강화될 수 있습니다. 새로운 책임이 따라올 수 있으니 범위와 기한을 먼저 조율하면 성장으로 이어지기 쉽습니다.`,
    정관: `또한 ${stemCompound} 천간은 ${name}님에게 ${h}으로 작용하기 때문에 규범·평가·약속 이행이 중요한 해로 읽힐 수 있습니다. 신뢰를 쌓으면 기회로 돌아오기 쉽습니다.`,
    편인: `또한 ${stemCompound} 천간은 ${name}님에게 ${h}으로 작용해 직관·학습·내면 탐구가 깊어지기 쉽습니다. 고민이 길어질 때는 기록과 휴식으로 균형을 잡으세요.`,
    정인: `또한 ${stemCompound} 천간은 ${name}님에게 ${h}으로 작용해 배움과 보호·지지를 받는 구조가 열리기 쉽습니다. 타인 기준에만 맞추면 속도가 느려질 수 있으니 자기 목표를 함께 적어 두면 좋습니다.`,
  };
  return (
    m[ko] ??
    `또한 ${stemCompound} 천간은 ${name}님에게 ${h}으로 작용하므로, 이 해의 판단 방식과 역할 수행에서 ${ko}의 색이 뚜렷해질 수 있습니다.`
  );
}

function yeonunBranchBalanceLine(el: FiveElement): string {
  if (el === "화") {
    return "다만 과한 열정이 직설적 표현으로 이어져 갈등이나 과로를 부를 수 있으니, 균형 잡힌 태도와 휴식 루틴이 필요합니다.";
  }
  if (el === "금") {
    return "다만 지나치게 날을 세우거나 완벽주의만 앞세우면 관계가 경직될 수 있으니, 완충 대화를 남겨 두세요.";
  }
  if (el === "수") {
    return "다만 감정과 생각의 파동이 커질 때는 결정을 잠시 미루고 수면을 챙기면 판단이 안정됩니다.";
  }
  if (el === "목") {
    return "다만 확장 욕구만 앞서면 약속이 늘어나 피로가 쌓일 수 있으니 우선순위를 자주 점검하세요.";
  }
  return "다만 욕심을 한꺼번에 잡으려 하면 흐름이 흔들릴 수 있으니, 단계를 나눠 가져가는 편이 좋습니다.";
}

function yeonunStemSectionBody(
  name: string,
  year: number,
  c: Pick<YeonunColumn, "stem" | "stemHanja" | "stemElement" | "sipseongStem">,
  dayStemFull: string,
  dayStemEl: FiveElement,
): string {
  const compound = stemBranchElementCompound(c.stem, c.stemElement);
  const stemLabel = stemElementFullLabel(c.stem, c.stemHanja, c.stemElement);
  const p1 = `${year}년 연운의 천간은 ${compound}입니다. ${YEONUN_STEM_ELEMENT_LINE[c.stemElement]}`;
  const p2 = daewoonElementRelationParagraph(name, dayStemEl, c.stemElement, stemLabel, "천간", dayStemFull);
  const p3 = yeonunStemSipseongBridge(name, compound, c.sipseongStem);
  return [p1, p2, p3].join("\n\n");
}

function yeonunBranchSectionBody(
  name: string,
  year: number,
  c: Pick<YeonunColumn, "branch" | "branchHanja" | "branchElement">,
  dayStemFull: string,
  dayStemEl: FiveElement,
): string {
  const compound = stemBranchElementCompound(c.branch, c.branchElement);
  const branchLabel = stemElementFullLabel(c.branch, c.branchHanja, c.branchElement);
  const p1 = `${year}년 연운의 지지는 ${compound}입니다. ${YEONUN_BRANCH_ELEMENT_LINE[c.branchElement]} ${name}님께는 생활 환경과 관계의 분위기로 이 기운이 스며들기 쉽고, 외부 활동이나 사회적 교류가 늘어날 여지가 있습니다.`;
  const p2 = daewoonElementRelationParagraph(name, dayStemEl, c.branchElement, branchLabel, "지지", dayStemFull);
  const p3 = yeonunBranchBalanceLine(c.branchElement);
  return [p1, p2, p3].join("\n\n");
}

function yeonunSipseongStemExtendedBody(name: string, year: number, ko: string): string {
  const h = formatSipseongKoHanja(ko);
  const pairs: Record<string, [string, string]> = {
    비견: [
      `${h}은(는) ${name}님에게 동료·친구와의 관계, 그리고 자기 기준의 중복을 뜻합니다. ${year}년에는 나와 비슷한 톤의 사람·일이 잦아져 속도 조절이 화두가 될 수 있습니다.`,
      `${h}의 기운은 협력과 경쟁이 동시에 올 수 있으니, 역할과 기대치를 문장으로 정리해 두면 오해를 줄이고 에너지를 아낄 수 있습니다.`,
    ],
    겁재: [
      `${h}은(는) 경쟁과 자원 분배가 겹치기 쉬운 십성입니다. ${year}년에는 주변과의 속도 차이나 이해관계가 표면화할 수 있습니다.`,
      `성급한 승부보다 손익과 책임 범위를 투명히 나누는 습관이 갈등을 줄이고 실속을 챙기는 데 도움이 됩니다.`,
    ],
    식신: [
      `${h}은(는) 역량을 활용해 창출하고 나누는 에너지입니다. ${year}년에는 ${name}님이 재능을 드러내고 인정받는 흐름이 붙기 쉽습니다.`,
      `여유와 소통을 함께 가져가면 관계에서도 부드러운 인상을 남기기 좋고, 지나친 경쟁 태도만 피하면 만족도가 올라갑니다.`,
    ],
    상관: [
      `${h}은(는) 표현·비판·창의가 강해지기 쉬운 십성입니다. ${year}년에는 말과 태도가 결과에 직접 영향을 줄 수 있습니다.`,
      `중요한 결정 전에는 하루 숙성 시간을 두고, 상대 입장을 확인하는 질문을 섞으면 불필요한 마찰을 줄일 수 있습니다.`,
    ],
    편재: [
      `${h}은(는) 기회와 변동이 섞인 재물 흐름으로 읽힙니다. ${year}년에는 수입원이나 지출 패턴이 바뀔 여지가 있습니다.`,
      `현금 흐름을 주간 단위로 점검하고, 검증 없는 확장은 피하면 재정 안정에 유리합니다.`,
    ],
    정재: [
      `${h}은(는) 규칙과 루틴을 통해 쌓이는 재물 기운에 가깝습니다. ${year}년에는 약속·계약·저축 같은 안정형 선택이 만족도를 높일 수 있습니다.`,
      `서두르기보다 약속을 지키는 태도가 신뢰로 이어지고, 장기적으로 수익 구조를 단단히 합니다.`,
    ],
    편관: [
      `${h}은(는) ${name}님에게 외부의 도전과 경쟁, 스스로를 단련할 기회를 의미합니다. ${year}년에는 책임감을 요구하는 상황이 잦아질 수 있으나, 이를 통해 내적 성장을 이루는 해로 이해할 수 있습니다.`,
      `${h}은(는) 자제력과 균형 잡힌 결정을 요구합니다. 성급한 실수를 줄이고 계획을 세우며 행동을 되돌아보는 태도가 이후 발전의 초석이 됩니다.`,
    ],
    정관: [
      `${h}은(는) 규칙과 질서, 안정과 책임감을 의미합니다. ${year}년 ${name}님은 주변 환경 속에서 역할을 명확히 하고 신뢰를 쌓는 흐름이 강해질 수 있습니다.`,
      `${h}은(는) 체계적인 노력 속에서 결과를 만들어가는 과정을 뜻합니다. 지나치게 틀에만 얽매이면 답답함을 느낄 수 있으니 융통성을 갖추는 것이 좋습니다.`,
    ],
    편인: [
      `${h}은(는) 직관과 창의, 깊은 학습 욕구를 나타냅니다. ${year}년에는 기존 틀을 벗어난 시도가 끌릴 수 있습니다.`,
      `고민과 의심이 길어지면 에너지가 소모되므로, 기록·멘토링·휴식으로 균형을 맞추세요.`,
    ],
    정인: [
      `${h}은(는) 배움과 보호·지지를 받는 구조로 읽힙니다. ${year}년에는 자격·멘토·제도의 도움이 따라붙기 쉽습니다.`,
      `타인의 기준에만 맞추면 속도가 느려질 수 있으니, 병행해서 자기 목표를 한 줄씩이라도 적어 두면 좋습니다.`,
    ],
  };
  const pr = pairs[ko] ?? [
    `${h}은(는) ${year}년 연간 천간에서 ${name}님의 일 처리 방식과 자기 표현에 영향을 주기 쉬운 십성입니다.`,
    `상황에 맞게 속도를 조절하고 피로 신호를 놓치지 않는 편이 좋습니다.`,
  ];
  return pr.join("\n\n");
}

function yeonunSipseongBranchExtendedBody(
  name: string,
  year: number,
  ko: string,
  branchHanja: string,
  branch: string,
): string {
  const h = formatSipseongKoHanja(ko);
  const loc = `지지 ${branchHanja}(${branch})`;
  const pairs: Record<string, [string, string, string]> = {
    비견: [
      `${loc}에서는 ${name}님의 일간에게 ${h}이 작용합니다. 내면의 자존감과 반복 생활 패턴에 이 기운이 스며들기 쉽습니다.`,
      `${year}년에는 나만의 기준을 지키려는 힘이 강해질 수 있으나, 주변과의 비교로 에너지가 새지 않도록 루틴을 먼저 고정하는 편이 좋습니다.`,
      `협력이 필요한 일에서는 역할을 나누어 적어 두면 관계 마찰을 줄일 수 있습니다.`,
    ],
    겁재: [
      `${loc}에서는 ${name}님의 일간에게 ${h}이 작용합니다. 관계·자원에서 경쟁이나 마찰이 생기기 쉬운 바탕으로 읽힐 수 있습니다.`,
      `${year}년에는 이해관계가 표면화할 수 있으니 경계는 명확히 하되 대립만 키우지 않도록 합의 타이밍을 의식하세요.`,
      `손익과 기한을 투명히 하면 신뢰를 지키면서도 부담을 줄일 수 있습니다.`,
    ],
    식신: [
      `${loc}에서는 ${name}님의 일간에게 ${h}이 작용합니다. 일상 속 취미·표현·돌봄이 강조되는 흐름입니다.`,
      `${year}년에는 사람들과 나누는 활동이 정서를 풍성하게 하고 관계에서 부드러운 인상을 남기기 쉽습니다.`,
      `과로만 피하면 만족도와 창의가 함께 올라가기 좋습니다.`,
    ],
    상관: [
      `${loc}에서는 ${name}님의 일간에게 ${h}이 작용합니다. 말과 행동이 감정선에 바로 닿기 쉬운 십성입니다.`,
      `${year}년에는 즉흥적 반응이 오해를 부를 수 있으니, 중요한 대화는 시간을 두고 정리해 전달하는 습관이 도움이 됩니다.`,
      `피드백은 사실과 감정을 분리해 말하면 관계 손실을 줄일 수 있습니다.`,
    ],
    편재: [
      `${loc}에서는 ${name}님의 일간에게 ${h}이 작용합니다. 지출·투자·외부 기회가 들뜨기 쉬운 패턴입니다.`,
      `${year}년에는 현금 흐름을 주간 단위로 점검하고, 검증 없는 확장은 피하는 편이 재정 안정에 유리합니다.`,
      `감정적인 지출만 줄여도 체감이 크게 달라질 수 있습니다.`,
    ],
    정재: [
      `${loc}에서는 ${name}님의 일간에게 ${h}이 작용합니다. 생활 터전과 재정의 기반이 단단해지기를 원하는 흐름입니다.`,
      `${year}년에는 장기 계약·저축·주거 같은 현실 기반을 다지면 심리적 안정도 함께 따라올 수 있습니다.`,
      `서두르지 않고 약속을 지키는 태도가 신뢰를 쌓는 지름길입니다.`,
    ],
    편관: [
      `${loc}에서는 ${name}님의 일간에게 ${h}이 작용합니다. 환경 변화와 압박이 몰릴 수 있는 지지 십성입니다.`,
      `${year}년에는 책임 범위를 조정할 수 있는지 먼저 점검하고, 몸의 신호를 돌보는 것이 과로를 줄이는 데 도움이 됩니다.`,
      `규칙을 활용해 리스크를 줄이면 실력으로 인정받기 쉽습니다.`,
    ],
    정관: [
      `${loc}에서는 ${name}님의 일간에게 ${h}이 작용합니다. ${h}은(는) 규칙과 질서, 책임과 신뢰를 의미합니다.`,
      `${year}년 ${name}님은 주변 환경 속에서 역할을 명확히 하고 신뢰를 쌓아가는 모습이 나타날 수 있습니다. 상태를 관리하며 약속을 지키는 태도가 좋은 평가로 이어지기 쉽습니다.`,
      `지나치게 틀에만 얽매이면 답답함을 느낄 수 있으니, 필요한 만큼만 융통성을 허용하세요. 이 시기의 ${h}은(는) 한계를 알고 극복하는 과정으로도 읽을 수 있습니다.`,
    ],
    편인: [
      `${loc}에서는 ${name}님의 일간에게 ${h}이 작용합니다. 직관·창의·깊은 학습 욕구가 환경 쪽에서 강조될 수 있습니다.`,
      `${year}년에는 새로운 관점을 시도하기 좋으나, 의심과 고민이 길어지면 에너지가 소모됩니다.`,
      `기록과 휴식으로 균형을 맞추면 몰입도가 올라갑니다.`,
    ],
    정인: [
      `${loc}에서는 ${name}님의 일간에게 ${h}이 작용합니다. 배움과 보호의 기운이 환경에서 강조될 수 있습니다.`,
      `${year}년에는 스승·제도·자료를 활용하면 성장에 도움이 되고, 정보 과잉만 피하면 몰입도가 높아집니다.`,
      `혼자 모든 걸 해결하려 하기보다 검증된 루트를 쓰는 편이 효율적입니다.`,
    ],
  };
  const pr = pairs[ko] ?? [
    `${loc}에서는 ${name}님의 일간에게 ${h}이 작용합니다.`,
    `${year}년에는 감정선과 반복 생활 패턴에 이 십성의 색이 스며들기 쉽습니다.`,
    `속도를 조절하고 휴식 루틴을 고정하면 체감이 안정됩니다.`,
  ];
  return pr.join("\n\n");
}

function yeonunSibiunseongExtendedBody(name: string, year: number, u: string): string {
  const h = formatSibiunseongKoHanja(u);
  const peak = u === "제왕" || u === "건록";
  const low = ["병", "사", "쇠", "묘", "절"].includes(u);
  if (u === "목욕") {
    return [
      `${year}년 연운의 십이운성은 ${h}으로 나타납니다. 목욕은 새로운 단계로 나아가기 위한 정화와 준비 과정을 상징하며, ${name}님께서 이전과 다른 변화를 체감하며 다소 민감한 시기를 경험할 여지가 있습니다.`,
      `목욕 단계는 외부 상황의 영향을 크게 받을 수 있는 시기이기도 합니다. 관계나 환경의 변동성이 삶에 스며들기 쉽고, 정신적·감정적으로도 변화에 대한 민감함이 커질 수 있습니다.`,
      `목욕의 기운은 새 출발 전 정리와 정화의 의미를 품고 있으므로, ${year}년은 복잡한 상황을 조율하며 다음 단계를 준비하는 시간으로 쓰기 좋습니다.`,
    ].join("\n\n");
  }
  if (peak) {
    return [
      `${year}년 연운의 십이운성은 ${h}입니다. 에너지가 크게 올라가기 쉬운 구간으로, 성과와 과로가 동시에 올 수 있습니다.`,
      `${name}님은 이 해에 성과를 내는 만큼 회복 루틴을 함께 고정하는 편이 컨디션을 지키는 데 도움이 됩니다.`,
    ].join("\n\n");
  }
  if (low) {
    return [
      `${year}년 연운의 십이운성은 ${h}입니다. 에너지가 정리·충전 쪽으로 기울기 쉬워, 성급한 추진보다 점검과 계획이 맞을 수 있습니다.`,
      `${name}님은 무리한 확장보다 체력·수면·식사를 먼저 챙기면 이후 속도를 올리기 좋습니다.`,
    ].join("\n\n");
  }
  return [
    `${year}년 연운의 십이운성은 ${h}입니다. 흐름이 바뀌는 구간으로, 준비와 실행의 균형을 맞추는 편이 유리합니다.`,
    `${name}님은 규칙적인 수면과 식사를 지키고 과로를 줄이면 ${u}운의 리듬을 덜 거칠게 탈 수 있습니다.`,
  ].join("\n\n");
}

function yeonunYearSummaryBody(
  name: string,
  year: number,
  c: YeonunColumn,
  stemComp: string,
  branchComp: string,
): string {
  const ss = formatSipseongKoHanja(c.sipseongStem);
  const sb = formatSipseongKoHanja(c.sipseongBranch);
  const u = formatSibiunseongKoHanja(c.sibiunseong);
  return [
    `${year}년 연운은 ${name}님에게 ${stemComp} 천간과 ${branchComp} 지지가 맞물리는 해로 읽을 수 있습니다. 천간 십성 ${ss}와 지지 십성 ${sb}가 함께 작용하면 외부 역할·감정선·생활 환경에서 그 기운이 동시에 드러날 여지가 있으니, 앞선 각 문단에서 짚은 주제를 한 번에 몰아서 해결하려 하기보다 순서를 정해 나누는 편이 좋습니다.`,
    `십이운성이 ${u}로 나타나는 점은 리듬과 회복 방식을 어떻게 가져가느냐에 따라 체감 차이가 커질 수 있음을 뜻합니다. 중요한 선택의 순간에는 감정에만 휘둘리지 않도록 기준을 먼저 적어 두고, 실행 순서를 나누면 훨씬 안정적으로 흐름을 활용하기 좋습니다.`,
  ].join("\n\n");
}

function buildDerivedPromptFacts(input: LlmGenerateInput): string {
  const ext = computeSajuExtended(input.saju.fourPillarsKorean);
  if (!ext) return "";

  const gwinLabel = (items: string[]) => (items.length ? items.join(", ") : "해당없음");
  const day = ext.pillars[1];
  const stemYYEl = formatYinyangElementKoHanja(day.stemYinYang, day.stemElement);
  const branchYYEl = formatYinyangElementKoHanja(day.branchYinYang, day.branchElement);

  const lines: string[] = [
    "## 계산된 해석 데이터",
    `- 일주: ${input.saju.fourPillarsKorean.day} (${ext.pillars[1].stemHanja}(${ext.pillars[1].stemKorean})${ext.pillars[1].branchHanja}(${ext.pillars[1].branchKorean}))`,
    `- 일주 일간(참고 표기): ${day.stemHanja}(${day.stemKorean})은 ${stemYYEl} 성격으로 서술하세요.`,
    `- 일주 일지(참고 표기): ${day.branchHanja}(${day.branchKorean})은 ${branchYYEl} 성격으로 서술하세요.`,
    `- 오행 분포: 목 ${ext.elementPcts.목}%(${ext.elementCounts.목}개), 화 ${ext.elementPcts.화}%(${ext.elementCounts.화}개), 토 ${ext.elementPcts.토}%(${ext.elementCounts.토}개), 금 ${ext.elementPcts.금}%(${ext.elementCounts.금}개), 수 ${ext.elementPcts.수}%(${ext.elementCounts.수}개)`,
    `- 음양 비율: 양 ${ext.yinYangPct.yang}%, 음 ${ext.yinYangPct.yin}%`,
    `- 3장(일주 성격) 참고: 일주 ${input.saju.fourPillarsKorean.day} = 일간 ${day.stemHanja}(${day.stemKorean}) ${stemYYEl}, 일지 ${day.branchHanja}(${day.branchKorean}) ${branchYYEl}. 일간 십성=${day.sipseongStem}, 지지 십성=${day.sipseongBranch}.`,
    `- 시주: ${ext.pillars[0].stemKorean}${ext.pillars[0].branchKorean}, 천간 십성=${ext.pillars[0].sipseongStem}, 지지 십성=${ext.pillars[0].sipseongBranch}, 십이운성=${ext.pillars[0].sibiunseong}, 십이신살=${ext.pillars[0].sibisinsal}, 귀인=${gwinLabel(ext.pillars[0].gwin)}`,
    `- 일주: ${ext.pillars[1].stemKorean}${ext.pillars[1].branchKorean}, 천간 십성=${ext.pillars[1].sipseongStem}, 지지 십성=${ext.pillars[1].sipseongBranch}, 십이운성=${ext.pillars[1].sibiunseong}, 십이신살=${ext.pillars[1].sibisinsal}, 귀인=${gwinLabel(ext.pillars[1].gwin)}`,
    `- 월주: ${ext.pillars[2].stemKorean}${ext.pillars[2].branchKorean}, 천간 십성=${ext.pillars[2].sipseongStem}, 지지 십성=${ext.pillars[2].sipseongBranch}, 십이운성=${ext.pillars[2].sibiunseong}, 십이신살=${ext.pillars[2].sibisinsal}, 귀인=${gwinLabel(ext.pillars[2].gwin)}`,
    `- 연주: ${ext.pillars[3].stemKorean}${ext.pillars[3].branchKorean}, 천간 십성=${ext.pillars[3].sipseongStem}, 지지 십성=${ext.pillars[3].sipseongBranch}, 십이운성=${ext.pillars[3].sibiunseong}, 십이신살=${ext.pillars[3].sibisinsal}, 귀인=${gwinLabel(ext.pillars[3].gwin)}`,
    `- 4장(십성) 서술 순서(필수): 연주(초년)→월주(청년)→일주(중년)→시주(말년). 각 기둥에서 반드시 천간·지지 십성 이름을 아래와 동일하게 쓰세요 — 연간 ${ext.pillars[3].sipseongStem}, 연지 ${ext.pillars[3].sipseongBranch} / 월간 ${ext.pillars[2].sipseongStem}, 월지 ${ext.pillars[2].sipseongBranch} / 일간 ${ext.pillars[1].sipseongStem}, 일지 ${ext.pillars[1].sipseongBranch} / 시간 ${ext.pillars[0].sipseongStem}, 시지 ${ext.pillars[0].sipseongBranch}. (여기서 일간·일지는 일주 기둥의 천간·지지를 뜻합니다.)`,
    `- 5장(십이운성) 서술 순서(필수): 연주(초년)→월주(청년)→일주(중년)→시주(말년). 각 기둥의 십이운성(일간 대비 그 기둥 지지 기준)은 반드시 아래와 문자 그대로 일치 — 연주 ${ext.pillars[3].sibiunseong}, 월주 ${ext.pillars[2].sibiunseong}, 일주 ${ext.pillars[1].sibiunseong}, 시주 ${ext.pillars[0].sibiunseong}.`,
    `- 6장(십이신살·귀인): 신살은 연주(초년)→월주(청년)→일주(중년)→시주(말년) 순. 신살 이름은 반드시 표와 동일 — 연주 ${ext.pillars[3].sibisinsal}, 월주 ${ext.pillars[2].sibisinsal}, 일주 ${ext.pillars[1].sibisinsal}, 시주 ${ext.pillars[0].sibisinsal}. 귀인은 기둥별로 연 ${gwinLabel(ext.pillars[3].gwin)}, 월 ${gwinLabel(ext.pillars[2].gwin)}, 일 ${gwinLabel(ext.pillars[1].gwin)}, 시 ${gwinLabel(ext.pillars[0].gwin)} (없으면 해당없음).`,
    `- 7장(연애·결혼): 일간 ${day.stemHanja}(${day.stemKorean}) ${stemYYEl} 기준으로 성향·연애관을 서술. '살과 귀인의 영향'에서는 초년=연주 신살 ${ext.pillars[3].sibisinsal}·귀인 ${gwinLabel(ext.pillars[3].gwin)}, 청년=월주 ${ext.pillars[2].sibisinsal}·${gwinLabel(ext.pillars[2].gwin)}, 중년=일주 ${ext.pillars[1].sibisinsal}·${gwinLabel(ext.pillars[1].gwin)}, 말년=시주 ${ext.pillars[0].sibisinsal}·${gwinLabel(ext.pillars[0].gwin)} 과 문자 그대로 맞출 것.`,
    `- 8장(재물운): '시간에 따른 재물운의 흐름'은 반드시 네 구간(초년=연주 ${input.saju.fourPillarsKorean.year}, 월주 ${input.saju.fourPillarsKorean.month}, 일주 ${input.saju.fourPillarsKorean.day}, 시주 ${input.saju.fourPillarsKorean.hour})마다 해당 기둥의 천간·지지 십성·십이운성·십이신살·귀인을 표와 동일한 이름으로 넣을 것. 일간 ${day.stemHanja}(${day.stemKorean}) ${stemYYEl}·일지 ${day.branchHanja}(${day.branchKorean}) ${branchYYEl}를 재물 관점에서 풀 것.`,
    `- 9장(직업운): 소제목 순서 고정. '나의 일간 성격에 맞는 직업, 직무'는 일간 ${day.stemHanja}(${day.stemKorean}) ${stemYYEl} 기질과 직종 예시를 샘플 밀도로 연결. '나의 직장운'은 월간·월지 십성을 반드시 이름 그대로 언급 — 월간 ${ext.pillars[2].sipseongStem}, 월지 ${ext.pillars[2].sipseongBranch}(월주 ${input.saju.fourPillarsKorean.month}, 십이운성 ${ext.pillars[2].sibiunseong}). '나의 사업운'은 일주 일지 십성 ${ext.pillars[1].sipseongBranch}와 시주 시지 십성 ${ext.pillars[0].sipseongBranch}(필요 시 시간 천간 십성 ${ext.pillars[0].sipseongStem})을 직업·사업 맥락으로 풀 것. '십이신살과 귀인의 영향'은 연·월·일·시 신살(${ext.pillars[3].sibisinsal}, ${ext.pillars[2].sibisinsal}, ${ext.pillars[1].sibisinsal}, ${ext.pillars[0].sibisinsal})·귀인(연 ${gwinLabel(ext.pillars[3].gwin)}, 월 ${gwinLabel(ext.pillars[2].gwin)}, 일 ${gwinLabel(ext.pillars[1].gwin)}, 시 ${gwinLabel(ext.pillars[0].gwin)})을 직장·이직·사업 변동과 연결해 장문으로 쓸 것.`,
    `- 10장(건강운): 소제목 순서 고정. '나의 건강운'에 음양 비율(양 ${ext.yinYangPct.yang}%, 음 ${ext.yinYangPct.yin}%)과 오행 분포(목·화·토·금·수 %·개수)를 반드시 반영하고, 네 기둥에 나타나는 천간·지지 십성 이름을 건강·스트레스·회복 맥락으로 풀 것(의학 진단 금지, 생활·예방 관점). '시기에 따른 나의 건강운'은 네 문단으로 '초년기 :' '청년기 :' '중년기 :' '말년기 :' 각각 시작하고, 각 문단에 해당 간지(${input.saju.fourPillarsKorean.year}/${input.saju.fourPillarsKorean.month}/${input.saju.fourPillarsKorean.day}/${input.saju.fourPillarsKorean.hour})의 십이운성을 ${ext.pillars[3].sibiunseong}, ${ext.pillars[2].sibiunseong}, ${ext.pillars[1].sibiunseong}, ${ext.pillars[0].sibiunseong}과 한자 병기 형식으로 넣을 것. '십이신살과 귀인의 영향'은 신살·귀인 이름을 표와 동일하게 쓰고 건강에 비유해 풀 것. '주의해야 할 질병'은 소제목 아래 '폐질환 :' 등 항목 라벨을 쓰되 일반적 예방 관점만.`,
    `- 11장(대운): 일간 오행은 ${day.stemHanja}(${day.stemKorean}) 기준 ${stemYYEl}의 천간 오행(${ext.dayStemElement})으로 고정. 각 대운 칸(나의 N세 대운)마다 첫 본문을 '이번 대운의 천간은 한자(한글), 지지는 한자(한글)입니다.'로 시작한 뒤, 대운 천간·지지 각각을 일간 오행과 상생·상극으로 장문 서술하고, 천간·지지 십성은 한자 병기(식신(食神) 형식), 십이운성은 한자 병기(쇠(衰) 형식), 마지막에 정리 문단. 표의 나이·간지·십성·십이운성은 아래 대운 요약과 문자 그대로 일치.`,
    `- 12장(연운): 기준 연도는 ${new Date().getFullYear()}년부터 6개 연도(아래 연운 요약과 동일). 도입 후 각 연도마다 '나의 N년 연운' 제목 다음, 소제목 순서 고정 — '나의 N년 연운 : 천간 …' → '나의 N년 연운 : 지지 …' → '나의 N년 연운 : 천간 십성 …' → '나의 N년 연운 : 지지 십성 …' → '나의 N년 연운 : 십이운성 …' → '나의 N년 연운 종합'. 천간 본문은 'N년 연운의 천간은 병화'처럼 한글천간+오행 합성어로 시작하고 오행 이미지·일간과 상생·상극·'또한 … 천간은 … 십성으로 작용'까지 샘플 밀도(천간 블록 최소 3문단). 지지 본문은 'N년 연운의 지지는 오화' 형식으로 환경·관계 분위기와 일간 상생·상극·균형 주의(최소 3문단). 천간 십성 블록은 한자 병기 후 2문단 이상, 지지 십성은 반드시 '지지 한자(한글)에서는 일간에게 십성'으로 시작(다른 지지 이름을 쓰지 말 것) 후 2~3문단. 십이운성은 한자 병기 후 2~3문단(목욕이면 정화·민감·준비 흐름). 종합은 해당 연도 간지·십성·십이운성을 한데 묶은 2문단. 모든 간지·십성·십이운성은 연운 요약과 문자 그대로 일치.`,
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
      return `### 1장 형식 고정
- 문단 사이는 빈 줄(\\n\\n)으로만 구분. 문단 안 줄바꿈 금지.
- 이 장은 리포트 전체의 '안내 입구'입니다. 반드시 아래 4단락을 순서대로 작성하세요.

단락 1 — 사주(四柱)란 무엇인가 (최소 200자)
  사주(태어난 연·월·일·시의 네 기둥)가 무엇인지, 왜 사람마다 다른지를 일상 언어로 설명. 한자어·명리 용어는 최소화하고, 처음 접하는 독자도 바로 이해할 수 있게.

단락 2 — 이 리포트의 구성 (최소 200자)
  1장~12장이 각각 무엇을 다루는지 짧게 소개. '1장은 사주 소개, 2장은 오행…'처럼 각 장을 한 줄씩 안내해 독자가 전체 구조를 파악할 수 있게.

단락 3 — 리포트를 더 잘 활용하는 방법 (최소 180자)
  결과를 운명으로 받아들이기보다 '현재 흐름을 읽고 선택을 조율하는 도구'로 쓰는 법. 부담 없이 한 장씩 읽어도 된다는 안내.

단락 4 — ${input.name}님 사주 한 줄 요약 (최소 200자)
  ${input.name}님의 생년월일시(${input.saju.fourPillarsKorean.year} ${input.saju.fourPillarsKorean.month} ${input.saju.fourPillarsKorean.day} ${input.saju.fourPillarsKorean.hour})로 본 사주의 가장 두드러진 특징 한 줄과, 이 리포트에서 특히 주목할 장·포인트를 부드럽게 안내.

금지 사항:
- 실존 인물(역사적 위인, 연예인 등) 언급 금지
- 고전 문헌·경전 구절·한시 인용 금지
- 한자 경전 원문 생성 금지
- '주후비멜', '강팔석' 등 무의미하거나 불분명한 단어 생성 금지
- 운세 판정("행운이 따릅니다", "흉한 시기" 등) 금지 — 리듬·활용·조절 언어만 사용`;
    case 2: {
      const extFmt = computeSajuExtended(input.saju.fourPillarsKorean);
      const yinShown = extFmt ? String(extFmt.yinYangPct.yin) : "…";
      const yangShown = extFmt ? String(extFmt.yinYangPct.yang) : "…";
      const ilganRef = extFmt
        ? `${extFmt.pillars[1].stemHanja}(${extFmt.pillars[1].stemKorean})은 ${formatYinyangElementKoHanja(extFmt.pillars[1].stemYinYang, extFmt.pillars[1].stemElement)}`
        : "천간한자(천간한글)은 양/음오행(陰陽五行 한자 병기)";
      const igiRef = extFmt
        ? `${extFmt.pillars[1].branchHanja}(${extFmt.pillars[1].branchKorean})은 ${formatYinyangElementKoHanja(extFmt.pillars[1].branchYinYang, extFmt.pillars[1].branchElement)}`
        : "지지한자(지지한글)은 양/음오행(陰陽五行 한자 병기)";
      return `### 2장 형식 고정
- 문단 사이는 빈 줄(\\n\\n)로만 구분하세요. 문단 안에서는 줄바꿈을 넣지 마세요(한 문장이 PDF에서 중간에 끊기지 않게).
- 반드시 다음 흐름을 지키세요: 음양 개념 설명 -> 오행 개념 설명 -> 상생/상극 설명 -> '${input.name}님의 음양오행 구성' -> '${input.name}님의 음양에 대한 설명' -> '${input.name}님의 일주에 대한 설명' -> 종합 정리.
- 계산된 오행 분포, 음양 비율, 일주(${dayPillar})를 반영하세요.
- '${input.name}님의 음양오행 구성' 단락은 최소 420자 이상으로 작성하세요.
- 이 단락에는 반드시 5개 오행(목/화/토/금/수)의 퍼센트와 개수를 모두 포함하세요.
- 최다 오행(가장 강한 기운) 1개와 최소 오행(가장 약한 기운) 1개를 지정하고, 성향/장단점/보완 방향까지 설명하세요.
- 오행 간 상생/상극 관계를 최소 1개 이상 실제 데이터와 연결해 설명하세요.
- 값이 0%인 오행이 있으면 반드시 그 영향과 보완법을 명시하세요.
- '${input.name}님의 음양에 대한 설명'은 소제목 다음 본문만 최소 360자 이상으로 작성하세요. 반드시 '음(陰) ${yinShown}%, 양(陽) ${yangShown}%'처럼 위 계산 데이터와 동일한 퍼센트를 넣으세요(숫자 임의 변경 금지). 비중이 큰 쪽의 기질(내향·외향, 수용·발산 등)을 풀고, 상대적으로 낮은 쪽에서 생길 수 있는 부족함과 보완 방향을 포함하세요.
- '${input.name}님의 일주에 대한 설명'은 소제목 다음 본문만 최소 420자 이상으로 작성하세요. 일간은 '${ilganRef}' 형식을 반드시 포함하고, 일지는 '${igiRef}' 형식을 반드시 포함한 뒤 ${dayPillar} 일주 조합의 기질을 생활과 연결해 서술하세요. 오행 분포에서 약하거나 0개인 행이 있으면 이 단락 안에서 보완 필요성까지 연결하세요.
- 마지막 종합 문단은 소제목 없이 최소 280자 이상으로, 음양 편중·강한 오행·부족한 오행을 한데 묶어 균형을 잡는 생활 제안으로 마무리하세요.`;
    }
    case 3: {
      const ext3 = computeSajuExtended(input.saju.fourPillarsKorean);
      const d3 = ext3?.pillars[1];
      const pillarPair = d3 ? `${dayPillar}(${d3.stemHanja}${d3.branchHanja})` : dayPillar;
      const stemRef = d3
        ? `${d3.stemHanja}(${d3.stemKorean})·${formatYinyangElementKoHanja(d3.stemYinYang, d3.stemElement)}`
        : "천간한자(한글)·음양오행(陰陽五行)";
      const branchRef = d3
        ? `${d3.branchHanja}(${d3.branchKorean})·${formatYinyangElementKoHanja(d3.branchYinYang, d3.branchElement)}`
        : "지지한자(한글)·음양오행(陰陽五行)";
      return `### 3장 형식 고정
- 문단 사이는 빈 줄(\\n\\n)로만 구분하세요. 문단 안(특히 '특징 :' '영향 :' 본문)에서는 줄바꿈을 넣지 마세요.
- 첫 문장에 반드시 "${input.name}님"과 "${dayPillar} 일주"를 넣고, '~성격을 분석해드리겠습니다'로 이어가세요.
- 반드시 다음 순서를 지키세요: '일간을 기준으로 한 성격 분석' -> 일간 도입 문단(최소 180자) -> 일간 5항목 -> '일지를 기준으로 한 성격 분석' -> 일지 도입 문단(최소 180자) -> 일지 5항목 -> '일간과 일지를 기준으로 한 종합적인 성격분석'.
- 일간 도입 문단: ${pillarPair} 일주의 천간을 중심으로 ${stemRef}의 상징·기질을 경자(庚子) 일주 해설 샘플처럼 구체적으로 풀되, 간지·오행·한자 표기는 반드시 본인 데이터와 일치시키세요.
- 일지 도입 문단: 지지 ${branchRef}를 중심으로 일지 기질을 같은 밀도로 풀고, ${dayPillar} 일지에 해당함을 명시하세요.
- 일간 5항목·일지 5항목: 항목 제목 1줄 다음 빈 줄, 그다음 '특징 :' 한 줄에 본문(최소 85자), 빈 줄, '영향 :' 한 줄에 본문(최소 85자). 항목과 항목 사이는 빈 줄로 구분.
- 종합 문단: 최소 2문단(문단당 최소 180자), 일간·일지 결합 해석 + 대인관계/감정 표현/속도 조절 등 실행 조언으로 마무리.
- 일간은 ${dayStem}, 일지는 ${dayBranch}의 속성을 반영하고, 십성(일간·일지)은 계산 데이터와 맞출 것.`;
    }
    case 4: {
      const ext4 = computeSajuExtended(input.saju.fourPillarsKorean);
      const y = ext4?.pillars[3];
      const m = ext4?.pillars[2];
      const d4 = ext4?.pillars[1];
      const h = ext4?.pillars[0];
      const dataHint = y && m && d4 && h
        ? `연주 ${input.saju.fourPillarsKorean.year}(${y.stemHanja}${y.branchHanja}), 월주 ${input.saju.fourPillarsKorean.month}(${m.stemHanja}${m.branchHanja}), 일주 ${dayPillar}(${d4.stemHanja}${d4.branchHanja}), 시주 ${input.saju.fourPillarsKorean.hour}(${h.stemHanja}${h.branchHanja})`
        : `연월일시 네 기둥(${input.saju.fourPillarsKorean.year} ${input.saju.fourPillarsKorean.month} ${dayPillar} ${input.saju.fourPillarsKorean.hour})`;
      return `### 4장 형식 고정
- 문단 사이는 빈 줄(\\n\\n)로만 구분하세요. 문단 안에서는 줄바꿈을 넣지 마세요(한 글자가 PDF에서 잘리지 않게).
- 반드시 순서: 연주(초년기) → 월주(청년기) → 일주(중년기) → 시주(말년기) → 종합.
- 각 기둥 블록 구조(이 순서·밀도를 지키세요):
  1) 전환 문장 1문장(먼저/다음으로/마지막으로 등) + 해당 기둥이 의미하는 인생 시기를 1문장으로 설명.
  2) 한 문단으로 "○간에는 (천간 십성명)이, ○지에는 (지지 십성명)이 위치하고 있습니다." — ○는 연/월/일/시에 맞게. 십성 이름은 계산 데이터와 문자 그대로 일치.
  3) 천간 십성 해설 문단 1개: 그 십성의 상징·역할을 풀고, 해당 시기(초년·청년·중년·말년) 생활·성향·관계에 어떻게 녹아드는지 서술. 최소 220자.
  4) 지지 십성 해설 문단 1개: 지지 십성의 의미를 풀고 같은 시기 맥락에서 구체적으로 이어가며, 과할 때의 주의나 균형 포인트를 포함. 최소 220자.
- 종합은 소제목 "종합적으로," 또는 "종합적으로 보면"으로 시작하는 2문단: 1문단은 네 시기 흐름을 묶어 요약(최소 260자), 2문단은 ${input.name}님에게 맞는 균형·조절 관점으로 마무리(최소 200자).
- 좋은 십성/나쁜 십성 이분법으로 끊지 말고, 역할과 타이밍으로 읽으세요.
- 십성 이름(겁재·식신·편재 등)이 처음 등장할 때 반드시 바로 뒤에 괄호로 일반인 풀이를 붙이세요. 예: "겁재(나와 비슷한 에너지로 경쟁과 협력이 동시에 일어나는 기운)", "식신(내가 만들어내는 표현·돌봄·창작의 에너지)".
- ${dataHint}의 간지·십성은 반드시 본인 데이터와 일치시키고, 아래 샘플은 문장 길이와 전개만 참고하세요.`;
    }
    case 5: {
      const ext5 = computeSajuExtended(input.saju.fourPillarsKorean);
      const y5 = ext5?.pillars[3];
      const m5 = ext5?.pillars[2];
      const d5 = ext5?.pillars[1];
      const h5 = ext5?.pillars[0];
      const dataHint5 =
        y5 && m5 && d5 && h5
          ? `연주 ${input.saju.fourPillarsKorean.year} 십이운성=${y5.sibiunseong}, 월주 ${input.saju.fourPillarsKorean.month}=${m5.sibiunseong}, 일주 ${dayPillar}=${d5.sibiunseong}, 시주 ${input.saju.fourPillarsKorean.hour}=${h5.sibiunseong}`
          : `연월일시 네 기둥의 십이운성(표와 동일)`;
      return `### 5장 형식 고정
- 문단 사이는 빈 줄(\\n\\n)로만 구분하세요. 문단 안에서는 줄바꿈을 넣지 마세요. '십이운성' 등 고유명사는 반드시 한 줄 안에 붙여 쓰세요.
- 맨 앞에 전체 도입 1~2문단: 십이운성이 시기별 리듬을 어떻게 보여 주는지, 하나씩 보겠다는 안내(샘플처럼 자연스러운 문장). 도입만 합쳐 최소 120자.
- 본문 순서(필수): 연주(초년기) → 월주(청년기) → 일주(중년기) → 시주(말년기) → 종합.
- 각 기둥 블록마다:
  1) 전환 문장(먼저/다음으로/마지막으로) + 해당 기둥이 의미하는 시기를 한 문장으로.
  2) 한 문단으로 '○주에는 (십이운성 한글명)(한자 병기)이 위치하고 있습니다.' 형식 — ○는 연/월/일/시. 운성 이름은 ${dataHint5}와 반드시 일치, 한자는 예: 제왕(帝旺)·병(病)·사(死)·묘(墓)처럼 병기.
  3) 그 운성을 풀어 쓰는 해설 문단 1개: 상징·에너지 강약·그 시기 생활·관계·주의·성장으로 이어지며 최소 240자. 강한 운성이면 성취·리더십 등, 약하거나 전환 운성이면 시행착오·내적 성장·재정비 등으로 균형 있게 서술.
- 종합: '종합적으로,'로 시작하는 긴 문단 1개(네 시기 흐름을 묶어 최소 280자) + ${input.name}님께 리듬표처럼 읽으라는 조언으로 마무리하는 문단 1개(최소 160자).
- 결과의 좋음/나쁨으로 단정하지 말고, 에너지가 오르는 구간과 쉬어야 할 구간을 읽는 관점을 유지하세요.
- 십이운성 이름이 처음 등장할 때 반드시 일반인 풀이를 붙이세요. 예: "건록(자기 역할이 안정되는 에너지 충만기)", "병(에너지가 회복을 필요로 하는 조정기)", "제왕(에너지 최고조기로 추진력이 강해지는 시기)". '병'이나 '사'처럼 부정적으로 들릴 수 있는 이름은 반드시 중립·성장 언어(회복기, 정리기, 전환기)와 나란히 쓰세요.`;
    }
    case 6: {
      const ext6 = computeSajuExtended(input.saju.fourPillarsKorean);
      const g6 = (items: string[]) => (items.length ? items.join(", ") : "해당없음");
      const y6 = ext6?.pillars[3];
      const m6 = ext6?.pillars[2];
      const d6 = ext6?.pillars[1];
      const h6 = ext6?.pillars[0];
      const salHint =
        y6 && m6 && d6 && h6
          ? `연 ${y6.sibisinsal}, 월 ${m6.sibisinsal}, 일 ${d6.sibisinsal}, 시 ${h6.sibisinsal}`
          : "표의 십이신살 행과 동일";
      const gwinHint =
        y6 && m6 && d6 && h6
          ? `연 ${g6(y6.gwin)}, 월 ${g6(m6.gwin)}, 일 ${g6(d6.gwin)}, 시 ${g6(h6.gwin)}`
          : "표의 귀인 행과 동일";
      return `### 6장 형식 고정
- 문단 사이는 빈 줄(\\n\\n)로만 구분하세요. 문단 안 줄바꿈 금지. '십이신살' '귀인' 등 고유명사는 띄어쓰기 포함 한 덩어리로 쓰세요.
- 맨 앞 도입 2문단(합쳐 최소 120자): 십이신살과 귀인의 조합이 삶에 어떤 식으로 스며드는지, 요소를 하나씩 풀겠다는 안내(샘플처럼 부드러운 화법).
- 다음 줄에 반드시 포함: 십이신살에 대해 먼저 풀이해보겠습니다!
- 신살 본문 순서(필수): 연주(초년기) → 월주(청년기) → 일주(중년기) → 시주(말년기).
- 각 기둥마다: (1) 전환+해당 시기·기둥의 의미를 짧게 한 문단 (2) '○주에는 (신살 이름)이 위치하고 있습니다.' 한 문단 — 신살 이름은 ${salHint}와 문자 그대로 일치 (3) 그 신살의 상징·생활·관계·주의를 풀어 쓰는 해설 문단 1개, 최소 240자.
- 그다음 반드시 포함: 이제 귀인에 대해서 알아볼까요?
- 귀인: ${gwinHint}. 귀인이 있는 기둥만 '○주를 풀이해드리겠습니다' 전환 + '○주에는 (귀인명)이 위치하고 있습니다' + 귀인 해설 장문(최소 220자). 해당없음인 기둥은 장문 풀이를 생략해도 되나, 필요하면 한 문장으로만 언급.
- 귀인 일반 설명 문단 1개: 도움·숨통·보조 지표 관점(샘플 밀도).
- 마지막 '종합적으로,'로 시작하는 장문 1개(네 시기와 신살·귀인을 묶어 최소 280자) + 긍정적 활용·지혜로운 선택 등으로 마무리.
- 신살을 사건 절대화하지 말고, 인연·이동·갈등·내면 등 흐름으로 읽으세요.`;
    }
    case 7: {
      const ext7 = computeSajuExtended(input.saju.fourPillarsKorean);
      const d7 = ext7?.pillars[1];
      const stemLine = d7
        ? `일간 ${d7.stemHanja}(${d7.stemKorean}) ${formatYinyangElementKoHanja(d7.stemYinYang, d7.stemElement)}`
        : `일간(${dayPillar[0] ?? "?"}) 음양오행(陰陽五行)`;
      return `### 7장 형식 고정
- 문단 사이는 빈 줄(\\n\\n)로만 구분하세요. 문단 안 줄바꿈 금지. '연애운' '결혼운' 등은 한 덩어리로 쓰세요.
- 소제목 순서(필수): 연애운 풀이 → 일간 성격과 연애 성향 → 연애에서 나타나는 장단점 → 연애 시기와 방법 → 살과 귀인의 영향 → 성공적인 연애를 위한 조언 → 나의 결혼운 → 이상적인 배우자상과 피해야할 배우자상 → 배우자와의 관계 전망 → 연애에서 피해야 할 점 → 종합분석.
- 각 소제목은 제목 한 줄 다음 빈 줄, 그다음 본문만(제목 반복 금지).
- 연애운 풀이: ${input.name}님 중심으로 연애 흐름의 핵심을 최소 200자.
- 일간 성격과 연애 성향: 반드시 ${stemLine}을(를) 문장 안에 넣고, 겉모습·내면·사랑에서의 기준·헌신 등을 샘플 밀도로 최소 260자.
- 연애에서 나타나는 장단점: 본문에 '장점:' '단점:'으로 나누어 각각 최소 140자 이상.
- 연애 시기와 방법: 반드시 '언제:' '어디서:' '누구와:' '어떻게:' 네 줄(또는 네 문단)으로 나누고 항목마다 최소 90자.
- 살과 귀인의 영향: 초년·청년·중년·말년 네 구간을 반드시 각각 새 줄에 쓰세요. 형식: "초년: …\n청년: …\n중년: …\n말년: …" (각 구간은 최소 60자, 전체 최소 320자). 각 구간에 실제 십이신살·귀인 이름을 넣고, 괄호로 일반인 풀이를 바로 붙이세요. 예: "역마살(이동·변화가 잦아지는 흐름)".
- 성공적인 연애를 위한 조언: 실행 문장 중심 최소 180자.
- 나의 결혼운: 시기감·결혼생활의 안정·역할 최소 200자.
- 이상적인 배우자상과 피해야할 배우자상: '이상적인 배우자상:' '피해야할 배우자상:'으로 나누어 각 최소 160자.
- 배우자와의 관계 전망: 신뢰·책임·감정 표현 주의 등 최소 200자.
- 연애에서 피해야 할 점: 최소 180자.
- 종합분석: ${input.name}님의 연애·결혼을 한데 묶어 최소 260자.`;
    }
    case 8: {
      const ext8 = computeSajuExtended(input.saju.fourPillarsKorean);
      const y8 = ext8?.pillars[3];
      const m8 = ext8?.pillars[2];
      const d8 = ext8?.pillars[1];
      const h8 = ext8?.pillars[0];
      const flowHint =
        y8 && m8 && d8 && h8
          ? `초년기 ${input.saju.fourPillarsKorean.year}(${y8.stemHanja}${y8.branchHanja}) 천간십성 ${y8.sipseongStem}·지지십성 ${y8.sipseongBranch}·십이운성 ${y8.sibiunseong}·신살 ${y8.sibisinsal} / 청년기 ${input.saju.fourPillarsKorean.month}(${m8.stemHanja}${m8.branchHanja}) ${m8.sipseongStem}·${m8.sipseongBranch}·${m8.sibiunseong}·${m8.sibisinsal} / 중년기 ${dayPillar}(${d8.stemHanja}${d8.branchHanja}) ${d8.sipseongStem}·${d8.sipseongBranch}·${d8.sibiunseong}·${d8.sibisinsal} / 말년기 ${input.saju.fourPillarsKorean.hour}(${h8.stemHanja}${h8.branchHanja}) ${h8.sipseongStem}·${h8.sipseongBranch}·${h8.sibiunseong}·${h8.sibisinsal}`
          : "연월일시 네 기둥의 간지·십성·십이운성·신살(표와 동일)";
      return `### 8장 형식 고정
- 문단 사이는 빈 줄(\\n\\n)로만 구분하세요. 문단 안 줄바꿈 금지. '재물운' '십이신살' 등 고유명사는 한 덩어리로 쓰세요.
- 소제목 순서(필수): 재물운 풀이 → 일간 성격과 재물운 → 시간에 따른 재물운의 흐름 → 재물운이 크게 들어오는 시기 → 살과 귀인의 영향 → 주의해야 될 시기 → 어떻게 재물을 모으게 될까? → 성공적인 재물의 축적 방법 → 종합분석.
- 재물운 풀이: ${input.name}님 중심, 관리 습관·구조·속도 조절 관점, 최소 200자.
- 일간 성격과 재물운: '나의 일간은 ${d8 ? `${d8.stemKorean}으로` : "일간으로"}'처럼 일간 오행 기질을 먼저 밝히고(한자·한글·음양오행 병기 권장), 재물 축적·판단·실행과 연결해 샘플 밀도로 최소 280자.
- 시간에 따른 재물운의 흐름: 네 문단으로 '초년기 :' '청년기 :' '중년기 :' '말년기 :' 각각 시작. 각 문단에 해당 간지·천간·지지 십성·십이운성을 반드시 넣고 신살·귀인을 재물 맥락으로 풀며 최소 220자. 데이터: ${flowHint}
- 재물운이 크게 들어오는 시기: 중년·말년 등 시기 지정과 이유를 구체적으로 최소 200자.
- 살과 귀인의 영향: 네 기둥에서 나타나는 십이신살·귀인을 재물(기회·변동·조언) 관점으로 묶어 최소 260자. 이름은 계산값과 일치.
- 주의해야 될 시기: 청년·중년 등 구체 시기와 소비·확장·경쟁 등 최소 200자.
- 어떻게 재물을 모으게 될까?: 일간 기질과 맞는 축적 방식, 귀인 활용, 최소 200자.
- 성공적인 재물의 축적 방법: 목표·균형·귀인·리스크, 최소 200자.
- 종합분석: ${input.name}님 사주의 재물 구조를 한 문단으로 최소 280자.`;
    }
    case 9: {
      const ext9 = computeSajuExtended(input.saju.fourPillarsKorean);
      const m9 = ext9?.pillars[2];
      const d9 = ext9?.pillars[1];
      const h9 = ext9?.pillars[0];
      const jobStemLine = d9
        ? `일간 ${d9.stemHanja}(${d9.stemKorean}) ${formatYinyangElementKoHanja(d9.stemYinYang, d9.stemElement)}`
        : `일간(${dayPillar[0] ?? "?"}) 음양오행(陰陽五行)`;
      const monthJobHint =
        m9 && h9 && d9
          ? `직장(월주 ${input.saju.fourPillarsKorean.month}): 월간 ${m9.sipseongStem}·월지 ${m9.sipseongBranch}·운성 ${m9.sibiunseong}. 사업(일·시): 일지 ${d9.sipseongBranch}, 시지 ${h9.sipseongBranch}(시간 천간 십성 ${h9.sipseongStem}).`
          : "월간·월지·일지·시지 십성은 표와 동일한 이름으로 인용";
      return `### 9장 형식 고정
- 문단 사이는 빈 줄(\\n\\n)로만 구분하세요. 문단 안 줄바꿈 금지. '직업운' '직장운' '사업운' '십이신살' 등 고유명사는 한 덩어리로 쓰세요.
- 소제목 순서(필수): 직업운 풀이 → 나의 일간 성격에 맞는 직업, 직무 → 나의 직장운 → 나의 사업운 → 십이신살과 귀인의 영향 → 성공적인 직장생활을 위한 조언 → 종합분석.
- 직업운 풀이: ${input.name}님 중심으로 역할·구조·지속 가능성 관점, 최소 200자. ${dayPillar} 일주를 축으로 네 기둥과 연결해 한 문단으로.
- 나의 일간 성격에 맞는 직업, 직무: 반드시 '${jobStemLine}'으로 시작하거나 본문 초반에 포함. 일간 오행 기질(금속·성취·규범 등 은유)과 맞는 직종군을 2~3개 이상 구체적으로 들고, 논리·분석·체계와 연결해 샘플 밀도로 최소 360자.
- 나의 직장운: 월간·월지가 청년·직장 흐름임을 밝히고, 월지 십성·월간 십성을 작은따옴표로 인용하듯 이름 그대로 넣어 장문으로 풀 것. 경쟁·협력·보고 체계 등 실무 맥락 포함, 최소 320자. 데이터: ${monthJobHint}
- 나의 사업운: 사업은 일지·시지에서 읽는다는 전제로 일지 십성·시지 십성을 이름 그대로 넣고 독립·동업·전략·리스크를 풀어 최소 300자.
- 십이신살과 귀인의 영향: 네 기둥에서 드러나는 십이신살을 직업 변화·이동·대인관계로 풀고, 귀인은 학문·위기 조력 등 직무 맥락으로 장문(최소 380자). 신살·귀인 이름은 계산값과 일치.
- 성공적인 직장생활을 위한 조언: 일간 기질의 과단점(완고·완벽주의 등)과 월간 십성이 주는 경쟁·갈등 완화, 시지 십성의 안정 에너지 활용을 연결해 실행 문장 중심 최소 280자.
- 종합분석: ${input.name}님 사주의 직장·사업·신살·귀인을 한 문단으로 묶어 최소 300자.`;
    }
    case 10: {
      const ext10 = computeSajuExtended(input.saju.fourPillarsKorean);
      const y10 = ext10?.pillars[3];
      const m10 = ext10?.pillars[2];
      const d10 = ext10?.pillars[1];
      const h10 = ext10?.pillars[0];
      const flowHealth =
        y10 && m10 && d10 && h10
          ? `초년기 ${input.saju.fourPillarsKorean.year} 십이운성 ${y10.sibiunseong} / 청년기 ${input.saju.fourPillarsKorean.month} ${m10.sibiunseong} / 중년기 ${dayPillar} ${d10.sibiunseong} / 말년기 ${input.saju.fourPillarsKorean.hour} ${h10.sibiunseong}`
          : "연월일시 각 기둥 십이운성(표와 동일)";
      const yy10 = ext10
        ? `음 ${ext10.yinYangPct.yin}%·양 ${ext10.yinYangPct.yang}%, 오행 목${ext10.elementPcts.목}%·화${ext10.elementPcts.화}%·토${ext10.elementPcts.토}%·금${ext10.elementPcts.금}%·수${ext10.elementPcts.수}%`
        : "계산된 음양·오행";
      return `### 10장 형식 고정
- 문단 사이는 빈 줄(\\n\\n)로만 구분하세요. 문단 안 줄바꿈 금지. '건강운' '스트레스' '추천 운동' 등 고유명사는 한 덩어리로 쓰세요.
- 소제목 순서(필수): 건강운 풀이 → 나의 건강운 → 십이신살과 귀인의 영향 → 시기에 따른 나의 건강운 → 주의해야 할 질병 → 추천 운동 → 추천 식단 → 종합분석.
- 의학적 진단·단정은 금지. 생활 리듬·예방·스트레스 관리 관점으로만 서술하세요.
- 건강운 풀이: ${input.name}님 중심으로 피로 누적·회복 리듬·루틴 안정성, 최소 200자.
- 나의 건강운: 반드시 ${yy10}을 본문에 포함하고, 네 기둥에 드러나는 십성 흐름(상관·겁재·정관·정인 등 실제 이름)을 감정·스트레스·체력과 연결해 샘플 밀도로 최소 380자. 일간 ${d10 ? `${d10.stemHanja}(${d10.stemKorean})` : "일간"} 기준으로 읽되 장기를 특정 진단하지 말 것.
- 십이신살과 귀인의 영향: 네 기둥 신살·귀인을 이름 그대로 넣어 변동·관계 스트레스·회복 통로로 장문(최소 340자).
- 시기에 따른 나의 건강운: 네 문단 '초년기 :'~'말년기 :', 각 문단에 해당 간지·${formatSibiunseongKoHanja(y10?.sibiunseong ?? "제왕")} 같은 십이운성(한자 병기)과 체력·과로·회복 포인트, 최소 200자/문단. 데이터: ${flowHealth}
- 주의해야 할 질병: '폐질환 :' '신경계 질환 :' '소화기 계통 :'처럼 라벨을 쓰고 항목마다 최소 120자, 예방·생활 습관만.
- 추천 운동·추천 식단: 오행 균형에 맞춘 구체 예시(유산소·요가·따뜻한 식재료 등) 각 최소 200자.
- 종합분석: ${input.name}님 건강운을 한 문단으로 최소 280자.`;
    }
    case 11: {
      const ext11 = computeSajuExtended(input.saju.fourPillarsKorean);
      const dayStemLabel = ext11
        ? `${ext11.pillars[1].stemHanja}(${ext11.pillars[1].stemKorean})`
        : `일간한자(일간)`;
      const dayElKo = ext11?.dayStemElement ?? "일간오행";
      return `### 11장 형식 고정
- 문단 사이는 빈 줄(\\n\\n)로만 구분하세요. 문단 안 줄바꿈 금지. '대운' '십이운성' '상생' 등은 한 덩어리로 쓰세요.
- 먼저 대운 전체(10년 단위 흐름)를 아우르는 도입 문단 1개(최소 240자).
- 이어서 10개 블록. 각 블록은 제목 한 줄 '나의 N세 대운' 다음 빈 줄, 그다음 본문.
- 각 블록 본문 순서(필수):
  1) 첫 문장: '이번 대운의 천간은 한자(한글), 지지는 한자(한글)입니다.' (천간·지지를 한 문장에 묶어도 됨).
  2) 천간 오행을 ${dayStemLabel} 일간의 ${dayElKo} 오행과 상생·상극 관점에서 풀 장문(최소 220자). 임수(壬水)·경금(庚金)처럼 천간+오행+한자 병기. 학업·자기계발·역량 발휘 등 연결.
  3) 지지 오행을 일간과 상생·상극으로 풀 장문(최소 220자). 술토(戌土)·양토(陽土)처럼 지지·토성·음양 병기. 재물·환경·기반 등 연결.
  4) '천간의 십성은 식신(食神)입니다.' 형식(한자 병기) 후 십성 성격·생활 연결 장문(최소 200자).
  5) '지지의 십성은 편인(偏印)입니다.' 형식 후 장문(최소 200자).
  6) '십이운성은 쇠(衰)입니다.' 형식(한자 병기) 후 리듬·과로·준비·건강 주의 장문(최소 200자).
  7) '정리보면'으로 시작하는 종합 문단(최소 220자). 재물·학업·관계·균형을 한데 묶을 것.
- 각 칸의 간지·십성·십이운성은 반드시 '계산된 해석 데이터' 대운 요약과 동일한 문자.`;
    }
    case 12: {
      const ext12 = computeSajuExtended(input.saju.fourPillarsKorean);
      const dayStemLabel12 = ext12
        ? `${ext12.pillars[1].stemHanja}(${ext12.pillars[1].stemKorean})`
        : "일간한자(일간)";
      const dayElKo12 = ext12?.dayStemElement ?? "일간오행";
      const y0 = new Date().getFullYear();
      return `### 12장 형식 고정
- 문단 사이는 빈 줄(\\n\\n)로만 구분하세요. 문단 안 줄바꿈 금지. '연운' '십이운성' 등은 한 덩어리로 쓰세요.
- 먼저 연운 전체(최근 6개 연도 흐름)를 아우르는 도입 문단 1개(최소 220자). 기준 시작 연도는 ${y0}년임을 짚어 주세요.
- 이어서 6개 연도 블록. 각 블록은 제목 한 줄 '나의 N년 연운' 다음 빈 줄, 그다음 소제목·본문.
- 각 연도 본문 순서(필수):
  1) '나의 N년 연운 : 천간 한자(한글)' 다음 본문: 'N년 연운의 천간은 (한글천간+오행 합성어)입니다.'로 시작 → 오행 이미지 한 문장 → ${dayStemLabel12} 일간의 ${dayElKo12} 오행과 상생·상극 장문(최소 200자) → '또한 (합성어) 천간은 … 십성으로 작용' 형식으로 연간 천간 십성(${dayStemLabel12} 기준)과 연결한 문단(최소 180자).
  2) '나의 N년 연운 : 지지 한자(한글)' 다음 본문: 'N년 연운의 지지는 (합성어)입니다.'로 시작 → 환경·관계·활동 분위기 장문 → 일간과 상생·상극 장문 → 균형·주의 한 문단(최소 3문단 합산 520자 이상).
  3) '나의 N년 연운 : 천간 십성 이름' 다음 본문: 십성 한자 병기(편관(偏官) 형식) 후 2문단 이상(각 최소 180자).
  4) '나의 N년 연운 : 지지 십성 이름' 다음 본문: 반드시 '지지 한자(한글)에서는 일간에게 십성한자(한글)이 작용합니다'로 시작(표의 그 해 지지·십성과 동일 문자). 이어 2~3문단(각 최소 160자).
  5) '나의 N년 연운 : 십이운성 이름' 다음 본문: 십이운성 한자 병기(목욕(沐浴) 형식) 후 2~3문단, 리듬·민감도·준비·회복(최소 480자 합산).
  6) '나의 N년 연운 종합' 다음 본문: 해당 연도 천간·지지·십성·십이운성을 묶어 2문단(각 최소 200자).
- 각 연도의 간지·십성·십이운성은 반드시 '계산된 해석 데이터' 연운 요약과 동일한 문자.`;
    }
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
        "- 개인 파트는 반드시 '계산된 해석 데이터' 숫자·일간·일지 표기와 일치시키고, 음양 설명은 비율의 의미·기질·반대 기운 부족 시 주의를 풀어 쓰세요.",
        "- 일주 설명은 천간·지지를 각각 한자(한글)+음양오행(陰陽五行)까지 풀고, 마지막 종합에서 강한 오행·부족한 오행·음양 편중을 한 문단으로 묶어 생활 균형 제안으로 끝내세요.",
        "",
        "먼저, 음양은 모든 존재와 현상이 두 가지 상반된 성질을 지닌다는 원리를 의미하는데요, 음은 어두움, 추움, 고요함, 내부 지향성, 수축, 여성적 이미지를 상징하며, 양은 밝음, 따뜻함, 움직임, 외부 지향성, 확장, 남성적 이미지를 상징합니다. 음양은 서로 대립하는 것처럼 보이지만 실상은 상호 보완적이며, 끊임없이 변화를 거듭하며 균형을 이루는 관계를 의미합니다.",
        "오행은 이 음양의 토대 위에 자연계의 변화 원리를 보다 구체적으로 설명하기 위한 다섯 가지 요소입니다. 오행은 목, 화, 토, 금, 수라는 다섯 가지로 구성되며, 이들은 단순히 물질적 요소를 가리키는 것이 아니라 사물과 현상을 바라보는 다원적 관점을 제공합니다.",
        "화(火)는 여름, 열기, 번영, 활발한 외향적 성격을 갖추어 불길처럼 치솟는 생명력을 보여줍니다. 수(水)는 겨울, 차가움, 잠재성, 휴식을 의미하며, 만물을 지탱하고 침전시키며 다음 발아를 준비하는 에너지를 품고 있습니다. 목(木)은 봄, 생장, 탄생, 확장과 같은 성격을 지니며, 나무처럼 위로 뻗는 성장의 에너지를 상징합니다. 금(金)은 가을, 결실, 수축, 단단함을 상징하며, 수확과 응축의 힘을 담당합니다. 토(土)는 간절기, 중앙, 균형, 안정, 중립적 역할을 하며, 다른 네 행이 원활히 소통하고 전환하는 매개체가 됩니다.",
        "이후에는 반드시 개인 데이터 기반으로 'OOO님의 음양오행 구성', 'OOO님의 음양에 대한 설명', 'OOO님의 일주에 대한 설명', 종합 정리 순으로 이어가세요.",
      ].join("\n");
    case 3:
      return [
        "## 3장 기준 원고/스타일",
        "- 아래처럼 '일간 도입 + 일간 5항목 + 일지 도입 + 일지 5항목 + 종합' 구조를 유지하세요.",
        "- 각 항목은 반드시 '제목 1줄 -> 빈 줄 -> 특징 : 한 줄 본문 -> 빈 줄 -> 영향 : 한 줄 본문' 구조를 지키세요. 특징·영향 본문은 문장 중간에 줄바꿈을 넣지 마세요.",
        "- 항목과 항목 사이는 반드시 빈 줄로 구분하세요.",
        "- '경자' 아래 예시는 문장 밀도·한자 병기 패턴만 참고하고, 간지·이름·오행 서술은 계산 데이터의 일주로 반드시 바꾸세요.",
        "",
        "OOO님, 경자 일주에 대한 성격을 분석해드리겠습니다.",
        "일간을 기준으로 한 성격 분석",
        "",
        "경자(庚子) 일주는 천간이 경(庚)으로 태어난 사람을 의미합니다. 경금(庚金)은 강한 금속을 상징하며, 이는 성격에 단단하고 결단력 있는 모습을 드러냅니다.",
        "",
        "강한 결단력",
        "특징 : 경금은 스스로의 의지가 강하고, 한번 결정한 일을 쉽게 물러서지 않는 특성을 보입니다.",
        "영향 : 이러한 성격으로 인해 목표를 세운 후 실행력 있게 추진하며, 타인에게 신뢰받는 영향을 줍니다.",
        "",
        "책임감 있는 성향",
        "특징 : 경금은 자신이 맡은 일에 대해 끝까지 책임을 지려는 성향이 강합니다.",
        "영향 : 주변에서는 믿음직스럽다는 평가를 받을 수 있지만, 일이 과중될 경우 스트레스를 받을 가능성도 있습니다.",
        "",
        "원칙과 규율 존중",
        "특징 : 경금은 규칙과 원칙을 중시하고, 자신의 기준을 지키려는 측면이 두드러집니다.",
        "영향 : 체계적으로 일을 처리하나, 때로는 융통성이 부족하다는 인상을 줄 수 있습니다.",
        "",
        "솔직한 표현 방식",
        "특징 : 경금은 자신의 생각을 숨기지 않고 직설적으로 표현하는 경향이 강합니다.",
        "영향 : 솔직함은 투명성을 더하나, 상대방에게 감정적인 오해를 불러일으킬 수 있습니다.",
        "",
        "단단한 끈기와 인내",
        "특징 : 경금은 어려운 상황에서도 쉽게 무너지지 않는 끈기를 가지고 있습니다.",
        "영향 : 장기적인 프로젝트나 상황에서 뛰어난 성과를 내지만, 때로는 자신의 어려움을 잘 드러내지 않기도 합니다.",
        "",
        "일지를 기준으로 한 성격 분석",
        "",
        "경자(庚子) 일주의 지지는 자(子)이므로 일지에 자수(子水)의 성격이 드러납니다. 자수(子水)는 겨울의 물로, 지혜와 유연함, 그리고 깊이를 상징합니다.",
        "",
        "유연한 사고방식",
        "특징 : 자수는 물처럼 흐름에 따라 유연하게 대처할 수 있는 성향을 가집니다.",
        "영향 : 다양한 상황에 적응하는 능력이 뛰어나며, 주변의 변화에도 비교적 잘 대응합니다.",
        "",
        "지혜와 직관",
        "특징 : 자수는 깊은 사고와 함께 직관적인 면모를 가지고 있습니다.",
        "영향 : 문제를 해결할 때 본질을 꿰뚫는 통찰력을 발휘하며, 주변 사람들에게 현명하다는 인상을 줄 수 있습니다.",
        "",
        "내향적인 성향",
        "특징 : 자수는 감정을 내면으로 숨기는 경향이 있어 감정 표현이 절제된 모습을 보입니다.",
        "영향 : 이런 성향은 차분하고 안정적이지만, 감정을 밖으로 드러내지 않아 오해를 살 가능성도 있습니다.",
        "",
        "예민함",
        "특징 : 자수는 세세한 부분까지 신경을 쓰는 예민함을 가지고 있습니다.",
        "영향 : 타인에게 세심한 배려를 보여주지만, 지나친 걱정을 하거나 스트레스를 받을 가능성도 있습니다.",
        "",
        "빠른 배움",
        "특징 : 물처럼 유동적인 자수는 새로운 지식이나 환경을 빨리 흡수하는 학습 능력이 뛰어납니다.",
        "영향 : 다른 사람보다 새로운 일에 금방 적응하며, 다방면에 걸쳐 능력을 발휘합니다.",
        "",
        "일간과 일지를 기준으로 한 종합적인 성격분석",
        "경자(庚子) 일주는 강하고 단단한 경금(庚金)의 추진력과 자수(子水)의 지혜로움과 유연함이 결합된 성격을 가지고 있습니다. 이들은 큰 목표를 향해 끊임없이 나아가며, 깊은 사고력과 직관으로 다양한 문제를 효과적으로 해결할 수 있는 능력이 탁월합니다.",
        "- 실제 작성 시 예시 문장을 복붙하지 말고, 대상자 일주·이름·오행에 맞게 전부 새로 쓰세요.",
      ].join("\n");
    case 4:
      return [
        "## 4장 기준 원고/스타일",
        "- 연주→월주→일주→시주→종합 순서, 각 기둥마다 전환+시기 설명 → '○간에는 …이, ○지에는 …이 위치' 한 문단 → 천간 십성 장문 → 지지 십성 장문.",
        "- 문단 안 줄바꿈 금지. 십성 이름·간지는 계산 데이터와 동일. 아래는 문장 밀도·전개만 참고(간지·십성은 본인 사주로 반드시 교체).",
        "",
        "먼저, 초년기를 의미하는 연주부터 풀이해드리겠습니다. 연주는 어린 시절의 환경과 초반 사회화 과정에서 형성된 태도를 읽는 데 도움이 됩니다.",
        "연간에는 상관이, 연지에는 겁재가 위치하고 있습니다.",
        "연간의 상관은 창의성과 개성, 그리고 자유로운 사고를 나타냅니다. 초년기에는 틀에 얽매이기를 싫어하고 자신만의 독창적인 방식으로 표현하길 원했을 가능성이 높습니다. 또한 적극적으로 자신을 드러내며, 다른 사람들과 차별화된 행동으로 주목받았을 것입니다. 다만 상관은 지나치게 표현 욕구가 강하면 갈등을 유발할 수도 있으니, 이 시기에 간혹 주변과의 조화를 이루는 데 어려움을 겪었을 가능성도 있습니다.",
        "연지의 겁재는 형제, 친구 같은 동료들과의 관계와 경쟁을 뜻합니다. 초년기에는 이러한 대인관계를 통해 성장하고, 자신의 위치를 찾기 위해 다소 경쟁적인 모습을 보였을 가능성이 큽니다. 겁재의 특징이 남을 도우며도 자신을 지키는 것이기에, 적극적이고 도전적인 성향이 초년기의 특징으로 나타났을 것입니다.",
        "(이하 월·일·시 기둥도 위와 같은 밀도로 이어가고, 종합은 시기 흐름을 묶는 장문 2문단으로 마무리하세요.)",
      ].join("\n");
    case 5:
      return [
        "## 5장 기준 원고/스타일",
        "- 도입 → 연주→월주→일주→시주 → 종합 순서. 각 기둥: 전환+시기 설명 → '○주에는 운성(漢字) 위치' 한 문단 → 운성 해설 장문 한 문단.",
        "- 문단 안 줄바꿈 금지. 아래 운성·한자는 예시일 뿐이며, 계산 데이터의 십이운성으로 반드시 바꿀 것.",
        "",
        "이 사주의 십이운성을 보면, 각각의 운성들이 그 사람의 삶에서 중요한 시기와 흐름을 보여주고 있습니다. 하나씩 살보면서 전체적인 흐름을 설명해드리겠습니다.",
        "먼저, 초년기를 의미하는 연주부터 풀이해드리겠습니다. 연주에는 제왕(帝旺)이 위치하고 있습니다.",
        "제왕은 십이운성 중 가장 강한 에너지를 나타내며, 성취와 권위를 상징합니다. 초년기에 이른 나이에 이미 자신감과 리더십을 발휘하며 주목받는 존재였을 가능성이 큽니다. 가정에서도 주위의 사랑과 지원을 받으며 성장했으며, 어린 나이에도 또래보다 성숙한 면모를 보이며 주목받았을 것입니다. 사회적으로도 두각을 나타낼 수 있는 자질을 초년기부터 갖추게 되었을 것으로 보입니다.",
        "(월·일·시도 위와 같은 밀도로 이어가고, 종합은 네 시기를 아우르는 장문으로 마무리하세요.)",
      ].join("\n");
    case 6:
      return [
        "## 6장 기준 원고/스타일",
        "- 도입 2문단 → 십이신살에 대해 먼저 풀이해보겠습니다! → 연·월·일·시 신살 각각 '위치' 문장+장문 해설 → 이제 귀인에 대해서 알아볼까요? → 귀인 있는 기둥만 장문 → 귀인 일반 설명 → 종합 장문.",
        "- 문단 안 줄바꿈 금지. 아래 년살·역마살 등은 예시이며 신살·귀인 이름은 계산 데이터로 반드시 교체.",
        "",
        "이 사주를 보면, 십이신살과 귀인의 조합이 어떻게 이 사람의 삶에 영향을 미칠지 알 수 있습니다. 각각의 요소를 하나씩 살보면서 풀어볼게요.",
        "십이신살에 대해 먼저 풀이해보겠습니다!",
        "먼저, 초년기를 의미하는 연주부터 분석해보겠습니다. 연주에는 년살이 위치하고 있습니다.",
        "년살은 연결과 인연의 기운을 나타내며, 초년기에 이 기운이 작용한다는 것은 이 사람이 어린 시절부터 다양한 인연을 경험했을 가능성을 보여줍니다. 주변 환경과 사람들의 영향을 많이 받으며, 사회성과 인간관계를 배우는 과정에서 성장했을 것입니다. 하지만 이러한 인연의 폭이 넓다 보니 때로는 혼란을 겪을 수도 있습니다. 어린 시절부터 균형 잡힌 판단력을 기르는 것이 중요하겠습니다.",
        "(월·일·시 신살도 같은 밀도로 이어가세요. 이제 귀인에 대해서 알아볼까요? 이후 귀인 있는 기둥만 장문으로 풀고, 종합으로 네 시기를 묶어 마무리하세요.)",
      ].join("\n");
    case 7:
      return [
        "## 7장 기준 원고/스타일",
        "- 소제목 순서 고정. 문단 안 줄바꿈 금지. 일간 음양오행·신살·귀인은 계산 데이터와 일치. 아래는 밀도·구조만 참고(양금 등은 본인 일간으로 교체).",
        "",
        "연애운 풀이",
        `${input.name}님의 연애운은 감정의 깊이와 관계의 속도 조절을 함께 봐야 하는 흐름입니다. 감정이 생겼을 때 빠르게 확신을 만들기보다, 상대와의 대화 빈도·약속 이행·갈등 해결 방식이 안정적인지 시간을 두고 확인할수록 만족도가 높아질 가능성이 큽니다.`,
        "",
        "일간 성격과 연애 성향",
        "일간이 양금(陽金)으로 강인하고 냉철한 성격을 가졌습니다. 겉으로는 이성적인 모습이 두드러지지만, 내면적으로는 신뢰를 중요시하며 안정적인 관계를 선호합니다. 사랑에 있어서는 확실한 기준을 두며 쉽게 마음을 열지 않지만, 자신의 기준에 부합하는 상대를 만나면 진지하고 헌신적인 모습으로 관계를 이어가는 편입니다.",
        "",
        "연애 시기와 방법",
        "언제: 청년기와 중년기에 좋은 연애운을 가질 가능성이 큽니다. 특히 중년기에는 운이 상승해 안정적인 사랑을 기대할 수 있습니다.",
        "어디서: 일에 열중하면서 혹은 사회적인 모임을 통해 인연을 만날 가능성이 높습니다.",
        "누구와: 지적이고 현실적인 감각을 가진 사람과 잘 맞습니다. 나의 가치관과 비슷한 실리적 성향의 상대가 이상적입니다.",
        "어떻게: 신중하고도 책임감 있는 태도로 다가가는 것이 중요합니다. 상대방에게 나의 진심을 조금 더 열어 보인다면 더 깊은 관계로 발전할 수 있습니다.",
        "",
        "살과 귀인의 영향",
        "초년: 년살(인간관계·인연이 활발해지는 흐름)이 작용하며, 감정의 기복이 잦아지기 쉬운 시기입니다. 깊이 빠지기보다 상대를 여러 면에서 천천히 살펴보는 리듬이 도움이 됩니다.\n청년: 역마살(이동·변화·활동이 많아지는 흐름)의 영향으로 만남의 환경이 자주 바뀔 수 있습니다. 다양한 만남을 경험하며 나에게 맞는 상대가 무엇인지 좁혀갈 수 있는 시기입니다.\n중년: 육해살(가까운 관계에서 갈등·오해가 생기기 쉬운 흐름)로 인해 관계의 감정선을 세심하게 관리하는 것이 중요합니다. 상대의 표현 방식을 오해하지 않도록 직접 확인하는 대화가 도움이 됩니다.\n말년: 화개살(내면 집중·정리의 흐름)과 함께 내면 성숙이 깊어지는 시기입니다. 화려한 연애보다 신뢰와 안정을 바탕으로 한 관계가 더 오래 지속될 수 있습니다.",
        "(이하 성공적인 연애~종합분석도 같은 밀도로 이어가세요.)",
      ].join("\n");
    case 8:
      return [
        "## 8장 기준 원고/스타일",
        "- 소제목 순서 고정. 문단 안 줄바꿈 금지. 간지·십성·십이운성·신살·귀인은 계산 데이터와 일치. 아래 경금·계유 등은 예시.",
        "",
        "재물운 풀이",
        `${input.name}님의 재물운은 한 번의 기회보다 관리 습관과 선택의 속도에서 차이가 벌어질 가능성이 있습니다. 큰 수입이 들어오는 순간보다, 그 수입을 지키고 다시 불릴 구조를 얼마나 일찍 만들었는지가 장기 성과를 좌우할 수 있습니다.`,
        "",
        "일간 성격과 재물운",
        "나의 일간은 경금으로, 단단하고 강한 금의 기운을 가지고 있습니다. 이는 의지가 강하고 목표를 명확하게 설정하며 이를 이루기 위한 끈기와 노력을 나타냅니다. 재물운과 관련해서는 탐구심과 실리적인 판단으로 안정적인 재물 축적에 유리합니다. 금은 재물과 깊은 상관이 있는 오행으로, 적절한 계획과 실행을 통해 재물 형성이 가능할 것입니다.",
        "",
        "시간에 따른 재물운의 흐름",
        "초년기 : 초년기를 상징하는 계유는 상관과 겁재가 존재하며, 제왕지에 해당합니다. 이 시기는 재물보다 학습과 자기 계발에 집중하며 자신의 능력을 발전시킬 기틀을 마련하는 시기입니다.",
        "(청년·중년·말년도 각각 해당 간지·십성·십이운성·신살을 넣어 같은 밀도로 이어가세요.)",
        "",
        "살과 귀인의 영향",
        "역마살과 육해살, 화개살이 각각의 시기에 영향을 미칩니다. 귀인으로는 청년기의 문창귀인의 지원과 말년기의 천을귀인이 특히 재물 축적에 중요한 조언을 제공할 수 있습니다.",
        "(이하 재물 크게 들어오는 시기~종합분석도 샘플 밀도로 마무리하세요.)",
      ].join("\n");
    case 9:
      return [
        "## 9장 기준 원고/스타일",
        "- 소제목 순서 고정. 문단 안 줄바꿈 금지. 일간·월간·월지·일지·시지 십성·신살·귀인은 계산 데이터와 일치. 아래 경금·식신·겁재 등은 예시이며 본인 사주로 반드시 교체.",
        "",
        "직업운 풀이",
        `${input.name}님의 직업운은 재능을 어디에 쓰느냐와 함께, 조직과 사업 맥락에서 역할을 어떻게 유지하느냐에서 결과가 갈릴 수 있습니다.`,
        "",
        "나의 일간 성격에 맞는 직업, 직무",
        "나의 일간은 경금으로, 경금은 단단하고 강인한 에너지를 지닌 금속을 상징합니다. 이성적이고 논리적이며 체계적인 사고와 분석력을 갖추고 있어 세부적인 부분까지 철저히 검토하는 성향을 보입니다. 이러한 특성은 법률, 공학, 금융, 정보기술, 건축 및 관리와 같이 논리적 사고와 체계적인 접근이 필요한 직종에서 두각을 나타낼 수 있습니다. 또한 경금은 정의와 규칙을 중시하므로 공공기관, 연구 분야, 행정 및 지도력 요구 직무에서도 두드러진 활약이 기대됩니다.",
        "",
        "나의 직장운",
        "나의 사주에서 월간과 월지가 청년기 직장운을 나타냅니다. 월지가 '식신'인데, 이는 노력과 성실함을 통해 직장에서 인정받는 운을 가지고 있음을 나타냅니다. 현재 속한 직장에서 내가 창의성을 발휘하고, 차분한 업무 태도를 유지하며, 자수성가하는 능력을 보일 가능성이 큽니다. 하지만 '겁재'가 월간에 있기 때문에 경쟁 구도가 강할 수 있습니다. 주변 동료나 파트너와 의견 충돌이나 갈등이 있을 수 있으니 이점을 유의해야 합니다. 좋은 인간관계를 쌓고 협력적인 태도를 유지하면, 안정적으로 성장할 수 있는 직장운을 가진 상황입니다.",
        "",
        "나의 사업운",
        "사업운은 일지와 시지에서 확인할 수 있습니다. 나의 일지에는 '비견', 시지에는 '정인'이 자리하고 있습니다. '비견'은 독립적 성향을 이해해야 함을 알려줍니다. 나와 뜻이 맞는 동업자나 파트너를 만날 가능성이 낮을 수 있으므로, 홀로 계획하고 실행하는 것이 더 적합할 수 있습니다. 하지만 '정인'의 에너지가 함께 있기에 사업 영역에서 지혜롭고 신중하게 전략을 세운다면, 큰 결실을 맺을 수 있습니다. 다만 지나치게 완고하거나 혼자 모든 걸 책임지려는 태도는 피하는 것이 좋습니다. 긴밀한 협력 관계가 필요한 시기에는 적극적으로 전문가의 도움을 구하는 것도 현명한 선택입니다.",
        "",
        "십이신살과 귀인의 영향",
        "십이신살에서는 '역마살', '육해살', '화개살'이 두드러집니다. '역마살'은 변화와 이동을 의미하는데, 활동적으로 움직이는 직업이나 여행, 대외활동이 중요한 분야에서 유리하게 작용할 수 있습니다. '육해살'은 대인관계에서 작은 마찰이 있을 수 있음을 나타냅니다. 하지만 이를 통해 인간적으로 많은 것을 배우며 깊이를 더하게 됩니다. '화개살'은 내면의 감성과 창의성을 드러내는 살로, 예술, 종교적 접근, 혹은 연구와 같은 내면이 풍부한 일에 유리하게 작용합니다. 귀인으로는 '문창귀인'과 '천을귀인'이 있습니다. '문창귀인'은 지혜와 학문적 도움을 상징하며, 나의 의견과 창의력이 빛을 발할 때 주변에서 칭송과 지원을 받을 수 있음을 보여줍니다. '천을귀인'은 위기 상황에서 돕는 조력자가 나타나는 좋은 기운이니, 어려운 시기를 긍정적으로 극복할 수 있습니다.",
        "",
        "성공적인 직장생활을 위한 조언",
        "경금의 성향으로 인해 업무 처리에서 너무 강직하거나 완벽주의적 태도를 보일 수 있습니다. 이는 주변 동료들에게 부담으로 작용할 가능성이 있으니, 유연성을 기르는 것이 중요합니다. 또한 월간의 '겁재'는 경쟁 분위기를 형성하기 쉽지만, 갈등을 부드럽게 풀어가는 스킬을 기르면 더 큰 신뢰와 존경을 얻을 수 있습니다. '정인'의 안정 에너지를 바탕으로 상사나 선배와 조화로운 관계를 쌓는다면, 장기적으로 직장에서 중요한 역할을 담당하게 될 것입니다.",
        "",
        "종합분석",
        "나의 사주는 경금의 특성을 통해 이성적이고 논리적인 분야에서 두각을 나타낼 가능성을 보여줍니다. 직장에서는 경쟁에 휘말릴 수 있으나, 이를 극복하고 안정적인 경로를 찾을 수 있는 운을 가졌습니다. 사업에서는 독립적 성향이 강하지만 '정인'의 영향 덕분에 신중한 기획과 전략으로 성공적인 결과를 도출할 가능성이 높습니다. 십이신살과 귀인의 조화로 인해 이동과 변화를 활용하며 귀중한 기회와 도움을 받을 수 있는 운이 형성돼 있습니다. 결국, 직장이나 사업에서 꾸준한 노력과 열린 마음의 태도를 유지하면 안정적이고 성공적인 삶을 만들어 갈 수 있는 운명을 타고났습니다.",
      ].join("\n");
    case 10:
      return [
        "## 10장 기준 원고/스타일",
        "- 소제목 순서 고정. 문단 안 줄바꿈 금지. 음양·오행 수치·십이운성·신살·귀인은 계산 데이터와 일치. 아래 수·금·제왕·병 등은 예시이며 본인 사주로 반드시 교체. 의학 진단 표현은 쓰지 말고 생활·예방 관점만.",
        "",
        "건강운 풀이",
        `${input.name}님의 건강운은 피로가 쌓이는 방식과 회복 리듬이 어떻게 무너지는지를 함께 보는 편이 더 정확합니다.`,
        "",
        "나의 건강운",
        "나의 사주는 음의 기운이 강하며, 특히 수(水)와 금(金)의 기운이 두드러집니다. 이러한 기운은 신장과 방광, 폐와 관련 있는 건강 문제를 유발할 가능성이 있으며, 대체로 차가운 기운과의 균형을 맞추는 것이 중요합니다. 또한, 상관과 겁재의 기운이 강하므로 감정 기복으로 인해 오는 스트레스나 신경성 질환에 유의해야 합니다. 정관과 정인이 함께 있어 신체적으로 체력이 약해질 때 자연스럽게 회복하려는 힘이 존재하지만, 기본적으로는 건강 관리에 세심한 노력이 필요합니다.",
        "",
        "십이신살과 귀인의 영향",
        "십이신살 중 역마살, 육해살, 화개살이 나타나는데 이는 건강운에서 변화와 불안정성을 가져올 수 있음을 의미합니다. 역마살은 많이 움직이고 활동량이 많을 시기에 과로로 인해 건강에 영향을 받을 수 있음을 나타냅니다. 육해살은 관계적 스트레스나 정신적인 압박에서 오는 건강 문제에 유의해야 함을 암시합니다. 화개살의 경우 마음이 예민해지고 생각이 많아질 수 있어 스트레스로 인한 간접적 건강 문제가 나타날 수 있습니다. 귀인으로는 천을귀인이 있어 어려운 상태에서도 회복력이 발휘될 가능성이 크며, 도움을 주거나 인도해 줄 인연을 통해 건강을 회복하는 기회를 얻을 수 있습니다.",
        "",
        "시기에 따른 나의 건강운",
        "초년기 : 초년에는 제왕의 기운 덕분에 신체적으로 강인하며 활발한 활동이 가능할 것입니다. 다만 처음에는 과도한 에너지 소모로 인해 피로 누적에 주의해야 합니다. 신장이나 방광과 같은 수(水)와 관련된 질환에 취약할 가능성이 높으니, 따뜻한 환경을 만들어야 합니다.",
        "청년기 : 청년기에는 병(病)의 기운이 있어 건강 면에서 불안정할 수 있습니다. 특히 이 시기에는 스트레스로 인해 폐와 신경계 건강이 악화될 수 있으니, 과도한 작업이나 책임을 피하고 적절히 휴식을 취해야 합니다.",
        "중년기 : 중년기에는 상관의 기운이 더욱 두드러지며, 의욕이 강한 동시에 체력이 약해질 가능성이 있습니다. 이 시기에는 심신의 균형을 맞추는 활동이 필요하며, 금(金)의 과도한 기운으로 인해 폐질환이나 피부 질환에 주의해야 합니다.",
        "말년기 : 말년에는 묘(墓)의 기운이 작용해 에너지가 축소되고 신체적으로 약화될 수 있습니다. 특히 소화기 계통과 관련된 질병에 유의해야 하며, 이 시기에는 정서적 안정과 소화기의 건강 관리가 중요합니다.",
        "",
        "주의해야 할 질병",
        "폐질환 : 금(金)의 기운이 강하게 작용함에 따라 폐와 관련된 건강 문제가 생길 가능성이 있습니다. 환절기와 건조한 환경에 특히 주의를 기울여야 합니다.",
        "신경계 질환 : 상관과 겁재의 기운으로 인해 스트레스를 받았을 때 신경계 질환이나 정서적 문제가 발생할 수 있습니다. 불면증이나 우울증과 같은 증세에 주의가 필요합니다.",
        "소화기 계통 : 말년에는 시주의 음토(陰土)로 인해 소화기 약화가 우려됩니다. 소화 기능 관리와 식습관 조정이 필요합니다.",
        "",
        "추천 운동",
        "유산소 운동을 중심으로, 조깅이나 걷기와 같이 몸을 순환시키는 활동을 권장합니다. 특히 폐와 신경계를 강화하기 위한 요가나 명상도 좋은 선택입니다. 중년기 이후로는 근력 운동과 함께 무리하지 않는 범위에서의 스트레칭도 신체 안정에 도움을 줄 것입니다.",
        "",
        "추천 식단",
        "차고 건조한 특성을 상쇄하기 위해 따뜻하고 수분감 있는 음식이 적합합니다. 미역, 다시마 같은 해조류와 대추, 생강을 활용한 차가 몸을 따뜻하게 하고 면역력 강화에 좋습니다. 과일로는 사과, 귤처럼 비타민 C가 풍부한 것을 추천하며, 말년에는 소화가 쉬운 죽이나 부드러운 음식 위주로 섭취하는 것이 좋습니다.",
        "",
        "종합분석",
        "나의 건강운은 수와 금의 기운이 강하게 작용하면서 신체적으로는 폐와 신경계, 정신적인 부분과 관련된 문제가 주로 나타날 가능성이 높습니다. 특히 스트레스 관리와 균형 잡힌 생활습관이 건강 유지의 핵심이 됩니다. 귀인의 도움으로 회복의 기회가 존재하지만, 먼저 적절한 건강 관리와 예방에 주력해야 합니다. 꾸준한 운동과 더불어 따뜻하며 부담 없는 식단을 생활화하는 것이 가장 중요한 관리 방법입니다.",
      ].join("\n");
    case 11:
      return [
        "## 11장 기준 원고/스타일",
        "- 소제목 '나의 N세 대운' 아래 본문은 문단 안 줄바꿈 금지. 천간·지지·십성·십이운성은 계산 데이터와 일치. 아래 임수·경금·술토·식신·편인·쇠 등은 예시이며 본인 대운으로 반드시 교체.",
        "",
        "나의 22세 대운",
        "이번 대운의 천간은 임(壬), 지지는 술(戌)입니다.",
        "임수(壬水)는 장원종님의 경금(庚金)과 상생 관계에 있습니다. 금이 수를 생한다는 의미는 경금이라는 강한 금속이 임수라는 큰 물을 만들어낸다고 볼 수 있습니다. 이는 장원종님이 이 시기에 자신의 능력과 역량을 발휘해 무언가를 이루는 데 유리한 흐름을 나타냅니다. 특히 학업, 자기 계발, 창의적인 활동에서 좋은 성과를 기대할 수 있는 시기입니다. 다만, 상생이 지나치게 강하게 작용할 경우 에너지가 소진될 수 있으므로 무리하지 않는 것이 중요합니다.",
        "술토(戌土)는 경금(庚金)과 상생 관계에 있습니다. 토가 금을 생해주는 흐름이므로, 재물적으로 안정감을 얻을 수 있는 시기입니다. 술토는 양토로서 보다 활동적이며, 현실적인 기반을 다지는 기운이 강합니다. 이로 인해 장원종님은 사업이나 재정적인 면에서 성과를 준비하고 이를 통해 안정적인 환경을 만들어갈 수 있을 것입니다. 다만, 과도한 욕심을 부리거나 계획 없이 무리한 확장을 시도한다면 안정감이 흔들릴 가능성도 있습니다.",
        "천간의 십성은 식신(食神)입니다. 식신은 자신의 역량을 활용해 새로운 것을 창출하거나 나누는 에너지를 뜻합니다. 이 시기는 장원종님이 자신의 재능을 발휘해 사람들에게 인정을 받는 흐름이 강할 것입니다. 식신은 여유롭고 부드러운 성격을 나타내기 때문에, 이 시기에 지나치게 경쟁적인 자세보다는 여유를 가지고 타인과의 소통을 중요시하는 것이 좋습니다. 이러한 기운은 연애와 인간관계에서도 긍정적인 영향을 미칠 가능성이 큽니다.",
        "지지의 십성은 편인(偏印)입니다. 편인은 직관적이고 창의적인 에너지를 나타내는 십성으로, 이 시기에 학업이나 자기 계발에 깊이 몰두할 수 있는 운을 가지고 있습니다. 특히 기존의 틀에서 벗어나 새로운 방식을 고민하거나, 평소와 다른 관점에서 문제를 해결하는 능력이 강화될 것입니다. 다만, 편인은 때로는 지나친 고민이나 의심으로 인해 에너지가 소모될 수 있으니 스스로 균형을 잘 맞추는 것이 필요합니다.",
        "십이운성은 쇠(衰)입니다. 쇠운은 에너지가 다소 약해진 상태를 나타내지만, 이는 새로운 시작을 준비하는 시간으로 활용할 수 있습니다. 장원종님은 이 시기에 너무 성급하게 무언가를 추진하기보다는, 현재의 상황을 점검하고 앞으로의 발전을 위한 계획을 세우는 것이 적합합니다. 건강 면에서도 무리하지 않고 규칙적인 생활을 유지하는 것이 중요하며, 과로를 최대한 피해야 하는 시기입니다.",
        "정리보면, 이번 대운은 장원종님이 자신의 능력과 재능을 활용해 안정적인 기반을 다질 수 있는 시기입니다. 재물과 사업적으로 좋은 기운이 흐르며, 학업이나 자기 계발에서도 긍정적인 성과를 기대할 수 있을 것입니다. 다만, 에너지가 지나치게 분산되지 않도록 조절하며, 계획적이고 균형 있는 태도를 유지하는 것이 중요합니다. 연애와 인간관계에서는 식신의 긍정적인 기운이 강하므로 사람들과의 관계를 따뜻하게 유지한다면 만족스러운 결과를 얻을 가능성이 크겠습니다.",
        "- 실제 작성 시 이름·간지·십성·십이운성은 전부 본인 데이터로 바꾸고, 10개 대운을 동일 밀도로 반복하세요.",
      ].join("\n");
    case 12:
      return [
        "## 12장 기준 원고/스타일",
        "- 소제목 '나의 N년 연운 : …' 아래 본문은 문단 안 줄바꿈 금지. 연도·간지·십성·십이운성은 계산 데이터와 일치. 아래 병화·경금·오화·편관·정관·목욕 등은 예시이며 본인 연운으로 반드시 교체.",
        "",
        "나의 2026년 연운",
        "나의 2026년 연운 : 천간 병",
        "2026년 연운의 천간은 병화입니다. 병화는 태양과 같은 불의 에너지를 의미하며, 경금에게는 따스한 빛으로 자신의 본연의 빛을 반사하도록 돕는 작용을 합니다. 경금은 본래 단단하고 차가운 성질을 지녔지만, 병화가 들어옴으로써 그 차가움을 녹이고 온화함을 더해주는 시기로 볼 수 있습니다. 이 시기 장원종님은 자신의 능력과 역할을 보다 분명히 드러내며 외부로 활발히 발산하려는 욕구가 강해질 수 있습니다.",
        "또한 병화는 장원종님에게 편관으로 작용하기 때문에 책임감과 도전의식이 자연스레 강화됩니다. 사회적 위치나 업무에서 새로운 책임이 주어질 가능성이 높아지고, 이를 통해 자신의 가치를 더 높일 기회를 가질 수 있을 것으로 예상됩니다. 여기에 따르는 부담이 없지는 않지만, 이를 성실히 감당해 나간다면 더욱 견고한 발전을 이루는 기반이 마련될 것으로 보입니다. 병화 천간은 장원종님에게 에너지를 부여하면서 동시에 성장의 기회를 함께 가져다주는 의미로 다가올 수 있습니다.",
        "나의 2026년 연운 : 지지 오",
        "2026년 연운의 지지는 오화입니다. 오화는 한여름의 뜨거운 태양과 같아 생동감 넘치고 활발한 에너지를 뜻합니다. 이러한 기운은 장원종님에게 외부 활동이나 사회적 관계를 넓히고 적극적으로 자기 표현을 할 수 있는 환경을 만들어줍니다.",
        "오화는 또한 열정과 의욕을 상징하며, 장원종님의 내면의 동기를 더욱 강렬하게 자극할 가능성이 있습니다. 새로운 도전을 시작하거나 남들 앞에서 두각을 나타낼 수 있으니 이 시기에 용기 있는 행동으로 기회를 잡는 것이 중요합니다. 다만, 과한 열정이 오히려 주변과의 갈등으로 이어질 수 있으므로 균형감 있는 태도가 필요합니다.",
        "나의 2026년 연운 : 천간 십성 편관",
        "편관은 경금 일간에게 외부에서의 도전과 경쟁, 스스로를 단련시키는 기회를 의미합니다. 2026년에는 장원종님에게 책임감을 요구하는 상황이 주어지거나 목표를 성취하기 위해 자기 자신과의 싸움을 해야 하는 순간들이 많아질 가능성이 큽니다. 이 시기는 외부 환경이 더 강렬하게 느껴질 수 있지만, 이를 통해 내적인 성장을 이루는 중요한 시기로 이해할 수 있습니다.",
        "편관은 또한 자제력과 균형 있는 결정을 요구하는 성격을 가지고 있습니다. 성급함으로 인해 실수를 반복하기보다는 차분히 계획을 세우고, 자신의 행동을 되돌아보는 태도가 필요합니다. 장원종님은 이 시기에 형성되는 자신의 태도와 행동이 이후에 더 큰 발전의 초석이 될 것을 염두에 두는 것이 중요합니다.",
        "나의 2026년 연운 : 지지 십성 정관",
        "지지 午(오)에서는 일간에게 정관(正官)이 작용합니다. 정관은 규칙과 질서를 따르고 안정과 책임감을 의미합니다. 2026년 장원종님은 주변 환경 속에서 자신의 역할을 명확히 하고, 책임감을 키우는 해가 될 가능성이 높습니다. 이 시기에는 자신의 상태를 철저히 관리하며 신뢰를 기반으로 사람들과의 관계를 쌓아가는 모습이 나타날 수 있습니다.",
        "정관은 또한 체계적인 노력과 계획 속에서 결과를 만들어가는 과정을 뜻하기 때문에, 2026년 장원종님은 일의 흐름을 예측하며 한 걸음씩 나아가는 안정적인 모습을 보였을 가능성이 큽니다. 다만 지나치게 틀에 얽매이려고 한다면 답답함을 느낄 수 있으니 융통성을 갖추는 것이 중요합니다. 결국 이 시기의 정관은 장원종님이 자신의 한계를 명확히 알고 이를 극복하기 위한 과정으로 작용했다고 볼 수 있습니다.",
        "나의 2026년 연운 : 십이운성 목욕",
        "2026년 연운의 십이운성은 목욕으로 나타납니다. 목욕은 새로운 단계로 나아가기 위한 정화와 준비 과정을 상징합니다. 이는 장원종님께서 이전과는 다른 변화를 체감하며 다소 민감한 시기를 경험하게 될 가능성을 의미합니다.",
        "목욕 단계는 외부 상황에 대한 영향을 더 크게 받을 수 있는 시기이기도 합니다. 이 시기에는 타인과의 관계나 주위 환경에서 오는 변동성이 장원종님의 삶에 큰 영향을 미칠 수 있었을 것입니다. 이는 정신적, 감정적으로도 변화에 대한 민감함을 느낄 가능성을 보여줍니다.",
        "목욕의 기운은 새롭게 출발하기 전의 중요한 정리와 정화의 의미를 가지고 있습니다. 따라서 2026년은 장원종님에게 있어 새로운 시작을 준비하며 복잡한 상황을 정리하고 조율하는 시간이 되었을 것으로 보입니다.",
        "나의 2026년 연운 종합",
        "2026년 연운은 장원종님에게 활동성과 경쟁이 중심이 되는 해가 될 가능성이 높습니다. 병화 천간과 오화 지지가 나타나면서, 외부적으로는 역동적인 상황과 사람들과의 교류가 많아질 수 있습니다. 특히 편관과 정관이 함께 작용하게 되어 책임감과 규칙을 중요시하게 되는 경향이 형성될 것으로 예상됩니다.",
        "십이운성이 목욕으로 나타나는 것은 장원종님이 외적인 활동과 표현을 통해 자신을 더욱 드러내는 시기임을 의미합니다. 다만 목욕이라는 측면에서는 다소 우유부단하거나 감정적인 부분이 확대될 가능성도 있습니다. 따라서 중요한 선택의 순간에는 지나치게 감정에 휘둘리지 않도록 신중함을 유지하는 것이 필요할 것입니다.",
        "- 실제 작성 시 이름·연도·간지·십성·십이운성은 전부 본인 데이터로 바꾸고, 6개 연도를 동일 밀도로 반복하세요. 지지 십성 문단에서 다른 지지 이름(예: 자수)을 쓰지 말고 반드시 그 해 연지를 쓰세요.",
      ].join("\n");
    default:
      return "";
  }
}

function buildSectionGuardSuffix(input: LlmGenerateInput, sectionNumber: number): string {
  switch (sectionNumber) {
    case 2:
      return `\n\n${input.name}님은 이 장에서는 오행의 숫자와 음양 비율을 함께 보고, 평소 컨디션과 맞춰 해석해 보시면 적용이 쉬워집니다. 한 번에 모두 바꾸기보다 수면·활동·대화 리듬 중 한 가지만 먼저 조절해 보시는 것도 좋습니다.`;
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
      return `\n\n${input.name}님은 12장을 읽을 때 연도마다 '나의 N년 연운 종합'까지를 한 묶음으로 보고, 다음 해와 비교하면 선택의 우선순위가 더 선명해질 수 있습니다. 감정과 기준이 겹칠 때는 잠시 기록으로 정리한 뒤 움직이는 편이 안정적입니다.`;
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
    case 2:
      return `${input.name}님은 음양오행을 읽을 때 숫자만 보지 말고, 강한 기운은 어디에 쓰이기 쉬운지·부족한 기운은 무엇을 보완하면 좋은지까지 생활 장면과 연결해 보시면 좋습니다.`;
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
  // 일주 정보로 맥락을 개인화
  const ext = computeSajuExtended(input.saju.fourPillarsKorean);
  const day = ext?.pillars[1];
  const stemEl = day?.stemElement ?? "";
  const branchEl = day?.branchElement ?? "";
  const elAction: Record<string, string> = {
    목: "시작과 확장 쪽으로 에너지가 쏠리기 쉬운",
    화: "표현과 추진력이 강하게 올라오기 쉬운",
    토: "안정과 신중함을 우선하려는",
    금: "기준과 완성도를 먼저 따지는",
    수: "깊이 있게 생각하고 유연하게 흐르는",
  };
  const elRisk: Record<string, string> = {
    목: "시작이 빠른 만큼 끝맺음 기준을 명확히 두는 것이 중요합니다.",
    화: "과열되면 소모가 커지므로 하루에 회복 시간을 반드시 확보하세요.",
    토: "결정을 미루는 패턴이 나오기 쉬우니, 선택 마감 시점을 미리 정해두면 좋습니다.",
    금: "높은 기준이 관계에서 냉정하게 비칠 수 있어, 피드백은 사실 위주로 전달해보세요.",
    수: "생각이 너무 깊어지면 결론이 늦어지므로, 옵션 2개로 줄이고 선택하는 연습이 효과적입니다.",
  };
  const elRelation: Record<string, string> = {
    목: "가까운 관계에서 성장·확장을 자극하는 역할이 잘 맞는 편입니다.",
    화: "감정 표현이 적극적인 만큼, 상대의 페이스를 맞추는 여유가 관계를 부드럽게 합니다.",
    토: "안정과 일관성을 중요하게 여기는 만큼, 상대방도 그 부분을 느낄 수 있게 작은 약속부터 지켜보세요.",
    금: "관계에서 기준이 명확한 것은 장점이지만, 가끔은 기준을 완화하고 상대 방식도 인정해주면 관계가 넓어집니다.",
    수: "공감과 경청이 강점으로 작용하며, 상대가 먼저 말을 꺼낼 수 있는 공간을 만들어주면 좋은 관계가 이어집니다.",
  };

  const stemAction = elAction[stemEl] ?? "자신만의 리듬으로 움직이는";
  const stemRisk = elRisk[stemEl] ?? "강점이 과해지는 순간을 알아차리고 속도를 조절하는 것이 중요합니다.";
  const branchRelation = elRelation[branchEl] ?? "가까운 관계에서 자신의 에너지를 잘 활용할 수 있습니다.";

  if (sectionNumber === 2) {
    const lines = [
      `${input.name}님은 ${stemAction} 에너지가 기본으로 깔려 있습니다. 오행 구성에서 강한 부분은 역할과 추진에, 상대적으로 약한 부분은 회복과 정리에 쓰일 때 균형이 잡히기 쉽습니다.`,
      `${input.name}님은 이 장의 내용을 읽을 때, 지금 가장 체감이 강한 패턴 하나를 골라 일상에서 작은 행동으로 먼저 검증해보시면 좋습니다. ${stemRisk}`,
    ];
    return lines[round % lines.length];
  }

  const categoryHint =
    sectionNumber === 7 ? "관계 운영 방식" :
      sectionNumber === 8 ? "재정 관리 구조" :
        sectionNumber === 9 ? "직무/역할 운영 방식" :
          sectionNumber === 10 ? "회복 루틴과 생활 리듬" :
            sectionNumber === 11 ? "10년 단위 전략 전환" :
              sectionNumber === 12 ? "연도별 선택 우선순위" :
                `${sectionTitle}의 핵심 흐름`;

  const variants = [
    `${input.name}님은 ${stemAction} 흐름 위에서 ${categoryHint}을 살펴보시면 적용력이 높아집니다. ${stemRisk}`,
    `${input.name}님은 ${sectionTitle}의 내용을 단정적으로 받아들이기보다, 생활 장면에서 하나씩 대입해가며 조정하는 방식이 잘 맞습니다. ${branchRelation}`,
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

function buildTailPrompt(
  input: LlmGenerateInput,
  sectionExcerpts?: Array<{ title: string; excerpt: string }>,
): string {
  const chapterContext = sectionExcerpts && sectionExcerpts.length > 0
    ? [
      "",
      "## 각 장 내용 요약 (한 줄 요약 작성 시 참고)",
      ...sectionExcerpts.map((s, i) => `${i + 1}장 ${s.title}: ${s.excerpt}`),
    ]
    : [];

  return [
    buildContextBlock(input),
    ...chapterContext,
    "",
    "## 작업: elementBalance / chapterOneLiners / disclaimer 생성",
    "- elementBalance.analysis(500~900자), elementBalance.tips(5~10개, 각 100~180자).",
    "",
    `- chapterOneLiners: 12개 장 각각에 대해 **${input.name}님의 실제 사주 데이터를 반영한** 개인화 한 줄 요약을 작성하세요.`,
    "  - 각 항목은 25~80자, 12개 정확히.",
    `  - 형식 예시: \"${input.name}님은 금속처럼 날카로운 기준감으로 선택을 내리는 성향이 강합니다.\"`,
    "  - 절대 일반적인 장 설명(\"이 장에서는...\", \"분석해보면...\")이나 단순 나열이 되면 안 됩니다.",
    "  - 이 사람에게만 해당하는 구체적인 특성·흐름·조언을 담으세요.",
    "  - 상기 '각 장 내용 요약'을 최대한 참고해 그 사람의 실제 데이터에서 나온 말을 쓰세요.",
    "",
    "- JSON만 출력하세요.",
    "",
    "## JSON 스키마",
    "{",
    '  "elementBalance": {',
    '    "analysis": "string",',
    '    "tips": ["string"]',
    "  },",
    '  "chapterOneLiners": ["string", "string", "string", "string", "string", "string", "string", "string", "string", "string", "string", "string"],',
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

function buildFallbackTail(input: LlmGenerateInput): ReportTailPart {
  const ext = computeSajuExtended(input.saju.fourPillarsKorean);
  const seed = stableHash(
    `${input.name}|tail|${input.gender ?? ""}|${input.birth.year}-${input.birth.month}-${input.birth.day} ${input.birth.hour}:${input.birth.minute}|${input.saju.fourPillarsKorean.day}`,
  );

  const baseAnalysisVariants = [
    "오행의 편중이 강할수록 어떤 때는 속도가 붙지만, 반대로 흐름이 꺾일 때는 피로와 시행착오가 늘 수 있습니다. 그래서 루틴(수면·식사·운동)을 먼저 고정하면 운의 흔들림을 덜 거칠게 탈 수 있어요.",
    "오행은 ‘에너지 배분’처럼 작동해서, 강한 기운은 강점이 되지만 과하면 부담이 되기 쉽습니다. 일정·수면·운동 같은 기본을 먼저 잡아두면, 좋은 시기엔 성과를 살리고 어려운 시기엔 손실을 줄이기 쉬워집니다.",
    "사주에서 오행 균형은 ‘컨디션과 선택의 리듬’을 좌우하는 축에 가깝습니다. 강한 기운을 잘 쓰되 과열·정체가 오지 않도록, 생활 루틴을 먼저 만들어두는 것이 가장 현실적인 안전장치입니다.",
  ] as const;

  const pick = <T,>(arr: readonly T[], idx: number) => arr[idx % arr.length];

  const tips: string[] = [];
  const pushUnique = (s: string) => {
    const t = s.trim();
    if (!t) return;
    if (tips.includes(t)) return;
    tips.push(t);
  };

  // 1) 공통 루틴 팁 (문장 변형)
  const routineTipVariants = [
    "주간 단위로 ‘휴식 시간’을 먼저 캘린더에 고정해두면 과로 누적을 크게 줄일 수 있습니다.",
    "바쁜 시기일수록 휴식이 밀리기 쉬우니, 쉬는 시간을 ‘약속’처럼 먼저 잡아두는 편이 안전합니다.",
    "성과가 붙는 구간에는 무리하기 쉬워요. 일정을 짤 때 휴식·수면을 먼저 넣고 나머지를 채워보세요.",
  ] as const;
  pushUnique(pick(routineTipVariants, seed + 1));

  // 2) 음양 편중 팁 (있을 때만 더 구체화)
  if (ext) {
    const yinLead = ext.yinYangPct.yin > ext.yinYangPct.yang;
    const gap = Math.abs(ext.yinYangPct.yin - ext.yinYangPct.yang);
    if (gap >= 20) {
      pushUnique(
        yinLead
          ? `음(陰) 기운이 더 강하게 읽혀(음 ${ext.yinYangPct.yin}%, 양 ${ext.yinYangPct.yang}%), ‘회복·정리’ 리듬이 중요합니다. 중요한 결정을 내릴 때는 하루 정도 텀을 두고 기록으로 정리해보세요.`
          : `양(陽) 기운이 더 강하게 읽혀(양 ${ext.yinYangPct.yang}%, 음 ${ext.yinYangPct.yin}%), ‘속도·발산’이 붙기 쉽습니다. 과열을 막기 위해 회의·운동·외출 뒤에 20~30분 쿨다운 시간을 의도적으로 넣어보세요.`,
      );
    } else {
      pushUnique("감정과 속도가 한쪽으로 쏠릴 때만 조절하면 충분합니다. ‘기록 5분 + 정리 10분’ 같은 짧은 루틴부터 시작해보세요.");
    }

    // 3) 강한 오행 / 약한 오행 기반 팁
    const order = ["목", "화", "토", "금", "수"] as const;
    const sorted = [...order].sort((a, b) => {
      const diff = ext.elementPcts[b] - ext.elementPcts[a];
      return diff !== 0 ? diff : ext.elementCounts[b] - ext.elementCounts[a];
    });
    const strongest = sorted[0];
    const weakest = sorted.at(-1) ?? strongest;

    const strongTipByEl: Record<(typeof order)[number], readonly string[]> = {
      목: [
        "목(木) 기운이 강할수록 계획을 계속 확장하기 쉬워요. 이번 주에 ‘해야 할 일’ 3개만 남기고 나머지는 다음 주로 미루는 연습이 도움이 됩니다.",
        "목(木)이 강하면 아이디어가 늘어나기 쉬우니, 실행은 ‘작게 시작→짧게 검증’으로 속도를 조절해보세요.",
      ],
      화: [
        "화(火) 기운이 강할수록 추진이 빠르지만 말·표현이 강해질 수 있어요. 중요한 대화는 ‘결론→근거 1개→상대 확인’ 순서로 짧게 정리해보세요.",
        "화(火)가 강하면 과열로 피로가 빨리 올 수 있습니다. 카페인·야식 타이밍을 한 단계만 당겨도 회복이 좋아져요.",
      ],
      토: [
        "토(土) 기운이 강하면 책임을 혼자 떠안기 쉬워요. 역할을 ‘내가 할 것/남이 할 것/지금은 안 할 것’으로 나눠 적어보세요.",
        "토(土)가 강할수록 안정이 장점이지만 변화가 늦어질 수 있습니다. 작은 실험(1주) 단위로 바꿔보는 방식이 잘 맞습니다.",
      ],
      금: [
        "금(金) 기운이 강하면 기준이 뚜렷한 대신 완벽주의로 지치기 쉬워요. 결과 기준을 80점으로 두고 ‘마감’을 먼저 정해보세요.",
        "금(金)이 강하면 판단이 날카로워질 수 있으니, 피드백은 ‘사실→영향→요청’ 3단계로 부드럽게 전달해보세요.",
      ],
      수: [
        "수(水) 기운이 강하면 생각이 깊어지는 대신 결정을 미루기 쉬워요. 선택은 ‘옵션 2개만 남기기’로 단순화해보세요.",
        "수(水)가 강하면 컨디션이 환경에 민감할 수 있습니다. 수면 시작 시간을 30분만 고정해도 하루 리듬이 안정되기 쉽습니다.",
      ],
    };

    const weakTipByEl: Record<(typeof order)[number], readonly string[]> = {
      목: [
        "목(木)이 약하면 ‘시작 에너지’가 부족하게 느껴질 수 있어요. 아침에 10분 산책처럼 아주 작은 시동 루틴을 만들어보세요.",
        "목(木)이 약할 때는 확장보다 ‘한 가지를 끝내는 경험’이 중요합니다. 하루 1개 완료 체크를 추천합니다.",
      ],
      화: [
        "화(火)가 약하면 의욕이 들쭉날쭉할 수 있어요. 햇빛·가벼운 유산소처럼 몸을 데우는 루틴을 주 3회만 넣어보세요.",
        "화(火)가 약할 때는 ‘표현’이 약해져 오해가 생기기 쉽습니다. 중요한 내용은 말로 한 번, 메시지로 한 번 정리해두세요.",
      ],
      토: [
        "토(土)가 약하면 안정감이 흔들릴 수 있으니, 일정·가계부·업무 리스트처럼 ‘기본 틀’ 하나만 먼저 고정해보세요.",
        "토(土)가 약할 때는 결정이 흔들릴 수 있습니다. 큰 선택은 ‘기준 3개(돈/시간/관계)’로 점수 매겨보면 도움이 됩니다.",
      ],
      금: [
        "금(金)이 약하면 기준이 흐려져 피로가 쌓일 수 있어요. 거절 문장을 미리 정해두면(예: \"이번 주는 어렵습니다\") 에너지 관리가 쉬워집니다.",
        "금(金)이 약할 때는 마무리가 약해질 수 있습니다. ‘정리 10분’ 타이머로 마감 루틴을 붙여보세요.",
      ],
      수: [
        "수(水)가 약하면 회복이 빨리 떨어질 수 있어요. 물·수분 섭취와 수면 시간을 일정하게 맞추는 것부터 시작해보세요.",
        "수(水)가 약할 때는 감정 정리가 어려울 수 있습니다. 하루 끝에 5줄 기록으로 머리를 비워보는 걸 추천합니다.",
      ],
    };

    pushUnique(pick(strongTipByEl[strongest], seed + 7));
    pushUnique(pick(weakTipByEl[weakest], seed + 13));
  } else {
    // ext가 없을 때도 사람마다 변형되도록 seed 기반으로 선택
    const generic = [
      "수면 시간을 일정하게 유지하면 집중력 저하 구간을 줄이는 데 도움이 됩니다.",
      "카페인·야식·과음 빈도를 조금만 줄여도 회복 속도가 확 달라질 수 있습니다.",
      "몸 신호(피로/소화/근육 긴장)를 초기에 점검하면 작은 문제로 끝날 가능성이 커집니다.",
      "일을 몰아서 하는 날과 회복하는 날을 분리해두면 컨디션이 안정되기 쉽습니다.",
    ] as const;
    pushUnique(pick(generic, seed + 2));
    pushUnique(pick(generic, seed + 5));
    pushUnique(pick(generic, seed + 9));
  }

  const stemEl = ext?.dayStemElement ?? input.saju.dayElement ?? "금";
  const name = input.name;

  const chapterOneLiners: string[] = [
    `${name}님의 사주는 ${stemEl} 기운이 중심을 이루며, 이 리포트는 그 특성을 기반으로 풀어낸 해석입니다.`,
    `${name}님의 사주팔자는 ${input.saju.fourPillarsKorean.year}·${input.saju.fourPillarsKorean.month}·${input.saju.fourPillarsKorean.day}·${input.saju.fourPillarsKorean.hour} 기운으로 구성되어 있습니다.`,
    `${name}님의 성격은 ${stemEl} 에너지 특성에 따라 기준이 명확하고 결단력 있는 면이 두드러집니다.`,
    `십성 분석에서 ${name}님은 환경과 관계에 반응하는 방식이 일관성 있게 나타납니다.`,
    `${name}님의 생애 에너지 흐름은 각 시기마다 강도와 방향이 달라지는 구간이 있습니다.`,
    `${name}님의 사주에서 살과 귀인 흐름은 대인관계와 전환점에 중요한 역할을 합니다.`,
    `${name}님의 연애·결혼운은 감정의 깊이와 속도 조절이 핵심 변수로 작용합니다.`,
    `${name}님의 재물운은 단발성 기회보다 반복 가능한 구조를 만들 때 안정성이 높아집니다.`,
    `${name}님의 직업운은 역할의 지속 가능성과 강점을 어디에 쓰느냐에 따라 성과가 갈립니다.`,
    `${name}님은 ${stemEl} 기운과 연결된 신체 부위와 에너지 리듬에 유의하면 건강관리에 도움이 됩니다.`,
    `${name}님의 대운 흐름은 각 10년 단위로 에너지 색깔이 달라지므로 시기별 전략이 중요합니다.`,
    `${name}님의 6년 연운은 해마다 강조되는 기운이 다르므로, 해별 흐름을 미리 파악해두면 유리합니다.`,
  ];

  return {
    elementBalance: {
      analysis: pick(baseAnalysisVariants, seed),
      tips: tips.slice(0, 4),
    },
    chapterOneLiners,
    disclaimer: "본 문서는 참고용 해석이며, 의학·법률·투자에 대한 확정적 조언이 아닙니다.",
  };
}

function buildFallbackReport(input: LlmGenerateInput): ReportContent {
  const summaryPart = buildFallbackSummary(input);
  const tailPart = buildFallbackTail(input);
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
      const order = ["목", "화", "토", "금", "수"] as const;
      type ElementKey = (typeof order)[number];
      const elementHanja: Record<ElementKey, string> = { 목: "木", 화: "火", 토: "土", 금: "金", 수: "水" };
      const elementKor: Record<ElementKey, string> = { 목: "나무", 화: "불", 토: "흙", 금: "금", 수: "물" };
      const compositionText = (() => {
        if (!ext) {
          return `${input.name}님의 오행 분포는 일상에서 어떤 기운이 강하고 약한지 확인하는 기준이 됩니다.`;
        }
        const sorted = [...order].sort((a, b) => {
          const diff = ext.elementPcts[b] - ext.elementPcts[a];
          return diff !== 0 ? diff : ext.elementCounts[b] - ext.elementCounts[a];
        });
        const strongest = sorted[0];
        const weakest = [...sorted].reverse()[0];
        const weakestZero = ext.elementCounts[weakest] === 0;
        const weakestNote = weakestZero
          ? `${elementKor[weakest]}(${weakest}${elementHanja[weakest]})의 부재에 가까운 분포라 추진력·전환력·회복력 중 일부가 체감상 부족하게 느껴질 수 있습니다.`
          : `${elementKor[weakest]}(${weakest}${elementHanja[weakest]}) 비중이 낮아 특정 상황에서 균형이 한쪽으로 기울 수 있으니 생활 루틴으로 보완하는 전략이 필요합니다.`;
        return `${input.name}님의 오행분포는 목(木) ${ext.elementPcts.목}% - ${ext.elementCounts.목}개, 화(火) ${ext.elementPcts.화}% - ${ext.elementCounts.화}개, 토(土) ${ext.elementPcts.토}% - ${ext.elementCounts.토}개, 금(金) ${ext.elementPcts.금}% - ${ext.elementCounts.금}개, 수(水) ${ext.elementPcts.수}% - ${ext.elementCounts.수}개입니다. 음양오행(陰陽五行)의 관점에서 볼 때 ${elementKor[strongest]}(${strongest}${elementHanja[strongest]}) 기운이 가장 강하게 작용하며, 이는 ${input.name}님의 기본 성향과 의사결정 패턴에 크게 영향을 줄 가능성이 있습니다. 반면 ${weakestNote} 또한 상생(相生)과 상극(相克)의 관점에서 강한 기운만 키우기보다 약한 기운이 기능하도록 생활 환경을 조절하는 것이 중요합니다. 예를 들어 일정 운영, 수면·활동 리듬, 대인관계 속도 조절을 통해 기운의 과열과 정체를 완화하면 전체 흐름의 안정감이 더 높아질 수 있습니다.`;
      })();
      body = [
        `${input.name}님, 먼저 음양은 모든 존재와 현상이 서로 다른 두 성질 사이의 균형으로 움직인다는 원리입니다. 음은 안으로 모으고 가라앉히는 힘, 양은 밖으로 드러내고 확장시키는 힘으로 이해하시면 좋아요.`,
        "오행은 목화토금수의 다섯 기운으로, 사람의 성향과 반응 패턴을 보다 구체적으로 읽기 위한 기준입니다. 중요한 것은 어느 하나가 무조건 좋거나 나쁘다는 것이 아니라, 어떤 기운이 강하고 어떤 기운이 비어 있는지에 따라 생활 방식이 달라진다는 점입니다.",
        "또한 오행은 상생과 상극의 원리로 이어집니다. 서로 도와 성장을 만드는 흐름도 있고, 과한 치우침을 제어하는 흐름도 있기 때문에, 이 관계를 함께 봐야 실제 생활과 연결된 해석이 가능합니다.",
        named(`${input.name}님의 음양오행 구성`, compositionText),
        named(
          `${input.name}님의 음양에 대한 설명`,
          ext
            ? (() => {
                const { yin, yang } = ext.yinYangPct;
                const yinDom = yin >= yang;
                const open = `${input.name}님의 사주는 음양(陰陽)의 균형 면에서 음(陰)이 ${yin}%, 양(陽)이 ${yang}%를 차지합니다. `;
                const mid = yinDom
                  ? yin >= 60
                    ? "이는 음(陰)의 비중이 상대적으로 큰 편이라 내향성·차분함·내면 정리 쪽으로 에너지가 기울기 쉬운 구성으로 읽을 수 있습니다. "
                    : "음(陰) 쪽 성향이 조금 더 도드라질 수 있는 구성으로 읽을 수 있습니다. "
                  : yang >= 60
                    ? "이는 양(陽)의 비중이 상대적으로 큰 편이라 발산·주도·외부 활동 쪽으로 에너지가 기울기 쉬운 구성으로 읽을 수 있습니다. "
                    : "양(陽) 쪽 성향이 조금 더 도드라질 수 있는 구성으로 읽을 수 있습니다. ";
                const tail = yinDom && yang <= 35
                  ? "다만 양(陽)이 충분히 받쳐주지 못하면 관계나 표현에서 적극성이 더딜 수 있으니, 작은 대화 루틴과 가벼운 외부 활동을 의도적으로 넣어 균형을 맞추는 편이 좋습니다."
                  : !yinDom && yin <= 35
                    ? "다만 음(陰)이 충분히 받쳐주지 못하면 회복·정리·내적 안정이 흔들릴 수 있으니 휴식과 감정 정리 시간을 고정하는 편이 좋습니다."
                    : "두 기운을 생활 리듬 속에서 함께 점검해 가시면 해석이 더 현실에 가깝게 맞아떨어집니다.";
                return open + mid + tail;
              })()
            : `${input.name}님의 음양 비율은 행동 속도와 관계 반응의 결을 읽는 데 도움이 됩니다.`,
        ),
        named(
          `${input.name}님의 일주에 대한 설명`,
          ext
            ? (() => {
                const d = ext.pillars[1];
                const stemLine = `${d.stemHanja}(${d.stemKorean})은 ${formatYinyangElementKoHanja(d.stemYinYang, d.stemElement)} 성격으로 일간의 기본 결을 드러내기 쉽습니다.`;
                const branchLine = `${d.branchHanja}(${d.branchKorean})은 ${formatYinyangElementKoHanja(d.branchYinYang, d.branchElement)} 성격으로 정서와 환경 반응의 결을 보여줄 수 있습니다.`;
                const elLabel = (k: ElementKey) =>
                  k === "목"
                    ? "나무(木)"
                    : k === "화"
                      ? "불(火)"
                      : k === "토"
                        ? "흙(土)"
                        : k === "금"
                          ? "금(金)"
                          : "물(水)";
                const weakBits: string[] = [];
                order.forEach((k) => {
                  if (ext.elementCounts[k] === 0) weakBits.push(`${elLabel(k)}의 부재 또는 극히 약한 흐름`);
                  else if (ext.elementPcts[k] <= 15 && ext.elementCounts[k] > 0) {
                    weakBits.push(`${elLabel(k)}의 약한 비중`);
                  }
                });
                const weakTail =
                  weakBits.length > 0
                    ? ` 오행 구성을 함께 보면 ${weakBits.slice(0, 2).join(", ")}은 생활에서 에너지 순환이나 추진·발산 면에서 부담으로 느껴질 수 있으니, 의도적인 보완 루틴이 도움이 됩니다.`
                    : " 오행 구성과 맞추어 읽으면 강한 기운은 추진에, 약한 기운은 회복과 정리에 쓰일 때 전체 균형이 잡히기 쉽습니다.";
                return `${input.name}님의 일주는 ${dayPillar}(${d.stemHanja}${d.branchHanja})입니다. ${stemLine} ${branchLine} ${dayPillar} 일주는 두 기운이 만나 만들어 내는 생활 태도와 선택 습관으로 이어질 수 있습니다.${weakTail}`;
              })()
            : `${input.name}님의 일주는 ${dayPillar}입니다. 일주는 사주 전체에서 성격의 중심축처럼 작동하기 때문에, 이후 장들의 해석도 이 기준과 함께 읽을수록 더 선명해집니다.`,
        ),
        ext
          ? (() => {
              const sorted = [...order].sort((a, b) => {
                const diff = ext.elementPcts[b] - ext.elementPcts[a];
                return diff !== 0 ? diff : ext.elementCounts[b] - ext.elementCounts[a];
              });
              const s = sorted[0];
              const w = [...sorted].reverse()[0];
              return `종합적으로, ${input.name}님의 음양오행은 음(陰) ${ext.yinYangPct.yin}%·양(陽) ${ext.yinYangPct.yang}%의 비율과 함께 ${elementKor[s]}(${s}${elementHanja[s]}) 기운이 두드러지는 흐름입니다. 반면 ${elementKor[w]}(${w}${elementHanja[w]})는 상대적으로 약해 보완이 필요할 수 있어, 외적 활동·추진·회복 사이에서 균형을 의도적으로 맞추면 한결 편안한 리듬을 만들기 쉽습니다.`;
            })()
          : "종합적으로 보면 이 장은 단순히 오행 개수를 세는 장이 아니라, 어떤 기운이 나를 밀어주고 어떤 기운이 생활에서 자꾸 보완을 요구하는지를 확인하는 장입니다.",
      ].join("\n\n");
      break;
    case 3: {
      const stemFlavor: Record<string, string> = {
        목: "성장과 확장의 리듬",
        화: "표현과 열기의 리듬",
        토: "중심과 균형을 잡으려는 힘",
        금: "기준과 단단함",
        수: "유연함과 흡수력",
      };
      const branchFlavor: Record<string, string> = {
        목: "새로움이나 성장 방향으로 마음이 기울 수 있으며",
        화: "감정의 온도가 비교적 분명하게 드러날 수 있으며",
        토: "안정과 루틴을 중시하는 경향이 강해질 수 있으며",
        금: "정리와 마무리에 힘이 실리기 쉬우며",
        수: "깊이와 적응이 강조되기 쉬우며",
      };
      const d = ext?.pillars[1];
      const seed = stableHash(
        `${input.name}|fallback:section3|${input.gender ?? ""}|${input.birth.year}-${input.birth.month}-${input.birth.day} ${input.birth.hour}:${input.birth.minute}|${dayPillar}`,
      );
      type Trait = { title: string; feature: string; impact: string };
      const pick = <T,>(arr: readonly T[], idx: number) => arr[idx % arr.length];
      const traitLines = (t: Trait) => [t.title, `특징 : ${t.feature}`, `영향 : ${t.impact}`].join("\n");
      const buildTraits = (kind: "stem" | "branch"): string => {
        if (!d) {
          const generic: readonly Trait[] = [
            { title: "의사결정의 속도", feature: "상황을 빠르게 정리하고 우선순위를 잡으려는 경향이 있습니다.", impact: "속도를 내면 성과가 빨라지지만, 급할 때는 확인을 한 번 더 거치면 실수를 줄이기 쉽습니다." },
            { title: "기준과 유연함의 균형", feature: "내 기준을 지키려는 마음과 상황에 맞추려는 마음이 같이 움직일 수 있습니다.", impact: "기준이 선명하면 강점이지만, 관계에서는 ‘조정할 수 있는 범위’를 먼저 말로 정하면 갈등이 줄어듭니다." },
            { title: "감정의 누적 방식", feature: "겉으로는 괜찮아 보여도 마음속에 쌓아두는 편일 수 있습니다.", impact: "쌓인 피로가 한 번에 터지지 않도록, 짧은 기록/정리 루틴을 두면 컨디션이 안정되기 쉽습니다." },
            { title: "관계에서의 거리감", feature: "가까운 사이일수록 기대치가 높아지는 패턴이 나타날 수 있습니다.", impact: "기대가 엇갈리면 서운함이 커질 수 있으니, ‘원하는 방식’을 구체적으로 요청하면 오해가 줄어듭니다." },
            { title: "새로운 환경 적응", feature: "낯선 환경에서는 관찰로 정보를 모은 뒤 움직이려는 경향이 있습니다.", impact: "초반엔 느려 보여도, 기준이 잡히면 빠르게 따라붙을 수 있으니 시작 단계 목표를 작게 잡아보세요." },
          ];
          return [
            traitLines(pick(generic, seed + 11)),
            "",
            traitLines(pick(generic, seed + 19)),
            "",
            traitLines(pick(generic, seed + 23)),
            "",
            traitLines(pick(generic, seed + 29)),
            "",
            traitLines(pick(generic, seed + 31)),
          ].join("\n");
        }

        const el = kind === "stem" ? d.stemElement : d.branchElement;
        const yy = kind === "stem" ? d.stemYinYang : d.branchYinYang;
        const elLabel = (e: string) => (e === "목" ? "목(木)" : e === "화" ? "화(火)" : e === "토" ? "토(土)" : e === "금" ? "금(金)" : "수(水)");
        const lead = `${elLabel(el)} 기운이 ${yy === "양" ? "겉으로" : "안으로"} 작동할 때 두드러지기 쉬운 포인트입니다.`;

        const pool: Record<string, readonly Trait[]> = {
          목: [
            { title: "시작을 여는 힘", feature: `새로운 일을 벌이거나 방향을 잡을 때 “일단 해보자” 쪽으로 마음이 기울기 쉽습니다. ${lead}`, impact: "초반 추진은 강점이지만, 끝맺음이 느슨해지지 않도록 ‘이번 주 완료 1개’처럼 마감 기준을 같이 두면 좋습니다." },
            { title: "성장 지향", feature: "배우고 확장하는 쪽에 에너지가 붙어, 스스로를 업데이트하려는 마음이 강해질 수 있습니다.", impact: "성장 욕구가 과해지면 조급함이 생길 수 있으니, 장기 목표는 유지하되 당장 할 일은 작게 쪼개는 방식이 안정적입니다." },
            { title: "관계의 확장성", feature: "사람·정보·기회를 넓히는 데 관심이 생기기 쉬워, 네트워크가 빠르게 넓어질 수 있습니다.", impact: "넓히는 속도가 빠르면 피로도 같이 커질 수 있으니, ‘깊게 갈 관계’와 ‘가볍게 지날 관계’를 구분해두면 좋습니다." },
          ],
          화: [
            { title: "표현과 추진", feature: `생각이 정리되면 말과 행동으로 바로 옮기는 편일 수 있습니다. ${lead}`, impact: "표현이 강점이지만 과열되면 말이 세질 수 있어요. 중요한 대화는 ‘요지 1문장’으로 시작하면 오해가 줄어듭니다." },
            { title: "의욕의 파도", feature: "기분과 동기가 올라올 때 속도가 크게 붙고, 내려갈 때는 급격히 피로를 느낄 수 있습니다.", impact: "올라오는 날에는 몰아치기보다 중간에 쿨다운 시간을 넣어야 다음 날 리듬이 유지됩니다." },
            { title: "주목과 성취 욕구", feature: "결과가 눈에 보이는 방식으로 성취하고 싶어하는 마음이 강해질 수 있습니다.", impact: "성과가 빨리 나면 좋지만, 비교가 심해지면 스트레스가 커질 수 있으니 ‘내 기준의 성공’을 한 줄로 정해두면 도움이 됩니다." },
          ],
          토: [
            { title: "안정과 책임", feature: `불확실한 상황에서 중심을 잡고 정리하려는 힘이 강해질 수 있습니다. ${lead}`, impact: "안정감은 강점이지만 책임을 혼자 떠안지 않도록 역할 분담을 먼저 정하면 부담이 줄어듭니다." },
            { title: "지속력", feature: "한 번 정한 루틴을 오래 유지하는 힘이 있어, 장기 과제에 강점을 보일 수 있습니다.", impact: "다만 변화가 필요할 때 늦어질 수 있으니, ‘작은 실험(1주)’을 정기적으로 넣어 유연성을 확보해보세요." },
            { title: "중재와 조율", feature: "갈등 상황에서 양쪽을 다 보고 균형을 맞추려는 성향이 나타날 수 있습니다.", impact: "조율이 과해지면 결정을 미루게 되니, 결론 시점을 미리 정해두는 것이 도움이 됩니다." },
          ],
          금: [
            { title: "기준과 정리", feature: `무엇이 맞는지, 무엇이 합리적인지 기준을 세우는 힘이 강해질 수 있습니다. ${lead}`, impact: "판단이 선명해지는 장점이 있지만, 말이 날카로워 보일 수 있어요. 피드백은 ‘사실→영향→요청’ 순서로 전달해보세요." },
            { title: "완성도", feature: "대충 넘어가기보다 완성도를 챙기려는 마음이 커질 수 있습니다.", impact: "완벽주의가 피로로 이어지지 않도록, 결과 기준을 80점으로 두고 마감을 먼저 잡는 편이 안전합니다." },
            { title: "경계 설정", feature: "관계에서 선을 긋고 규칙을 만들면 마음이 편해지는 편일 수 있습니다.", impact: "경계를 세우는 건 좋지만 너무 단절로 가지 않도록, ‘가능한 범위’를 같이 제시하면 관계가 부드럽게 유지됩니다." },
          ],
          수: [
            { title: "깊이 있는 사고", feature: `생각을 곱씹고 본질을 보려는 성향이 강해질 수 있습니다. ${lead}`, impact: "통찰은 강점이지만 결정을 미루기 쉬우니, 옵션을 2개만 남기고 선택하는 규칙이 도움이 됩니다." },
            { title: "감정의 여운", feature: "한 번 느낀 감정이 오래 남아, 정리하는 데 시간이 걸릴 수 있습니다.", impact: "감정을 억지로 밀기보다 ‘기록 5줄’처럼 배출 루틴을 두면 관계 피로가 줄어듭니다." },
            { title: "환경 민감도", feature: "수면·날씨·공간 같은 환경 요소에 컨디션이 민감하게 반응할 수 있습니다.", impact: "시작 시간을 30분만 고정해도 하루 리듬이 안정되기 쉬우니, 잠드는 시간을 먼저 고정해보세요." },
          ],
        };

        const chosen = pool[el] ?? pool.수;
        const t1 = pick(chosen, seed + (kind === "stem" ? 3 : 7));
        const t2 = pick(chosen, seed + (kind === "stem" ? 11 : 13));
        const t3 = pick(chosen, seed + (kind === "stem" ? 17 : 19));

        // 서로 다른 요소를 섞어 반복감 줄이기: 다른 오행 풀에서 2개 보충
        const otherEls = (["목", "화", "토", "금", "수"] as const).filter((x) => x !== el);
        const o1El = pick(otherEls, seed + (kind === "stem" ? 23 : 29));
        const o2El = pick(otherEls, seed + (kind === "stem" ? 31 : 37));
        const o1 = pick(pool[o1El], seed + 41);
        const o2 = pick(pool[o2El], seed + 47);

        // stem은 기준/행동, branch는 감정/관계 쪽으로 살짝 정렬
        const ordered = kind === "stem" ? [t1, o1, t2, o2, t3] : [t1, t2, o1, t3, o2];

        return ordered.map((t, i) => (i === 0 ? traitLines(t) : `\n${traitLines(t)}`)).join("\n");
      };
      const elPlain: Record<string, string> = {
        목: "나무처럼 뻗어나가고 성장하는",
        화: "불처럼 적극적이고 표현력이 강한",
        토: "흙처럼 안정적이고 포용적인",
        금: "금속처럼 날카롭고 기준이 선명한",
        수: "물처럼 유연하고 깊이 있는",
      };
      const stemPlainEl = d ? (elPlain[d.stemElement] ?? d.stemElement) : "";
      const branchPlainEl = d ? (elPlain[d.branchElement] ?? d.branchElement) : "";
      const ilganIntro =
        d
          ? `${input.name}님은 ${stemPlainEl} 에너지가 성격의 뼈대로 작용하기 쉬운 구조입니다. ${stemFlavor[d.stemElement] ?? "이 에너지"}이 의사결정 방식과 역할 수행 패턴에 자연스럽게 배어드는 경우가 많습니다.`
          : `${input.name}님의 타고난 기질이 의사결정 방식과 역할 수행 패턴에 자연스럽게 배어드는 경우가 많습니다.`;
      const iljiIntro =
        d
          ? `가까운 관계와 감정 반응을 들여다보면, ${branchPlainEl} 에너지가 내면에서 작동하고 있습니다. ${branchFlavor[d.branchElement] ?? "정서 반응이 두드러질 수 있으며"}, 주변 사람과의 온도 차이나 스트레스 반응에서 이 에너지가 드러나기 쉽습니다.`
          : `${input.name}님의 감정 반응 방식과 가까운 관계에서의 태도는 내면 에너지에 직결됩니다.`;
      const summary =
        d
          ? `종합적인 성격분석\n${input.name}님은 ${stemPlainEl} 에너지로 추진하고 기준을 잡으면서, ${branchPlainEl} 에너지로 감정을 다스리는 구조를 가지고 있습니다. 겉으로 드러나는 역할감과 안으로 쌓이는 감정 사이에서 속도를 조절할수록 피로는 줄고 선택의 명확성은 높아질 수 있습니다. 대인관계에서는 자신의 기준이 너무 날카롭게 전달되지 않도록 감정의 온도를 조금씩 말로 표현하는 연습이 도움이 됩니다.\n\n${input.name}님의 성격은 한 가지 단어로 정리되기보다, 상황에 따라 다른 결로 드러날 가능성이 큽니다. 강점이 되는 순간에는 과감히 밀고, 피로가 쌓이는 반응은 일찍 알아차려 조절하는 것이 핵심입니다.`
          : `종합적인 성격분석\n${input.name}님은 겉으로는 기준감이 있고 안으로는 감정의 결이 섬세한 흐름으로 읽을 수 있습니다. 자신만의 기준을 지키면서도, 감정 피로를 덜 쌓는 방향으로 속도를 조절하는 것이 중요합니다.`;
      body = [
        `${input.name}님, ${dayPillar} 일주에 대한 성격을 분석해드리겠습니다.`,
        [
          "일간을 기준으로 한 성격 분석",
          "",
          ilganIntro,
          "",
          buildTraits("stem"),
        ].join("\n"),
        [
          "일지를 기준으로 한 성격 분석",
          "",
          iljiIntro,
          "",
          buildTraits("branch"),
        ].join("\n"),
        summary,
      ].join("\n\n");
      break;
    }
    case 4: {
      // 십성(十星) 해설: 기둥마다 다른 문장 스켈레톤 사용해 반복감 제거
      const pick4 = <T,>(arr: readonly T[], key: string) => arr[stableHash(key) % arr.length];
      const sipseongGloss: Record<string, string> = {
        비견: "나와 같은 에너지(독립심·자기중심)",
        겁재: "나와 비슷하지만 경쟁·협력이 함께 오는 에너지",
        식신: "내가 만들어내는 표현·돌봄·창작의 에너지",
        상관: "기존 틀을 깨고 새롭게 표현하려는 에너지",
        편재: "바깥에서 들어오는 기회·재물의 에너지",
        정재: "꾸준하고 안정적인 수입·재물의 에너지",
        편관: "외부 도전과 단련을 통해 성장하는 에너지",
        정관: "규칙과 책임을 지키며 인정받는 에너지",
        편인: "직관과 창의력, 독특한 학습의 에너지",
        정인: "안정적 배움과 지지를 주고받는 에너지",
      };
      const sipGloss = (sip: string) => sipseongGloss[sip] ? `${sip}(${sipseongGloss[sip]})` : sip;

      const sipStemTemplates = [
        (stemLabel: string, sip: string, stage: string) =>
          `${stemLabel}에 자리한 ${sipGloss(sip)}은 ${stage}에 걸쳐 의사결정 방식과 표현 패턴에 스며드는 경우가 많습니다. 이 기운이 잘 살아날 때는 자신의 강점이 선명하게 드러나고, 반대로 과하게 쏠리면 주변과의 조율이 조금 더 필요해질 수 있어요. 내가 어떤 상황에서 이 에너지를 강하게 쓰는지 알아차리는 것이 첫 번째 조절 포인트입니다.`,
        (stemLabel: string, sip: string, stage: string) =>
          `${stage}의 천간을 보면 ${stemLabel}에 ${sipGloss(sip)}이 위치하고 있습니다. 이 에너지는 해당 시기에 선택의 기준과 태도에 반복적으로 등장하기 쉬우며, 강하게 실릴 때는 추진력이 되고 한쪽으로만 쏠릴 때는 피로감이 쌓일 수 있습니다. 강점으로 쓰되 속도와 대화의 균형을 함께 챙기면 훨씬 안정적입니다.`,
        (stemLabel: string, sip: string, stage: string) =>
          `${stemLabel}에서 읽히는 ${sipGloss(sip)}은 ${stage}의 생활 반응과 역할 방식에 직결됩니다. 이 에너지가 강하게 올라오는 장면에서 자신이 어떻게 반응하는지 살펴보면, 패턴이 분명히 보이기 시작합니다. 잘 활용하면 특기가 되고, 놓치면 소모로 이어질 수 있으니 타이밍 조절이 핵심입니다.`,
        (stemLabel: string, sip: string, stage: string) =>
          `${stage}에서 ${stemLabel}의 위치에 ${sipGloss(sip)}이 놓여 있습니다. 이 에너지는 그 시기 행동의 동기와 관계 방식에 색깔을 더하는 요소로 작용합니다. 강점이 되는 순간과 부담으로 느껴지는 순간을 구분해서 읽으면, 어떤 환경에서 최선의 선택을 하게 되는지 파악하기 쉬워집니다.`,
      ] as const;
      const sipBranchTemplates = [
        (branchLabel: string, sip: string, stage: string) =>
          `${stage}의 지지 자리인 ${branchLabel}에는 ${sipGloss(sip)}이 자리합니다. 지지는 가까운 관계와 환경의 반응이 드러나는 층위라, 이 에너지가 관계 장면에서 어떤 방식으로 체감되는지를 함께 읽어보시면 좋습니다. 과하게 쏠리지 않도록 기대치를 조정하거나 환경을 완충하면 부담이 크게 줄어듭니다.`,
        (branchLabel: string, sip: string, stage: string) =>
          `${stage}의 지지 ${branchLabel}에서 ${sipGloss(sip)}이 읽힙니다. 지지는 내면 반응과 인간관계의 온도와 연결되기 쉬운 자리입니다. 이 기운이 잘 흐를 때는 관계에서 자신의 역할이 분명해지고, 반대로 부담이 될 때는 혼자 버티기보다 상대와 속도를 맞추는 대화가 효과적입니다.`,
        (branchLabel: string, sip: string, stage: string) =>
          `${branchLabel}에 위치한 ${sipGloss(sip)}은 ${stage}의 감정 반응과 협력·경쟁의 방식에 영향을 주는 에너지입니다. 이 위치에서 해당 에너지가 강조되면 관계 감각이 날카로워지거나, 반대로 지치는 패턴이 나타날 수 있습니다. 주위 사람의 페이스와 내 에너지를 번갈아 확인하는 습관이 도움이 됩니다.`,
        (branchLabel: string, sip: string, stage: string) =>
          `${stage} 지지 ${branchLabel}의 ${sipGloss(sip)}은 그 시기의 관계 맥락과 내면 반응이 교차하는 지점을 보여줍니다. 이 에너지가 활성화될 때 어떤 감정이나 행동이 반복되는지 알아차리면, 불필요한 소모를 줄이고 관계를 더 가볍게 유지하는 방법을 찾기 쉬워집니다.`,
      ] as const;

      const sipStemPara = (stemLabel: string, sip: string, stage: string) =>
        sipStemTemplates[stableHash(`${input.name}|4stem|${stemLabel}|${sip}`) % sipStemTemplates.length](stemLabel, sip, stage);
      const sipBranchPara = (branchLabel: string, sip: string, stage: string) =>
        sipBranchTemplates[stableHash(`${input.name}|4branch|${branchLabel}|${sip}`) % sipBranchTemplates.length](branchLabel, sip, stage);

      if (ext) {
        const [pHour, pDay, pMonth, pYear] = [ext.pillars[0], ext.pillars[1], ext.pillars[2], ext.pillars[3]];
        const yKr = input.saju.fourPillarsKorean.year;
        const mKr = input.saju.fourPillarsKorean.month;
        const dKr = input.saju.fourPillarsKorean.day;
        const hKr = input.saju.fourPillarsKorean.hour;
        const stageIntros = [
          [
            `${input.name}님, 먼저 초년기를 의미하는 연주부터 살펴보겠습니다.`,
            "연주는 어린 시절의 환경과 초반 사회화 과정에서 형성된 태도를 읽는 데 도움이 됩니다.",
          ],
          [
            "다음으로, 청년기를 의미하는 월주입니다.",
            "월주는 사회 진입과 역할 수행, 현실 감각이 가장 강하게 드러나는 자리라 직업과 인간관계에서 자주 체감됩니다.",
          ],
          [
            "이어서, 중년기를 의미하는 일주를 보겠습니다.",
            "일주는 나 자신의 핵심과 가까운 관계의 반응이 가장 직접적으로 드러나는 기준 자리입니다.",
          ],
          [
            "마지막으로, 말년기를 의미하는 시주입니다.",
            "시주는 시간이 지날수록 선명해지는 가치관과 인생 후반의 정리 방식을 보여줍니다.",
          ],
        ] as const;
        body = [
          ...stageIntros[0],
          `연간에 ${sipGloss(pYear.sipseongStem)}이, 연지에 ${sipGloss(pYear.sipseongBranch)}이 위치합니다.`,
          sipStemPara("연간", pYear.sipseongStem, "초년기"),
          sipBranchPara("연지", pYear.sipseongBranch, "초년기"),
          ...stageIntros[1],
          `월간에 ${sipGloss(pMonth.sipseongStem)}이, 월지에 ${sipGloss(pMonth.sipseongBranch)}이 위치합니다.`,
          sipStemPara("월간", pMonth.sipseongStem, "청년기"),
          sipBranchPara("월지", pMonth.sipseongBranch, "청년기"),
          ...stageIntros[2],
          `일간에 ${sipGloss(pDay.sipseongStem)}이, 일지에 ${sipGloss(pDay.sipseongBranch)}이 위치합니다.`,
          sipStemPara("일간", pDay.sipseongStem, "중년기"),
          sipBranchPara("일지", pDay.sipseongBranch, "중년기"),
          ...stageIntros[3],
          `시간에 ${sipGloss(pHour.sipseongStem)}이, 시지에 ${sipGloss(pHour.sipseongBranch)}이 위치합니다.`,
          sipStemPara("시간", pHour.sipseongStem, "말년기"),
          sipBranchPara("시지", pHour.sipseongBranch, "말년기"),
          pick4([
            `종합적으로, ${input.name}님의 사주는 초년·청년·중년·말년 각 시기마다 서로 다른 에너지가 강조되면서 삶의 색깔이 바뀌는 흐름을 보여줍니다. 한 시기를 단독으로 평가하기보다 네 기둥의 흐름 전체를 연결해서 읽으면 자신의 패턴이 더 선명하게 보입니다.`,
            `종합적으로 보면, 이 사주의 네 기둥은 각각 다른 역할과 에너지를 담고 있습니다. 강한 기운을 잘 살리되 한쪽으로 치우치지 않도록 조절하면, 각 시기마다 더 안정된 선택을 할 수 있습니다.`,
          ], `${input.name}|4summary1`),
          `${input.name}님은 ${sipGloss(pDay.sipseongStem)}과 ${sipGloss(pDay.sipseongBranch)}을 중심으로 한 ${dKr} 일주 기준으로 보면, 연주 ${yKr}·월주 ${mKr}·시주 ${hKr}의 에너지 흐름이 삶의 어느 장면과 겹치는지 생활 장면과 대조해 보시면 훨씬 실감나게 이해하실 수 있습니다.`,
        ].join("\n\n");
      } else {
        body = `${input.name}님, 연주(초년기)·월주(청년기)·일주(중년기)·시주(말년기) 네 기둥을 순서대로 살펴보겠습니다.\n\n각 기둥에 담긴 에너지는 그 시기의 선택 방식, 관계 반응, 역할 태도에 영향을 줍니다. 강한 기운이 실리는 시기에는 추진력이 붙고, 균형이 필요한 시기에는 속도 조절과 대화가 중요해집니다.\n\n종합적으로, 이 사주의 네 기둥은 각각 다른 역할을 담고 있습니다. 특정 에너지가 너무 강하거나 약할 때 어떤 패턴이 반복되는지를 먼저 파악하면, 선택의 순간마다 더 나은 판단을 내릴 수 있습니다.`;
      }
      break;
    }
    case 5: {
      // 십이운성 해설: 에너지 강도별 다른 각도로 풀이 + 부정적 이름은 중립 언어 병기
      const sibiTemplates = [
        (label: string, u: string, stage: string) =>
          `${label}(${stage})의 에너지 리듬은 ${u}로 읽힙니다. 이 흐름은 그 시기에 에너지가 어느 방향으로 쏠리는지, 속도를 높여야 할 구간인지 아니면 정비할 구간인지를 가늠하는 기준이 됩니다. 강하게 올라오는 시기에는 적극적으로 활용하고, 조정 국면에는 무리하기보다 내실을 다지는 방향이 더 맞습니다.`,
        (label: string, u: string, stage: string) =>
          `${stage}에 해당하는 ${label}에서 ${u}이 나타납니다. 에너지의 강약이 삶의 흐름과 맞물리는 이 시기에, 자신이 어떤 환경에서 더 잘 움직이고 어떤 상황에서 쉬고 싶어지는지 관찰해보면 리듬이 보입니다. 결과를 좋고 나쁨으로 판정하기보다 현재 어디에 에너지를 써야 가장 효과적인지로 읽는 편이 유용합니다.`,
        (label: string, u: string, stage: string) =>
          `${u}은 ${stage}(${label})에서 드러나는 에너지의 결입니다. 이 시기의 리듬은 '얼마나 세게 밀 수 있는가'와 '언제 멈춰 재정비해야 하는가'를 동시에 보여줍니다. 자신이 이 흐름을 어떻게 체감해왔는지 떠올려보면 앞으로의 조절 방법도 더 선명해집니다.`,
        (label: string, u: string, stage: string) =>
          `${label}(${stage}) 에너지 수치는 ${u}로 나타납니다. 이 운성이 상징하는 리듬은 성취·충전·정리·전환 중 어느 국면과 가까운지에 따라 활용법이 달라집니다. 어느 방향이든 극단으로 쏠리지 않게 속도와 회복 사이의 균형을 유지하는 것이 핵심입니다.`,
      ] as const;
      const sibiPara = (label: string, unseong: string, stage: string) => {
        const u = formatSibiunseongKoHanja(unseong);
        const idx = stableHash(`${input.name}|5sibi|${label}|${unseong}`) % sibiTemplates.length;
        return sibiTemplates[idx](label, u, stage);
      };
      if (ext) {
        const pY = ext.pillars[3];
        const pM = ext.pillars[2];
        const pD = ext.pillars[1];
        const pH = ext.pillars[0];
        const dKr = input.saju.fourPillarsKorean.day;
        const introVariants = [
          `${input.name}님, 각 기둥에 새겨진 에너지 리듬을 보면 삶의 시기별 흐름이 보입니다. 하나씩 살펴보겠습니다.`,
          `${input.name}님의 사주에서 각 시기별 에너지 리듬을 순서대로 풀어드리겠습니다.`,
          `${input.name}님, 네 기둥에 담긴 에너지 강도를 시기별로 살펴보면 어느 구간이 '밀어야 할 때'이고 어느 구간이 '쉬어야 할 때'인지 읽어낼 수 있습니다.`,
        ] as const;
        const introIdx = stableHash(`${input.name}|5intro`) % introVariants.length;
        body = [
          introVariants[introIdx],
          `먼저 초년기(연주)입니다. 연주의 에너지 리듬: ${formatSibiunseongKoHanja(pY.sibiunseong)}.`,
          sibiPara("연주", pY.sibiunseong, "초년기"),
          `청년기(월주)입니다. 월주의 에너지 리듬: ${formatSibiunseongKoHanja(pM.sibiunseong)}.`,
          sibiPara("월주", pM.sibiunseong, "청년기"),
          `중년기(일주)입니다. 일주의 에너지 리듬: ${formatSibiunseongKoHanja(pD.sibiunseong)}.`,
          sibiPara("일주", pD.sibiunseong, "중년기"),
          `말년기(시주)입니다. 시주의 에너지 리듬: ${formatSibiunseongKoHanja(pH.sibiunseong)}.`,
          sibiPara("시주", pH.sibiunseong, "말년기"),
          `종합적으로, 네 시기의 에너지 리듬은 각각 다른 속도와 방향을 가지고 있습니다. 한 번에 전체를 바꾸려 하기보다, 지금 어느 구간에 있는지 파악하고 그에 맞는 페이스를 선택하는 것이 실질적인 활용법입니다.`,
          `${input.name}님은 ${dKr} 일주를 중심으로 각 시기의 흐름을 '에너지 높은 구간'과 '회복이 필요한 구간'으로 나눠 보시면, 언제 크게 움직이고 언제 내실을 다져야 하는지가 더 선명해집니다.`,
        ].join("\n\n");
      } else {
        body = `${input.name}님, 연주(초년기)·월주(청년기)·일주(중년기)·시주(말년기)의 에너지 리듬을 살펴보겠습니다.\n\n각 시기마다 에너지가 올라오는 구간과 정비가 필요한 구간이 번갈아 나타납니다. 이를 좋고 나쁨으로 판정하기보다, 지금 어느 구간에 있는지 파악하고 그에 맞는 속도를 선택하는 것이 현실적인 활용법입니다.\n\n종합적으로, 이 장의 핵심은 '밀 때와 쉴 때를 구분하는 리듬'입니다. 강한 에너지 구간에는 적극적으로 움직이고, 조정 구간에는 내실과 관계를 다지는 방식이 장기적으로 안정됩니다.`;
      }
      break;
    }
    case 6: {
      // 신살·귀인 해설: 각 기둥마다 다른 각도의 문장으로 반복감 제거
      const sinsalGloss: Record<string, string> = {
        역마살: "이동·변화·활동이 잦아지는 흐름",
        화개살: "혼자 집중하고 싶어지는 내면 에너지",
        육해살: "대인관계에서 마찰이 생기기 쉬운 흐름",
        년살: "인연과 만남이 활발해지는 흐름",
        월살: "집중과 고독이 교차하는 흐름",
        망신살: "자존심·체면이 테스트받는 흐름",
        겁살: "경쟁이나 돌발 변수가 나타나기 쉬운 흐름",
        재살: "정신적 집중이 필요한 내면 정리 흐름",
        천살: "하늘의 운기와 공적 환경이 변하는 흐름",
        지살: "움직임·이동이 강해지는 흐름",
        반안살: "현재 자리에서 실력을 갈고닦는 흐름",
        장성살: "자신감이 높아지고 두각을 나타내기 쉬운 흐름",
      };
      const salGloss = (sal: string) => sinsalGloss[sal] ? `${sal}(${sinsalGloss[sal]})` : sal;
      const sinsalTemplates = [
        (sal: string, stage: string, pillarKr: string) =>
          `${salGloss(sal)}이 ${stage}(${pillarKr})에 자리합니다. 이 흐름이 강해지는 시기에는 해당 에너지가 생활 장면에서 반복적으로 체감될 수 있습니다. 사건으로 받아들이기보다 '이 시기에 어디에 힘이 실리는가'를 읽는 신호로 활용하면 더 현명하게 대처할 수 있습니다.`,
        (sal: string, stage: string, pillarKr: string) =>
          `${stage}(${pillarKr})에서 ${salGloss(sal)}이 나타납니다. 이 에너지는 그 시기의 인간관계, 이동, 내면 반응에 특정 색깔을 더하는 역할을 합니다. 흉하다기보다 어디를 조심하고 어디를 활용할지를 미리 알려주는 보조 지표로 보시면 훨씬 편안하게 읽힙니다.`,
        (sal: string, stage: string, pillarKr: string) =>
          `${pillarKr}(${stage})에 ${salGloss(sal)}이 위치합니다. 이 흐름이 살아날 때는 특정 상황이 반복되거나 감정이 강하게 올라올 수 있습니다. 그럴 때일수록 속도를 조절하고, 주변과 대화로 완충하면 에너지 소모를 줄일 수 있습니다.`,
        (sal: string, stage: string, pillarKr: string) =>
          `${stage}의 ${pillarKr}에 자리한 ${salGloss(sal)}은 그 시기 생활의 흐름에 특유의 패턴을 만듭니다. 이 에너지를 잘 읽으면, 부담이 커지는 상황에서 어떻게 조율해야 할지 방향이 보입니다. 단정적인 길흉이 아닌 '이 시기의 특성'으로 이해하시면 됩니다.`,
      ] as const;
      const gwinGloss: Record<string, string> = {
        천을귀인: "위기 때 귀한 도움이 오는 기운",
        문창귀인: "지혜와 학문적 도움이 오는 기운",
        태극귀인: "큰 전환점에서 복이 오는 기운",
        천덕귀인: "하늘의 덕으로 재난을 피하는 기운",
        월덕귀인: "월 단위로 복이 쌓이는 안정 기운",
      };
      const gwinGlossStr = (names: string) => {
        return names.split(/과 |,\s*/).map(n => {
          const trimmed = n.trim();
          return gwinGloss[trimmed] ? `${trimmed}(${gwinGloss[trimmed]})` : trimmed;
        }).join(', ');
      };
      const gwinTemplates = [
        (names: string, stage: string, pillarKr: string) =>
          `${stage}(${pillarKr})에서 ${gwinGlossStr(names)}이 읽힙니다. 귀인의 기운은 혼자 힘으로 풀기 어려운 순간에 예상치 못한 도움이나 연결이 나타나기 쉬운 흐름을 나타냅니다. 다만 귀인에만 기대기보다 스스로의 준비와 판단이 함께할 때 가장 잘 작동합니다.`,
        (names: string, stage: string, pillarKr: string) =>
          `${pillarKr}(${stage})에 ${gwinGlossStr(names)}이 있습니다. 이 기운이 살아나면 배움이나 조언, 우연한 연결을 통해 상황이 풀리는 경험을 할 수 있습니다. 열린 자세로 도움을 받아들이되, 주도적인 노력도 같이 가져가는 것이 중요합니다.`,
        (names: string, stage: string, pillarKr: string) =>
          `${stage}의 ${pillarKr}에 자리한 ${gwinGlossStr(names)}은 어려운 상황에서 숨통이 트이는 통로 역할을 할 수 있습니다. 이 에너지가 실질적으로 작동하려면 자신도 판단과 행동을 함께 준비해두는 것이 가장 현실적인 방법입니다.`,
      ] as const;
      const sinsalPara = (sal: string, stage: string, pillarKr: string) =>
        sinsalTemplates[stableHash(`${input.name}|6sal|${pillarKr}|${sal}`) % sinsalTemplates.length](sal, stage, pillarKr);
      const gwinPara = (names: string, stage: string, pillarKr: string) =>
        gwinTemplates[stableHash(`${input.name}|6gwin|${pillarKr}|${names}`) % gwinTemplates.length](names, stage, pillarKr);
      if (ext) {
        const pY = ext.pillars[3];
        const pM = ext.pillars[2];
        const pD = ext.pillars[1];
        const pH = ext.pillars[0];
        const dKr = input.saju.fourPillarsKorean.day;
        const introVariants = [
          `${input.name}님, 각 시기마다 어떤 에너지 흐름이 작동하는지, 신살과 귀인의 관점에서 살펴보겠습니다.`,
          `${input.name}님의 사주에는 각 기둥마다 특유의 흐름 신호가 담겨 있습니다. 하나씩 풀어드리겠습니다.`,
          `${input.name}님, 신살과 귀인은 각 시기에 어떤 장면이 자주 등장하는지를 알려주는 보조 지표입니다. 함께 살펴보겠습니다.`,
        ] as const;
        const parts: string[] = [
          introVariants[stableHash(`${input.name}|6intro`) % introVariants.length],
          `초년기(연주)의 에너지 흐름: ${salGloss(pY.sibisinsal)}.`,
          sinsalPara(pY.sibisinsal, "초년기", "연주"),
          `청년기(월주)의 에너지 흐름: ${salGloss(pM.sibisinsal)}.`,
          sinsalPara(pM.sibisinsal, "청년기", "월주"),
          `중년기(일주)의 에너지 흐름: ${salGloss(pD.sibisinsal)}.`,
          sinsalPara(pD.sibisinsal, "중년기", "일주"),
          `말년기(시주)의 에너지 흐름: ${salGloss(pH.sibisinsal)}.`,
          sinsalPara(pH.sibisinsal, "말년기", "시주"),
          "이어서 귀인 흐름을 살펴보겠습니다.",
        ];
        const gwinBlocks: { pillar: string; stage: string; names: string }[] = [
          { pillar: "연주", stage: "초년기", names: pY.gwin.join("과 ") },
          { pillar: "월주", stage: "청년기", names: pM.gwin.join("과 ") },
          { pillar: "일주", stage: "중년기", names: pD.gwin.join("과 ") },
          { pillar: "시주", stage: "말년기", names: pH.gwin.join("과 ") },
        ];
        let anyGwin = false;
        for (const b of gwinBlocks) {
          if (!b.names) continue;
          anyGwin = true;
          parts.push(gwinPara(b.names, b.stage, b.pillar));
        }
        if (!anyGwin) {
          parts.push("이 사주에서는 네 기둥 모두 특정 귀인 기운이 두드러지지 않습니다. 귀인이 없다고 불리한 것이 아니라, 자신의 노력과 판단이 직접적인 결과로 이어지는 구조로 이해하시면 됩니다.");
        }
        parts.push(
          "귀인은 어려운 순간에 예상치 못한 도움이나 기회가 연결되는 흐름을 보여주는 보조 지표입니다. 스스로의 준비와 귀인 에너지를 함께 활용하면 더 안정적입니다.",
          `종합적으로, ${input.name}님의 사주는 각 시기마다 다른 에너지 흐름이 작동하고 있습니다. 신살을 사건으로 받아들이기보다 '그 시기의 특성'으로 읽고, 귀인 에너지가 있는 구간에는 관계와 배움에 더 열린 자세를 취하는 방식으로 활용하시면 됩니다. ${dKr} 일주를 중심으로 전체 흐름을 한 번 정리해보시면 어느 시기에 어떤 준비를 해야 할지 더 구체적으로 보입니다.`,
        );
        body = parts.join("\n\n");
      } else {
        body = `${input.name}님, 각 시기마다 어떤 에너지 흐름이 작동하는지, 신살과 귀인의 관점에서 살펴보겠습니다.\n\n신살은 각 기둥에 담긴 특유의 흐름 신호를 보여줍니다. 이를 흉하다고 받아들이기보다 어디에 힘이 실리고 어디를 조절해야 하는지 알려주는 안내 지표로 이해하시면 좋습니다.\n\n귀인 흐름은 어려운 순간에 도움이 연결되기 쉬운 통로를 보여줍니다. 스스로의 노력과 귀인 에너지를 함께 활용하는 것이 가장 현실적입니다.\n\n종합적으로, 신살과 귀인을 조합해서 읽으면 '언제 더 조심하고 언제 더 열린 자세를 가져야 하는지'의 흐름이 보입니다. 이를 생활의 리듬표로 활용해보세요.`;
      }
      break;
    }
    case 7: {
      const gw = (items: string[]) => (items.length ? items.join("·") : "해당없음");
      if (ext) {
        const d = ext.pillars[1];
        const py = ext.pillars[3];
        const pm = ext.pillars[2];
        const pd = ext.pillars[1];
        const ph = ext.pillars[0];
        const yyEl = formatYinyangElementKoHanja(d.stemYinYang, d.stemElement);
        const salGwin =
          `초년: 연주의 ${py.sibisinsal}이 연애·인연의 초기 리듬에 작용할 수 있으며, 귀인 ${gw(py.gwin)}은 도움의 통로로 읽을 수 있습니다. ` +
          `청년: 월주 ${pm.sibisinsal}과 귀인 ${gw(pm.gwin)}은 만남의 속도·환경 변화와 연결해 볼 수 있습니다. ` +
          `중년: 일주 ${pd.sibisinsal}과 귀인 ${gw(pd.gwin)}은 가까운 관계의 감정선·갈등 완충과 맞닿아 읽는 편이 좋습니다. ` +
          `말년: 시주 ${ph.sibisinsal}과 귀인 ${gw(ph.gwin)}은 내면 성숙·관계 정리 방식과 연결해 볼 수 있습니다.`;
        body = [
          named(
            "연애운 풀이",
            `${input.name}님의 연애운은 감정의 깊이와 관계의 속도 조절을 함께 봐야 하는 흐름입니다. 감정이 생겼을 때 빠르게 확신을 만들기보다, 상대와의 대화 빈도·약속 이행·갈등 해결 방식이 안정적인지 시간을 두고 확인할수록 만족도가 높아질 가능성이 큽니다. ${dayPillar} 일주의 기질을 생활 장면과 겹쳐 읽으면 해석이 더 선명해집니다.`,
          ),
          named(
            "일간 성격과 연애 성향",
            `일간이 ${d.stemHanja}(${d.stemKorean}) ${yyEl}의 기질을 지닌 것으로 읽을 수 있습니다. 겉으로 드러나는 태도와 내면에서 중시하는 신뢰·안정이 연애에서도 같은 축으로 이어질 여지가 있습니다. 사랑에서는 기준을 분명히 두고 마음을 여는 속도가 신중할 수 있으나, 신뢰가 쌓이면 진지하게 관계를 지키려는 태도로 연결되기 쉽습니다. 상대에게는 차갑게 보일 수 있으니 감정의 온도를 가끔은 말로 전하는 연습이 관계 만족에 도움이 됩니다.`,
          ),
          named(
            "연애에서 나타나는 장단점",
            "장점: 기준과 책임감을 중시하는 태도는 상대에게 안정감을 줄 수 있으며, 약속과 생활 리듬을 맞추려는 성향이 관계를 오래 끌고 가는 힘으로 이어질 수 있습니다. 단점: 표현이 절제되면 상대가 확신을 느끼기 어려울 수 있고, 기준이 높아질수록 실망도 커질 수 있으니 전제를 나누는 대화가 필요합니다.",
          ),
          named(
            "연애 시기와 방법",
            "언제: 청년기와 중년기에 인연의 기회가 비교적 잘 들어올 수 있는 흐름으로 읽을 수 있으며, 중년기에는 안정적인 사랑을 다지기 좋은 리듬이 붙을 여지가 있습니다. 어디서: 일과 사회적 모임처럼 역할이 드러나는 장면에서 인연이 연결되기 쉽다고 볼 수 있습니다. 누구와: 가치관과 생활 리듬을 현실적으로 맞출 수 있는 사람, 대화로 오해를 줄이려는 사람과 잘 맞을 가능성이 큽니다. 어떻게: 신중하게 다가가되 진심을 조금씩 열어 보이면 관계의 깊이가 자연스럽게 자랄 수 있습니다.",
          ),
          named("살과 귀인의 영향", salGwin),
          named(
            "성공적인 연애를 위한 조언",
            "냉정함과 기준이 강점이 될 수 있지만, 감정을 아예 숨기기만 하면 상대는 사랑을 체감하기 어려울 수 있습니다. 서운함이 쌓이기 전에 작은 단위로 말하는 습관과, 상대 입장을 한 번 더 헤아리는 태도가 관계의 온도를 지키는 데 큰 도움이 됩니다.",
          ),
          named(
            "나의 결혼운",
            "청년기와 중년기에 결혼운이 상승하는 흐름으로 읽을 여지가 있으며, 현실적 책임과 생활 운영이 맞는 사람과 안정적인 동반자 관계를 다지기 쉽습니다. 결혼 후에도 역할과 경계를 분명히 하되, 감정 표현이 줄지 않도록 작은 루틴을 유지하는 편이 좋습니다.",
          ),
          named(
            "이상적인 배우자상과 피해야할 배우자상",
            "이상적인 배우자상: 신뢰와 안정감을 주고, 이성과 감성의 균형을 맞출 줄 아는 사람이 잘 맞을 수 있습니다. 나의 기질을 존중하면서도 대화로 차이를 조율할 수 있는 상대라면 더 조화롭습니다. 피해야할 배우자상: 변덕이 크고 회피가 반복되거나, 약속을 가볍게 넘기는 유형은 갈등이 누적되기 쉬우니 장기적으로 부담이 될 수 있습니다.",
          ),
          named(
            "배우자와의 관계 전망",
            "신뢰를 바탕으로 점진적으로 관계를 키울 가능성이 높으며, 책임과 실질적인 가치를 함께 추구하는 안정적인 가정을 꾸릴 여지가 있습니다. 다만 바쁨 속에서 감정 표현이 줄어들면 소홀함으로 느껴질 수 있으니, 작은 확인과 감사 표현을 습관화하는 것이 중요합니다.",
          ),
          named(
            "연애에서 피해야 할 점",
            "지나치게 계산적이거나 차가운 인상만 남기지 않도록 균형을 잡으세요. 상대의 단점만 분석하거나 비판적으로만 바라보면 관계가 빠르게 소모될 수 있으니, 사실 확인과 질문 중심 대화로 방향을 잡는 편이 좋습니다.",
          ),
          named(
            "종합분석",
            `${input.name}님은 신뢰와 안정을 중시하는 연애 스타일로 읽을 수 있으며, 청년·중년을 거치며 인연의 질이 성숙해지는 흐름을 기대해볼 수 있습니다. 감정 표현과 공감을 조금만 보태면 사랑과 결혼 모두에서 긍정적인 결과를 만들 여지가 크며, ${dayPillar} 일주의 기질을 존중하면서도 관계의 속도는 의도적으로 조율하는 태도가 가장 현실적인 전략입니다.`,
          ),
        ].join("\n\n");
      } else {
        body = [
          named("연애운 풀이", `${input.name}님의 연애운은 감정의 깊이와 관계의 속도 조절을 함께 봐야 하는 흐름입니다. 감정이 생겼을 때 빠르게 확신을 만들기보다, 상대와의 대화 빈도·약속 이행·갈등 해결 방식이 안정적인지 시간을 두고 확인할수록 만족도가 높아질 가능성이 큽니다.`),
          named("일간 성격과 연애 성향", `${input.name}님은 신뢰가 쌓일수록 관계에 깊게 들어가는 편일 가능성이 있습니다. 다만 마음이 커질수록 기대치도 함께 올라갈 수 있으니, 원하는 관계 방식과 불편한 지점을 초반부터 구체적으로 공유하면 관계 피로를 줄이는 데 도움이 됩니다.`),
          named("연애에서 나타나는 장단점", "장점은 진지함과 책임감으로 관계의 안정감을 만들 수 있다는 점입니다. 반면 단점은 기준이 높아지면서 실망도 커질 수 있다는 부분이므로, 상대의 표현 방식이 나와 다를 수 있다는 전제를 두고 대화를 이어가는 태도가 필요합니다."),
          named("연애 시기와 방법", "언제: 관계를 천천히 신뢰로 쌓는 시기가 유리합니다. 어디서: 일상과 모임 속에서 자연스럽게 만나는 흐름이 잘 맞을 수 있습니다. 누구와: 대화와 약속을 지키는 사람과 궁합이 좋습니다. 어떻게: 감정을 작은 단위로 나누어 표현하며 속도를 맞추세요."),
          named("살과 귀인의 영향", "신살의 작용이 강한 시기에는 관계의 기복이 커질 수 있고, 귀인의 흐름이 좋을 때는 좋은 인연이 들어올 가능성이 있습니다. 이 시기에는 감정 반응을 즉시 결론으로 연결하지 말고, 최소 하루 간격으로 생각을 정리한 뒤 대화하는 방식이 도움이 됩니다."),
          named("성공적인 연애를 위한 조언", "서운함이 쌓이기 전에 작은 단위로 말하는 습관이 중요합니다. '무엇이 불편했는지-왜 힘들었는지-앞으로 어떻게 맞출지' 순서로 전달하면 감정 소모를 줄이면서도 관계를 실제로 개선할 수 있습니다."),
          named("나의 결혼운", "결혼운은 감정보다 생활 리듬과 책임 분담이 맞는 사람과 안정적으로 이어질 가능성이 큽니다. 결혼을 고려할수록 가치관보다도 생활 운영 방식(시간, 돈, 가족, 휴식)에 대한 합의가 중요한 판단 기준이 됩니다."),
          named("이상적인 배우자상과 피해야할 배우자상", "이상적인 배우자는 감정 표현이 안정적이고 약속을 가볍게 넘기지 않는 사람입니다. 반대로 중요한 문제를 회피하거나 감정 기복이 큰 상황에서 대화를 끊어버리는 유형은 장기적으로 피로를 키울 수 있으니 주의가 필요합니다."),
          named("배우자와의 관계 전망", "서로 기준을 존중하고 대화 속도를 맞춘다면 오래 갈 가능성이 있습니다. 갈등이 생겼을 때 승부를 보려는 태도보다 문제를 구조적으로 나눠 해결하는 태도를 유지하면, 관계 만족도와 신뢰가 함께 높아질 수 있습니다."),
          named("연애에서 피해야 할 점", "마음속 결론을 먼저 내리고 상대를 시험하듯 보는 태도는 피하시는 편이 좋습니다. 확인되지 않은 추측을 사실처럼 다루면 관계가 빠르게 소모될 수 있으니, 감정이 커질수록 사실 확인과 질문 중심 대화로 방향을 잡으세요."),
          named("종합분석", `${input.name}님의 연애와 결혼운은 진심의 깊이는 충분하지만 표현 방식과 타이밍에 따라 체감 차이가 크게 나타날 수 있습니다. 핵심은 감정의 크기보다 관계 운영 방식이며, 대화 루틴과 기대 조율을 함께 가져갈수록 안정적인 흐름을 만들 가능성이 큽니다.`),
        ].join("\n\n");
      }
      break;
    }
    case 8: {
      const gw = (items: string[]) => (items.length ? items.join("·") : "해당없음");
      if (ext) {
        const py = ext.pillars[3];
        const pm = ext.pillars[2];
        const pd = ext.pillars[1];
        const ph = ext.pillars[0];
        const yKr = input.saju.fourPillarsKorean.year;
        const mKr = input.saju.fourPillarsKorean.month;
        const dKr = input.saju.fourPillarsKorean.day;
        const hKr = input.saju.fourPillarsKorean.hour;
        const yyEl = formatYinyangElementKoHanja(pd.stemYinYang, pd.stemElement);
        const flowPara = (
          stage: string,
          pillarKr: string,
          p: (typeof ext)["pillars"][0],
        ) =>
          `${stage} : ${stage}를 상징하는 ${pillarKr}(${p.stemHanja}${p.branchHanja})에는 천간 십성 ${p.sipseongStem}과 지지 십성 ${p.sipseongBranch}의 흐름이 있으며, 십이운성은 ${p.sibiunseong}에 해당합니다. 십이신살 ${p.sibisinsal}과 귀인 ${gw(p.gwin)}은 재물의 변동·기회·조언 통로로 연결해 읽을 수 있으니, 해당 시기에는 수입·지출·투자의 속도를 의도적으로 맞추는 편이 현실적입니다.`;
        const salSet = [...new Set([py, pm, pd, ph].map((x) => x.sibisinsal))].join(", ");
        const gwinParts = [py, pm, pd, ph].flatMap((x) => x.gwin);
        const gwinSet = [...new Set(gwinParts)].join(", ") || "해당없음";
        body = [
          named(
            "재물운 풀이",
            `${input.name}님의 재물운은 한 번의 기회보다 관리 습관과 선택의 속도에서 차이가 벌어질 가능성이 있습니다. 큰 수입이 들어오는 순간보다, 그 수입을 지키고 다시 불릴 구조를 얼마나 일찍 만들었는지가 장기 성과를 좌우할 수 있습니다. ${dKr} 일주를 중심으로 네 기둥의 흐름을 함께 보면 해석이 더 선명해집니다.`,
          ),
          named(
            "일간 성격과 재물운",
            `나의 일간은 ${pd.stemKorean}(${pd.stemHanja}) ${yyEl}의 기질로 읽을 수 있으며, 의지와 기준을 바탕으로 목표를 세우고 밀어붙이는 힘이 재물 판단에도 스며들기 쉽습니다. 재물운과 관련해서는 실리적 판단과 계획·실행의 연결이 강점이 될 수 있으니, 지나친 완벽주의로 실행만 늦어지지 않도록 월 단위 점검 같은 가벼운 운영 도구를 먼저 고정하는 편이 유리합니다.`,
          ),
          named(
            "시간에 따른 재물운의 흐름",
            [
              flowPara("초년기", yKr, py),
              flowPara("청년기", mKr, pm),
              flowPara("중년기", dKr, pd),
              flowPara("말년기", hKr, ph),
            ].join("\n\n"),
          ),
          named(
            "재물운이 크게 들어오는 시기",
            `재물운이 비교적 크게 실리기 쉬운 구간은 중년기 ${dKr} 일주가 중심이 되는 시기와 말년기 ${hKr} 흐름이 안정을 받쳐주는 시기로 읽을 여지가 있습니다. 중년기에는 ${pd.sipseongStem}·${pd.sipseongBranch}의 성격이 수입 구조를 다지는 데 영향을 줄 수 있고, 말년기에는 ${ph.sipseongStem}·${ph.sipseongBranch}와 ${ph.sibiunseong} 리듬이 장기 관리·보전 쪽으로 기운을 모으기 쉽습니다. 다만 들어온 만큼 지출 구조를 같이 잡지 않으면 흐름이 빨리 새므로 현금흐름 점검을 병행하세요.`,
          ),
          named(
            "살과 귀인의 영향",
            `네 기둥의 십이신살(${salSet})은 시기마다 재물 사건의 속도와 변동성에 영향을 줄 수 있습니다. 귀인(${gwinSet})은 조언·협력·우연한 통로로 손실을 줄이거나 기회를 열 여지가 있으니, 변동이 큰 시기일수록 단독 판단보다 검증 가능한 조언 루트를 확보하는 편이 재정 안전에 도움이 됩니다.`,
          ),
          named(
            "주의해야 될 시기",
            `청년기 ${mKr} 구간에서는 ${pm.sibisinsal}의 영향으로 이동·확장·시행착오가 겹치며 지출이 커질 여지가 있으니 과도한 확장을 경계하세요. 중년기 ${dKr}에서는 ${pd.sipseongStem} 기운이 강해질 때 경쟁·주장이 겹치며 무리한 투자나 계약이 들뜰 수 있으니 속도 조절이 필요합니다. 감정 피로가 큰 날에는 보상 소비를 미루고 고정비부터 재점검하는 습관이 좋습니다.`,
          ),
          named(
            "어떻게 재물을 모으게 될까?",
            `${pd.stemKorean} 일간의 단단한 기질은 꾸준한 실행과 명확한 우선순위를 통해 재물을 쌓는 방식과 잘 맞습니다. 자동이체·지출 분류·주간 점검의 3단 구조를 먼저 고정하고, 귀인이 살아나는 시기에는 조언과 정보를 적극 활용하면 형성 속도가 안정적으로 붙기 쉽습니다.`,
          ),
          named(
            "성공적인 재물의 축적 방법",
            "구체적인 목표 금액과 기한을 정하고, 투자와 소비의 균형을 월 단위로 점검하는 편이 좋습니다. 감정 트리거(스트레스·피로·비교)가 있는 지출은 따로 기록해 누수를 줄이고, 귀인의 도움이나 신뢰할 수 있는 자문을 구조화해 두면 판단 흔들림을 줄일 수 있습니다.",
          ),
          named(
            "종합분석",
            `${input.name}님의 사주는 일간 ${yyEl}의 실리적 성향과 네 기둥의 십성·십이운성·신살 흐름이 재물운을 점차 다지는 구조로 읽을 수 있습니다. 초년·청년에는 기틀과 경험이, 중년·말년에는 축적과 보전이 강조될 여지가 있으니 시기별 목표를 바꿔 가며 운용하세요. 기회가 좋을 때 확장만 하지 않고 보전 구조를 함께 두는 태도가 장기적으로 가장 안전한 재물 전략입니다.`,
          ),
        ].join("\n\n");
      } else {
        body = [
          named("재물운 풀이", `${input.name}님의 재물운은 한 번의 기회보다 관리 습관과 선택의 속도에서 차이가 벌어질 가능성이 있습니다. 큰 수입이 들어오는 순간보다, 그 수입을 지키고 다시 불릴 구조를 얼마나 일찍 만들었는지가 장기 성과를 좌우할 수 있습니다.`),
          named("일간 성격과 재물운", "기준과 계획을 중시하는 태도는 재물 관리에서 강점이 될 수 있습니다. 다만 계획이 세밀할수록 실행이 늦어질 수 있으니, 월 단위 점검표처럼 간단한 운영 도구를 먼저 고정하고 점차 정교화하는 방식이 효율적입니다."),
          named("시간에 따른 재물운의 흐름", "초년기 : 기반과 학습에 투자하는 흐름으로 읽을 수 있습니다. 청년기 : 탐색과 변화 속에서 수입 기회를 넓히되 분산이 과하면 누수가 생길 수 있습니다. 중년기 : 축적과 구조화에 집중하면 성과가 굳건해지기 쉽습니다. 말년기 : 안정·보전·장기 관리로 마무리하는 편이 유리합니다."),
          named("재물운이 크게 들어오는 시기", "수입 자체보다 성과를 구조화할 수 있는 시기가 더 중요하게 작용할 수 있습니다. 운이 들어오는 구간에서는 지출 확대보다 안전자산·현금흐름·고정비 관리 순서로 정리하면 상승 흐름을 더 오래 유지할 수 있습니다."),
          named("살과 귀인의 영향", "신살은 돈이 들어오고 나가는 사건성을 키울 수 있고, 귀인은 좋은 조언을 받을 통로로 작용할 수 있습니다. 즉, 변동성이 커질 때는 단독 판단보다 검증 가능한 조언 루트를 확보하는 것이 손실을 줄이는 데 실질적으로 도움이 됩니다."),
          named("주의해야 될 시기", "감정 피로가 큰 시기에는 보상 소비나 조급한 판단이 겹칠 수 있으니 주의가 필요합니다. 이때는 고정 지출부터 재점검하고, 큰 금액의 결정은 최소 24시간 숙려 규칙을 두는 방식이 재정 안전성을 높입니다."),
          named("어떻게 재물을 모으게 될까?", "반복 가능한 관리 습관과 지출 점검 구조를 먼저 만드는 편이 유리합니다. 월별 저축률보다도 '자동이체-지출 분류-주간 점검'의 3단 구조를 고정하면 재물 축적 속도가 훨씬 안정적으로 올라갈 수 있습니다."),
          named("성공적인 재물의 축적 방법", "예산 금액만이 아니라 점검 횟수와 소비 패턴을 함께 관리하시는 편이 좋습니다. 특히 지출의 감정 트리거(스트레스, 피로, 비교심리)를 파악하면 불필요한 누수를 줄이고 실질적인 순자산 증가로 연결하기 쉬워집니다."),
          named("종합분석", `${input.name}님의 재물운은 기회의 크기보다 관리 방식에 따라 체감 차이가 커질 수 있는 구조입니다. 핵심은 운이 좋을 때 확장만 하지 않고 보전 구조를 함께 만들며, 운이 약할 때는 손실 관리와 루틴 유지로 기초 체력을 지키는 데 있습니다.`),
        ].join("\n\n");
      }
      break;
    }
    case 9: {
      const salJobNote = (name: string) => {
        const m: Record<string, string> = {
          역마살: "변화·이동·대외 활동이 잦은 직무에서 기회가 열리기 쉽습니다.",
          육해살: "대인관계에서 작은 마찰이 있을 수 있으나 배움과 조율로 전환할 여지가 있습니다.",
          화개살: "내면·창의·연구형 업무에 유리하게 읽을 수 있습니다.",
          도화살: "대외 이미지·소통이 중요한 직무에서 주목받을 수 있으나 경계 관리가 필요합니다.",
        };
        return m[name] ?? `${name}은 직업 환경의 사건성이나 리듬 변화에 영향을 줄 수 있으니 해당 시기에는 판단을 서두르지 않는 편이 안전합니다.`;
      };
      const gwinJobNote = (name: string) => {
        const m: Record<string, string> = {
          문창귀인: "학문·기획·표현이 빛날 때 주변의 지지와 조언을 받기 쉽습니다.",
          천을귀인: "위기·이직·승인 절차처럼 막힌 구간에서 조력자나 우연한 통로가 열릴 여지가 있습니다.",
          천덕귀인: "덕망과 신뢰로 어려움을 완충하는 인연이 작용할 수 있습니다.",
          월덕귀인: "제도·규정·상사선에서 도움을 받기 쉬운 흐름으로 읽을 수 있습니다.",
        };
        return m[name] ?? `${name}은 직장·사업 판단에서 조언과 협력 통로로 작용할 수 있습니다.`;
      };
      if (ext) {
        const py = ext.pillars[3];
        const pm = ext.pillars[2];
        const pd = ext.pillars[1];
        const ph = ext.pillars[0];
        const mKr = input.saju.fourPillarsKorean.month;
        const dKr = input.saju.fourPillarsKorean.day;
        const yyEl = formatYinyangElementKoHanja(pd.stemYinYang, pd.stemElement);
        const igiEl = formatYinyangElementKoHanja(pd.branchYinYang, pd.branchElement);
        const jobByElement: Record<string, string> = {
          목: "기획·교육·성장·환경·콘텐츠처럼 확장과 기획력이 필요한 분야",
          화: "홍보·서비스·브랜딩·현장 소통처럼 에너지가 즉시 드러나는 분야",
          토: "행정·부동산·운영·품질관리처럼 질서와 실행을 묶는 분야",
          금: "법률·공학·금융·정보기술·건축·관리처럼 논리·규범·정밀함이 요구되는 분야",
          수: "연구·데이터·유통·컨설팅처럼 분석과 유연한 대응이 함께 요구되는 분야",
        };
        const jobCluster = jobByElement[pd.stemElement] ?? "전문성과 체계가 함께 요구되는 분야";
        const salUnique = [...new Set([py, pm, pd, ph].map((x) => x.sibisinsal))];
        const salBlock =
          `네 기둥에서 읽히는 십이신살은 ${salUnique.join(", ")}입니다. ` +
          salUnique.map((s) => `'${s}'는 ${salJobNote(s)}`).join(" ");
        const gwinUnique = [...new Set([py, pm, pd, ph].flatMap((x) => x.gwin))];
        const gwinIntro =
          gwinUnique.length === 1
            ? `'${gwinUnique[0]}' 귀인이 작용할 수 있습니다. `
            : `${gwinUnique.map((g) => `'${g}'`).join(", ")} 귀인이 함께 작용할 수 있습니다. `;
        const gwinBlock =
          gwinUnique.length > 0
            ? `${gwinIntro}` + gwinUnique.map((g) => `'${g}'는 ${gwinJobNote(g)}`).join(" ")
            : "귀인이 비어 있는 기둥이 있으면 스스로 정보를 구조화하고 멘토링 통로를 만드는 편이 직업 안정에 도움이 됩니다.";
        body = [
          named(
            "직업운 풀이",
            `${input.name}님의 직업운은 재능을 어디에 쓰느냐와 함께, 조직·사업 맥락에서 역할을 어떻게 유지·전개하느냐에서 결과가 갈리기 쉽습니다. 업무 성과는 단기 폭발력보다 역할의 지속 가능성에서 갈릴 가능성이 크므로, ${dKr} 일주를 축으로 월주의 직장 리듬과 일·시 기둥의 사업 성향을 함께 읽는 편이 방향을 선명하게 잡는 데 도움이 됩니다.`,
          ),
          named(
            "나의 일간 성격에 맞는 직업, 직무",
            `나의 일간은 ${pd.stemKorean}으로, ${pd.stemHanja}는 ${yyEl}의 기질로 읽을 수 있습니다. 이성·논리·기준을 중시하는 성향이 강하면 문제를 구조화하고 개선안을 만드는 업무에서 강점이 오래 유지되기 쉽습니다. ${jobCluster}에서 두각을 나타낼 여지가 있으며, 규범·책임·품질이 중요한 조직에서도 안정적으로 평가받는 흐름으로 연결해 볼 수 있습니다. 일지 ${pd.branchHanja}(${pd.branchKorean}) ${igiEl}의 기운이 함께하므로 실제 직무 선택 시 협업 방식과 업무 환경의 온도(경쟁·자율·보고 체계)를 함께 고려하는 편이 좋습니다.`,
          ),
          named(
            "나의 직장운",
            `나의 사주에서 월간과 월지가 청년기·직장운의 흐름을 가리킵니다. ${mKr}에는 월간 십성이 '${pm.sipseongStem}', 월지 십성이 '${pm.sipseongBranch}'로 자리하며, 십이운성은 ${formatSibiunseongKoHanja(pm.sibiunseong)}에 해당합니다. 월지 십성은 조직 안에서의 인정·업무 태도·성과 스타일과 연결해 읽을 수 있고, 월간 십성은 경쟁·표현·협상의 긴장을 드러낼 수 있으니 동료·상사와의 의견 차이를 조기에 조율하는 습관이 안정적인 성장에 도움이 됩니다. 보고와 기대치를 문장으로 정리해 두면 불필요한 오해를 줄이고 책임 있는 역할로 확장되기 쉽습니다.`,
          ),
          named(
            "나의 사업운",
            `사업운은 일주의 일지와 시주의 시지에서 확인할 수 있습니다. 일지 십성은 '${pd.sipseongBranch}', 시지 십성은 '${ph.sipseongBranch}'이 자리하며, 시간 천간 십성은 '${ph.sipseongStem}'으로 읽을 수 있습니다. 일지 십성은 독립성·동업 적합도·리스크 성향과 맞닿아 있고, 시지 십성은 후반 운용·전략·내면의 신중함과 연결해 볼 수 있습니다. 속도만 앞서면 현금흐름과 계약 리스크가 함께 커질 수 있으니 조건을 문서화하고, 긴밀한 협력이 필요할 때는 전문가 자문을 구하는 선택이 현명합니다.`,
          ),
          named("십이신살과 귀인의 영향", `${salBlock} ${gwinBlock} 변동이 커지는 시기에는 단독 결정보다 검증 가능한 데이터와 조언에 기반해 이직·전환 타이밍을 잡는 편이 시행착오를 줄입니다.`),
          named(
            "성공적인 직장생활을 위한 조언",
            `${yyEl} 기질은 기준이 뚜렷해 업무에서 강직하거나 완벽주의적으로 보일 수 있으니, 협업에서는 결론-근거-요청사항 순서로 커뮤니케이션을 정리하는 연습이 부담을 줄입니다. 월간 '${pm.sipseongStem}' 기운이 강해질 때는 경쟁과 속도가 붙기 쉬우니 갈등을 부드럽게 푸는 대화 스킬을 키우면 신뢰가 함께 쌓입니다. 시지 '${ph.sipseongBranch}'의 안정 에너지를 바탕으로 상사·선배와 조화를 쌓으면 장기적으로 중요한 역할을 맡기 쉬운 흐름으로 이어질 수 있습니다.`,
          ),
          named(
            "종합분석",
            `${input.name}님의 사주는 일간 ${yyEl}의 특성을 통해 이성적·체계적인 분야에서 강점을 드러낼 여지가 있습니다. 직장에서는 월간·월지 십성(${pm.sipseongStem}·${pm.sipseongBranch}) 흐름 속 경쟁을 극복하고 협력으로 전환할수록 안정적인 경로가 열립니다. 사업에서는 일지·시지 십성(${pd.sipseongBranch}·${ph.sipseongBranch})을 근거로 독립과 신중한 전략의 균형을 잡는 편이 좋습니다. 십이신살(${salUnique.join(", ")})과 귀인(${gwinUnique.join(", ") || "해당없음"})의 조화로 이동·변화 속 기회와 조력을 활용할 수 있으니, 꾸준한 실행과 열린 소통을 함께 가져가면 직장·사업 모두에서 지속 가능한 성과를 기대해볼 수 있습니다.`,
          ),
        ].join("\n\n");
      } else {
        body = [
          named("직업운 풀이", `${input.name}님의 직업운은 능력을 어디에 쓰느냐 못지않게, 어떤 방식으로 역할을 맡고 유지하느냐가 중요할 수 있습니다. 업무 성과는 단기 폭발력보다 역할의 지속 가능성에서 갈릴 가능성이 크므로, 본인의 강점을 반복 가능한 구조로 만드는 것이 핵심입니다.`),
          named("나의 일간 성격에 맞는 직업, 직무", "성향과 리듬이 맞는 구조를 먼저 보는 편이 좋습니다. 즉흥 대응이 많은 환경보다 기준을 세우고 개선해 나갈 수 있는 직무에서 강점이 오래 유지되며, 문제 해결형 업무에서 만족도와 성과가 함께 올라갈 가능성이 큽니다."),
          named("나의 직장운", "직장운은 조직 안에서 신뢰를 쌓는 흐름과 연결되기 쉽습니다. 상사·동료와의 커뮤니케이션에서 '결론-근거-요청사항' 구조를 유지하면 불필요한 오해를 줄이고, 책임 있는 역할로 빠르게 확장될 가능성이 있습니다."),
          named("나의 사업운", "독립성과 실행력이 살아날 때 강점이 드러날 수 있지만, 속도가 너무 빨라지면 리스크도 커질 수 있습니다. 사업 흐름에서는 매출보다 현금흐름과 재투자 비율을 먼저 관리해야 하며, 파트너십 계약은 조건을 문서화해 분쟁 비용을 줄이는 것이 중요합니다."),
          named("십이신살과 귀인의 영향", "신살은 직업 변화나 환경 이동의 사건성으로, 귀인은 협업과 이직에서 도움을 받는 통로로 작용할 수 있습니다. 따라서 변동이 커지는 시기에는 혼자 결정하기보다 검증 가능한 조언과 데이터에 기반해 선택하면 시행착오를 줄일 수 있습니다."),
          named("성공적인 직장생활을 위한 조언", "중요한 대화 전에는 핵심 쟁점을 메모로 정리하고, 감정이 올라온 날에는 즉답보다 간격을 두는 방식이 도움이 됩니다. 또한 주간 단위로 '성과-리스크-다음 행동'을 리뷰하면 직무 안정성과 성장 속도를 동시에 끌어올리기 좋습니다."),
          named("종합분석", `${input.name}님의 직업운은 역할의 무게를 잘 버틸 수 있는 힘이 있지만, 오래 가려면 속도 조절과 소통 방식이 함께 필요합니다. 결국 커리어 성장은 능력 자체보다 역할 운영 능력에서 완성되므로, 기준을 명확히 하고 협업 품질을 높이는 전략이 가장 유효합니다.`),
        ].join("\n\n");
      }
      break;
    }
    case 10: {
      const salHealthNote = (name: string) => {
        const m: Record<string, string> = {
          역마살: "활동량이 늘 때 과로·수면 부족이 겹치기 쉬우니 이동 직후 회복 슬롯을 고정하는 편이 좋습니다.",
          육해살: "관계·말의 오해에서 오는 긴장이 몸으로 전이될 수 있으니 대화 전 정리와 호흡 루틴이 도움이 됩니다.",
          화개살: "생각이 많아지고 감각이 예민해질 때 수면 질이 흔들리기 쉬우니 낮 시간대 햇빛·가벼운 산책으로 리듬을 맞추면 좋습니다.",
          도화살: "대인 스케줄이 많아지면 피로가 눈에 덜 보일 수 있으니 주간 '무소식 반나절' 같은 회복일을 두는 편이 안전합니다.",
        };
        return m[name] ?? `${name}은 생활 리듬이나 환경 변화와 맞물릴 때 컨디션 변동을 키울 수 있으니 무리한 일정 연속은 피하는 편이 좋습니다.`;
      };
      const gwinHealthNote = (name: string) => {
        const m: Record<string, string> = {
          천을귀인: "몸이 무너질 듯한 시기에도 회복을 돕는 사람·정보·환경이 연결될 여지가 있습니다.",
          문창귀인: "지식·기록·상담을 통해 생활 습관을 바로잡을 단서를 얻기 쉽습니다.",
          천덕귀인: "주변의 배려와 지지가 회복 속도를 높이는 데 도움이 될 수 있습니다.",
        };
        return m[name] ?? `${name}은 건강 관리와 선택에서 조언·협력 통로로 작용할 수 있습니다.`;
      };
      if (ext) {
        const py = ext.pillars[3];
        const pm = ext.pillars[2];
        const pd = ext.pillars[1];
        const ph = ext.pillars[0];
        const yKr = input.saju.fourPillarsKorean.year;
        const mKr = input.saju.fourPillarsKorean.month;
        const dKr = input.saju.fourPillarsKorean.day;
        const hKr = input.saju.fourPillarsKorean.hour;
        const order = ["목", "화", "토", "금", "수"] as const;
        const sortedEl = [...order].sort((a, b) => ext.elementPcts[b] - ext.elementPcts[a]);
        const strong1 = sortedEl[0];
        const strong2 = sortedEl[1];
        const weakest = [...order].sort((a, b) => ext.elementPcts[a] - ext.elementPcts[b])[0];
        const sipAll = [py, pm, pd, ph].flatMap((x) => [x.sipseongStem, x.sipseongBranch]);
        const sipUnique = [...new Set(sipAll)].join(", ");
        const sipStressy = sipAll.some((s) => s === "상관" || s === "겁재" || s === "편관");
        const sipStabil = sipAll.some((s) => s === "정인" || s === "정관" || s === "편인");
        const yinLead = ext.yinYangPct.yin > ext.yinYangPct.yang;
        const yyDesc = yinLead
          ? `음의 기운이 양보다 높게 읽히며(음 ${ext.yinYangPct.yin}%, 양 ${ext.yinYangPct.yang}%), 안정·내면·회복 쪽 리듬을 중시하는 편이 몸과 잘 맞을 수 있습니다.`
          : `양의 기운이 음보다 높게 읽히며(양 ${ext.yinYangPct.yang}%, 음 ${ext.yinYangPct.yin}%), 활동과 발산 이후 반드시 쿨다운 시간을 넣는 편이 피로 누적을 줄입니다.`;
        const elLine = `오행 분포는 목 ${ext.elementPcts.목}%(${ext.elementCounts.목}개), 화 ${ext.elementPcts.화}%(${ext.elementCounts.화}개), 토 ${ext.elementPcts.토}%(${ext.elementCounts.토}개), 금 ${ext.elementPcts.금}%(${ext.elementCounts.금}개), 수 ${ext.elementPcts.수}%(${ext.elementCounts.수}개)로, 비교적 두드러지는 기운은 ${strong1}·${strong2} 쪽으로 읽을 수 있습니다.`;
        const stressLine = sipStressy
          ? "상관·겁재·편관 계열 십성이 끼어 있으면 감정 기복·경쟁·과속 실행이 스트레스로 몸에 쌓이기 쉬우니, 수면과 식사 시간을 먼저 지키는 것이 예방의 중심이 됩니다."
          : "십성 흐름이 한쪽으로 치우치면 그 방향의 과로(과한 책임·과한 표현 등)가 피로로 이어지기 쉬우니 주간 회복 슬롯을 고정하는 편이 좋습니다.";
        const recoverLine = sipStabil
          ? "정인·편인·정관 계열이 함께 있으면 체력이 떨어질 때 스스로 규칙을 되찾으려는 회복 탄력이 생기기 쉬우나, 기본 루틴을 소홀히 하면 그 효과가 반감됩니다."
          : "회복은 '큰 휴가'보다 매일의 수면·식사 규칙에서 좌우되는 경우가 많으니 작은 루틴부터 고정하는 편이 안전합니다.";
        const salUnique = [...new Set([py, pm, pd, ph].map((x) => x.sibisinsal))];
        const salBlock =
          `네 기둥에서 읽히는 십이신살은 ${salUnique.join(", ")}입니다. ` +
          salUnique.map((s) => `'${s}'는 ${salHealthNote(s)}`).join(" ");
        const gwinUnique = [...new Set([py, pm, pd, ph].flatMap((x) => x.gwin))];
        const gwinIntro =
          gwinUnique.length === 1
            ? `'${gwinUnique[0]}' 귀인이 회복 맥락에 작용할 수 있습니다. `
            : gwinUnique.length > 1
              ? `${gwinUnique.map((g) => `'${g}'`).join(", ")} 귀인이 함께 작용할 수 있습니다. `
              : "";
        const gwinBlock =
          gwinUnique.length > 0
            ? `${gwinIntro}` + gwinUnique.map((g) => `'${g}'는 ${gwinHealthNote(g)}`).join(" ")
            : "귀인이 비어 있는 기둥이 있으면 스스로 검진·상담·운동 코치처럼 신뢰할 통로를 만들어 두는 편이 건강 관리에 도움이 됩니다.";
        const flowPara = (stage: string, kr: string, p: typeof py) => {
          const u = formatSibiunseongKoHanja(p.sibiunseong);
          const peak = p.sibiunseong === "제왕" || p.sibiunseong === "건록";
          const low = p.sibiunseong === "병" || p.sibiunseong === "사" || p.sibiunseong === "묘" || p.sibiunseong === "절";
          const rhythm = peak
            ? "에너지가 강하게 올라갈 때 과로와 부족한 회복이 겹치기 쉬우니 수면을 먼저 확보하는 편이 좋습니다."
            : low
              ? "컨디션이 예민해지기 쉬운 리듬이므로 책임을 나누고 무리한 일정을 줄이는 편이 안전합니다."
              : "리듬이 바뀌는 구간이므로 운동 강도·식사 시간을 주간 단위로 점검하면 좋습니다.";
          return `${stage} : ${stage}를 상징하는 ${kr}(${p.stemHanja}${p.branchHanja})에는 십이운성 ${u}이 자리합니다. 천간 십성 ${p.sipseongStem}·지지 십성 ${p.sipseongBranch}의 흐름과 신살 ${p.sibisinsal}을 건강 관점에서 보면, ${rhythm}`;
        };
        const 호흡주의 =
          strong1 === "금" || strong2 === "금"
            ? "호흡·기도·건조 : 금(金) 기운이 상대적으로 강하게 읽히면 건조한 환경·환절기에 호흡과 피부 밸런스가 흔들리기 쉬우니 실내 습도·마스크·충분한 수분을 생활 습관으로 고정하는 편이 좋습니다."
            : "호흡·순환 : 장시간 앉은 자세와 얕은 호흡이 겹치면 두통·어깨 결림으로 이어지기 쉬우니 하루 두 번 깊은 호흡·가벼운 스트레칭을 넣으면 좋습니다.";
        const 신경주의 = sipStressy
          ? "신경·수면·스트레스 : 상관·겁재·편관 기운이 강하면 감정 기복과 과속 실행이 수면을 깨뜨리기 쉬우니, 취침 1시간 전 디지털 차단과 고정 취침 시각이 특히 중요합니다."
          : "신경·수면 : 업무 강도가 올라갈수록 수면이 먼저 줄어들기 쉬우니 '수면 최저선'을 주간 계획에 먼저 넣는 편이 좋습니다.";
        const 소화주의 =
          ph.branchElement === "토" || weakest === "토"
            ? "소화·리듬 : 시지나 오행에서 토 기운이 약하거나 말년 리듬이 무려질 때 소화 불편이 누적되기 쉬우니 저녁 식사 시간을 앞당기고 자극적인 야식을 줄이면 도움이 됩니다."
            : "소화·컨디션 : 스트레스가 길어지면 소화가 먼저 반응하는 경우가 많으니 규칙적인 식사와 천천히 씹는 습관을 우선하세요.";
        const coldWarm =
          strong1 === "수" || strong2 === "수" || strong1 === "금" || strong2 === "금"
            ? "차고 건조한 체감을 완화하려면 따뜻한 국물·해조류·생강·대추 차처럼 온기와 수분이 함께 드는 식재료를 주 3회 이상 섞는 편이 좋습니다. 늦은 밤 냉음식·과식은 순환과 수면을 함께 흔들 수 있으니 피하는 편이 안전합니다."
            : "규칙적인 식사와 단백질·채소 비율을 고정하면 피로 회복과 집중력 유지에 도움이 됩니다. 자극적인 음식·과도한 카페인은 수면 리듬을 깨기 쉬우니 오후 이후로 줄이면 좋습니다.";
        body = [
          named(
            "건강운 풀이",
            `${input.name}님의 건강운은 갑작스러운 이상보다 수면·식사·스트레스 관리가 조금씩 흔들리며 누적되는 패턴을 함께 보는 편이 더 정확합니다. ${dKr} 일주를 축으로 네 기둥의 십이운성과 신살 흐름을 건강 리듬에 겹쳐 읽으면, 어느 시기에 회복을 우선해야 하는지가 선명해집니다.`,
          ),
          named(
            "나의 건강운",
            `${yyDesc} ${elLine} 네 기둥에 나타나는 십성은 ${sipUnique}로 묶여 읽을 수 있습니다. ${stressLine} ${recoverLine} 이 장은 의학적 진단이 아니라 생활 예방 관점의 참고이며, 이상 징후가 지속되면 전문의 상담을 병행하는 것이 안전합니다.`,
          ),
          named("십이신살과 귀인의 영향", `${salBlock} ${gwinBlock} 변동이 큰 시기에는 회복을 먼저 확보하고, 필요하면 주변 도움을 요청하는 전략이 건강 손실을 줄입니다.`),
          named(
            "시기에 따른 나의 건강운",
            [flowPara("초년기", yKr, py), flowPara("청년기", mKr, pm), flowPara("중년기", dKr, pd), flowPara("말년기", hKr, ph)].join("\n\n"),
          ),
          named("주의해야 할 질병", `${호흡주의}\n\n${신경주의}\n\n${소화주의}`),
          named(
            "추천 운동",
            "유산소로 걷기·조깅·자전거처럼 순환을 돕는 활동을 주 3~4회, 20~40분 내에서 무리 없이 이어가면 컨디션 안정에 도움이 됩니다. 폐·긴장 완화에는 가벼운 요가·명상·호흡 연습을 주 2회 섞는 편이 좋습니다. 중년 이후에는 근력이 떨어지기 쉬우니 소근육·코어를 살리는 가벼운 근력과 스트레칭을 병행하세요.",
          ),
          named("추천 식단", coldWarm),
          named(
            "종합분석",
            `${input.name}님의 건강운은 ${strong1}·${strong2} 기운이 상대적으로 두드러질 때 호흡·순환·스트레스 반응이 함께 움직이기 쉬운 구조로 읽을 수 있습니다. 십이신살(${salUnique.join(", ")})과 귀인(${gwinUnique.join(", ") || "해당없음"})은 변동과 회복 통로를 동시에 보여 주니, 무리한 일정보다 루틴을 먼저 고정하고 회복일을 주간에 넣는 태도가 가장 현실적인 관리입니다. 작은 신호(수면·소화·두통)를 초기에 조정하면 큰 무너짐으로 번질 가능성을 낮출 수 있습니다.`,
          ),
        ].join("\n\n");
      } else {
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
      }
      break;
    }
    case 11: {
      const daewoon = ext ? computeDaewoonTable(input.saju.fourPillarsKorean, ext.dayStem, input.gender) : null;
      if (daewoon && ext) {
        const pd = ext.pillars[1];
        const dayStemFull = stemElementFullLabel(pd.stemKorean, pd.stemHanja, ext.dayStemElement);
        const intro = `이 표는 ${input.name}님의 대운표입니다. 대운수는 ${daewoon.daewoonsu}세부터 시작해 10년마다 흐름이 바뀌며, 각 칸의 천간·지지·십성·십이운성을 함께 보면 그 10년의 과제와 속도감이 선명해집니다. 아래에서는 각 연령대마다 천간·지지의 상생·상극, 십성, 십이운성을 샘플과 같은 밀도로 풀어 이어갑니다.`;
        body = [
          intro,
          ...daewoon.columns.map((c, i) => {
            const stemLabel = stemElementFullLabel(c.stem, c.stemHanja, c.stemElement);
            const branchLabel = stemElementFullLabel(c.branch, c.branchHanja, c.branchElement);
            const pOpen = `이번 대운의 천간은 ${c.stemHanja}(${c.stem}), 지지는 ${c.branchHanja}(${c.branch})입니다.`;
            const pStem = daewoonElementRelationParagraph(
              input.name,
              ext.dayStemElement,
              c.stemElement,
              stemLabel,
              "천간",
              dayStemFull,
            );
            const pBranch = daewoonElementRelationParagraph(
              input.name,
              ext.dayStemElement,
              c.branchElement,
              branchLabel,
              "지지",
              dayStemFull,
            );
            const pSiS = daewoonSipseongStemParagraph(input.name, c.sipseongStem);
            const pSiB = daewoonSipseongBranchParagraph(input.name, c.sipseongBranch);
            const u = formatSibiunseongKoHanja(c.sibiunseong);
            const peak = c.sibiunseong === "제왕" || c.sibiunseong === "건록";
            const low = ["병", "사", "쇠", "묘", "절"].includes(c.sibiunseong);
            const uRhythm = peak
              ? "에너지가 크게 올라가기 쉬워 과로와 회복 부족에 주의해야 합니다."
              : low
                ? "에너지가 정리·충전 쪽으로 기울기 쉬워, 성급한 추진보다 점검과 계획이 맞을 수 있습니다."
                : "흐름이 바뀌는 구간이므로 준비와 실행의 균형을 맞추는 편이 유리합니다.";
            const pU = `십이운성은 ${u}입니다. ${c.sibiunseong}운은 ${uRhythm} ${input.name}님은 이 시기에 규칙적인 수면과 식사를 지키고 과로를 줄이면 컨디션을 지키기 좋습니다.`;
            const pEnd = `정리보면 ${daewoon.ages[i]}세 대운은 ${input.name}님이 ${c.sipseongStem}·${c.sipseongBranch}의 기운을 어떻게 균형 있게 쓰느냐에 따라 체감 차이가 크게 벌어질 수 있는 시기입니다. 재물·학업·관계를 한꺼번에 잡으려 하기보다 순서를 정하고 에너지를 나누면 안정적으로 흐름을 활용하기 좋습니다.`;
            return [`나의 ${daewoon.ages[i]}세 대운`, [pOpen, pStem, pBranch, pSiS, pSiB, pU, pEnd].join("\n\n")].join("\n\n");
          }),
        ].join("\n\n");
      } else {
        body = `${input.name}님, 대운은 10년 단위의 큰 흐름을 보여주는 장입니다. 이 장에서는 시기마다 강조되는 역할과 속도 조절 포인트를 함께 보는 방식이 중요합니다.`;
      }
      break;
    }
    case 12: {
      const yeonun = ext ? computeYeonunTable(ext.dayStem, new Date().getFullYear()) : null;
      if (yeonun && ext) {
        const pd = ext.pillars[1];
        const dayStemFull = stemElementFullLabel(pd.stemKorean, pd.stemHanja, ext.dayStemElement);
        const y0 = new Date().getFullYear();
        const intro = `이 표는 ${input.name}님의 연운표입니다. 연운은 매해 바뀌는 연간 간지(년주)의 분위기로, ${y0}년부터 이어지는 여섯 해 동안 외부 환경·역할·감정 리듬이 어떻게 달라지는지를 한 해씩 세밀하게 읽는 데 쓰입니다. 아래는 각 연도마다 천간·지지의 오행과 일간의 관계, 십성, 십이운성을 샘플과 비슷한 밀도로 풀어 이어갑니다.`;
        body = [
          intro,
          ...yeonun.columns.map((c) => {
            const stemComp = stemBranchElementCompound(c.stem, c.stemElement);
            const branchComp = stemBranchElementCompound(c.branch, c.branchElement);
            return [
              `나의 ${c.year}년 연운`,
              `나의 ${c.year}년 연운 : 천간 ${c.stem}`,
              yeonunStemSectionBody(input.name, c.year, c, dayStemFull, ext.dayStemElement),
              `나의 ${c.year}년 연운 : 지지 ${c.branch}`,
              yeonunBranchSectionBody(input.name, c.year, c, dayStemFull, ext.dayStemElement),
              `나의 ${c.year}년 연운 : 천간 십성 ${c.sipseongStem}`,
              yeonunSipseongStemExtendedBody(input.name, c.year, c.sipseongStem),
              `나의 ${c.year}년 연운 : 지지 십성 ${c.sipseongBranch}`,
              yeonunSipseongBranchExtendedBody(
                input.name,
                c.year,
                c.sipseongBranch,
                c.branchHanja,
                c.branch,
              ),
              `나의 ${c.year}년 연운 : 십이운성 ${c.sibiunseong}`,
              yeonunSibiunseongExtendedBody(input.name, c.year, c.sibiunseong),
              `나의 ${c.year}년 연운 종합`,
              yeonunYearSummaryBody(input.name, c.year, c, stemComp, branchComp),
            ].join("\n\n");
          }),
        ].join("\n\n");
      } else {
        body = `${input.name}님, 연운은 해마다 달라지는 세부 흐름을 읽는 장입니다. 이 장에서는 결과보다 선택의 순서와 감정 조절 방식을 함께 보는 것이 중요합니다.`;
      }
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
  sectionExcerpts?: Array<{ title: string; excerpt: string }>,
): Promise<z.infer<typeof tailSchema>> {
  const prompt = buildTailPrompt(input, sectionExcerpts);
  try {
    return await callProviderJsonWithRetry({
      provider,
      prompt,
      schema: tailSchema,
      stage: "tail",
      maxTokens: 4000,
      debugCapture,
      maxAttempts: 3,
      llmOptions,
    });
  } catch (err) {
    if (err instanceof LlmRequestError) {
      return buildFallbackTail(input);
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
  sectionExcerpts?: Array<{ title: string; excerpt: string }>,
): Promise<ReportTailPart> {
  return generateTail(resolveRequestedProvider(llmOptions), input, debugCapture, llmOptions, sectionExcerpts);
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
