import type { ReportContent } from "@/lib/reportSchema";
import type { ReportDocument, Block } from "@/lib/reportDocumentSchema";
import type { SajuResult } from "@/lib/saju";

function parseScoreFromHeading(heading: string): number | null {
  const m = heading.match(/(\d{1,3})\s*\/\s*100\s*\]/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
}

function titleOnlyFromHeading(heading: string): string {
  return heading.replace(/\s*\[[^\]]*\d{1,3}\s*\/\s*100\s*\]\s*$/, "").trim() || heading;
}

export type ContentToDocumentParams = {
  name: string;
  gender: string;
  calendarLabel: string;
  birthLabel: string;
  saju: SajuResult;
};

/**
 * 기존 ReportContent + 메타정보를 우리 포맷 ReportDocument로 변환.
 * 확장 시 Block 타입만 추가하고 여기 매핑만 넣으면 됨.
 */
export function reportContentToDocument(
  content: ReportContent,
  params: ContentToDocumentParams,
): ReportDocument {
  const fpK = params.saju.fourPillars.korean;
  const fpH = params.saju.fourPillars.hanja;
  const blocks: Block[] = [];

  // ─── 헤더 카드 (문서 제목 + 요약) ───
  blocks.push({ type: "title", text: content.title });
  if (content.summary.oneLine) {
    blocks.push({ type: "subtitle", text: content.summary.oneLine });
  }
  if (content.summary.keywords.length > 0) {
    blocks.push({ type: "keywords", items: content.summary.keywords });
  }
  if (content.summary.highlights.length > 0) {
    blocks.push({ type: "bulletList", title: "핵심 포인트", items: content.summary.highlights });
  }

  // ─── 기본 정보 (이름/생년) ───
  blocks.push({
    type: "keyValue",
    pairs: [
      { key: "이름 / 성별", value: `${params.name} · ${params.gender}` },
      { key: "생년월시", value: `${params.birthLabel} (만세력 기준 산출)` },
    ],
  });

  // ─── 사주팔자 표 ───
  blocks.push({
    type: "table",
    columns: ["구분", "한글", "한자"],
    rows: [
      ["연주", fpK.year, fpH.year.hanja],
      ["월주", fpK.month, fpH.month.hanja],
      ["일주", fpK.day, fpH.day.hanja],
      ["시주", fpK.hour, fpH.hour.hanja],
    ],
  });

  blocks.push({
    type: "keyValue",
    pairs: [
      { key: "오행(일간)", value: `천간=${params.saju.dayElement.stem} · 지지=${params.saju.dayElement.branch}` },
      { key: "음양(일간)", value: `천간=${params.saju.dayYinYang.stem} · 지지=${params.saju.dayYinYang.branch}` },
    ],
  });

  // ─── 중간 요약 표: 영역별 한눈에 보기 ───
  blocks.push({
    type: "table",
    columns: ["번호", "영역", "요약"],
    rows: content.sections.map((sec, i) => {
      const area = titleOnlyFromHeading(sec.heading);
      const summary = sec.bullets[0]?.replace(/\s+/g, " ").trim().slice(0, 50) ?? "-";
      return [String(i + 1), area, summary.length >= 50 ? `${summary}…` : summary];
    }),
  });

  // ─── 14개 섹션 (각각 scoreBlock + bulletList) ───
  for (const sec of content.sections) {
    const score = parseScoreFromHeading(sec.heading);
    const title = titleOnlyFromHeading(sec.heading);
    if (score != null) {
      blocks.push({ type: "scoreBlock", title, score, maxScore: 100 });
    } else {
      blocks.push({ type: "paragraph", text: title });
    }
    blocks.push({ type: "bulletList", items: sec.bullets });
  }

  // ─── 오행 밸런스 ───
  blocks.push({ type: "title", text: "오행 밸런스" });
  blocks.push({ type: "paragraph", text: content.elementBalance.analysis });
  blocks.push({ type: "bulletList", items: content.elementBalance.tips });

  // ─── 면책 ───
  blocks.push({ type: "footer", text: content.disclaimer });

  return {
    title: content.title,
    subtitle: content.summary.oneLine,
    metadata: {
      createdAt: new Date().toISOString().slice(0, 10),
      language: "ko",
      subject: "사주 리포트",
    },
    blocks,
  };
}
