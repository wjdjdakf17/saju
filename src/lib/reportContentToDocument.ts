import type { ReportContent } from "@/lib/reportSchema";
import type { ReportDocument, Block, FiveElementKey } from "@/lib/reportDocumentSchema";
import type { SajuResult } from "@/lib/saju";
import { computeSajuExtended, computeDaewoonTable, computeYeonunTable, type DaewoonTableResult, type YeonunTableResult } from "@/lib/sajuExtended";
import { REPORT_CHAPTER_TITLES } from "@/lib/reportSchema";
import { ZODIAC_ICON_BY_BRANCH } from "@/lib/zodiacIcons";

function titleOnlyFromHeading(heading: string): string {
  return heading
    .replace(/^\s*\d{1,2}\.\s*/, "")
    .replace(/\s*\[[^\]]*\d{1,3}\s*\/\s*100\s*\]\s*$/, "")
    .trim() || heading;
}

/** 섹션 본문 문두에 고객 이름이 없으면 보정. LLM이 누락했을 때 신빙성 확보용. */
function ensureNameAtSectionStart(body: string, name: string): string {
  const t = body.trim();
  if (!t || !name.trim()) return body;
  const head = t.slice(0, 50);
  if (head.includes("님") || head.includes(name)) return body;
  return `${name}님, ${t}`;
}

function chapterTitleImageSrc(chapterNumber: number): string {
  return `src/asset/images/title/${chapterNumber}.png`;
}

function pushStructuredParagraphs(blocks: Block[], body: string, name: string): void {
  const normalized = ensureNameAtSectionStart(body, name)
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);

  const seen = new Set<string>();
  normalized.forEach((text) => {
    const marker = text.replace(/\s+/g, " ").trim();
    if (!marker || seen.has(marker)) return;
    const prev = blocks.at(-1);
    if (prev?.type === "paragraph") {
      const prevMarker = prev.text.replace(/\s+/g, " ").trim();
      if (prevMarker === marker) return;
    }
    seen.add(marker);
    blocks.push({ type: "paragraph", text });
  });
}

function splitDaewoonBody(body: string): { intro: string; items: string[] } {
  const normalized = body.replace(/\r\n/g, "\n").trim();
  if (!normalized) return { intro: "", items: [] };

  const headingMatches = [...normalized.matchAll(/(?=나의 \d+세 대운)/g)].map((match) => match.index ?? 0);
  if (headingMatches.length > 0) {
    const intro = normalized.slice(0, headingMatches[0]).trim();
    const items = headingMatches
      .map((start, idx) => normalized.slice(start, headingMatches[idx + 1] ?? normalized.length).trim())
      .filter(Boolean)
      .map((chunk) => chunk.replace(/^나의 \d+세 대운\s*/u, "").trim());
    return { intro, items };
  }

  const marker = "이번 대운의 천간은";
  const markerMatches = [...normalized.matchAll(new RegExp(`(?=${marker})`, "g"))].map((match) => match.index ?? 0);
  if (markerMatches.length === 0) return { intro: normalized, items: [] };

  const intro = normalized.slice(0, markerMatches[0]).trim();
  const items = markerMatches
    .map((start, idx) => normalized.slice(start, markerMatches[idx + 1] ?? normalized.length).trim())
    .filter(Boolean);

  return { intro, items };
}

function splitYeonunBody(body: string, years: number[]): { intro: string; items: string[] } {
  const normalized = body.replace(/\r\n/g, "\n").trim();
  if (!normalized) return { intro: "", items: [] };

  const yearStarts = years
    .map((year) => {
      const patterns = [
        `나의 ${year}년 연운\n`,
        `나의 ${year}년 연운\r\n`,
        `나의 ${year}년 연운 :`,
        `나의 ${year}년 연운`,
      ];
      const index = patterns
        .map((pattern) => normalized.indexOf(pattern))
        .filter((value) => value >= 0)
        .sort((a, b) => a - b)[0];
      return index == null ? null : { year, start: index };
    })
    .filter((item): item is { year: number; start: number } => item != null)
    .sort((a, b) => a.start - b.start);

  if (yearStarts.length > 0) {
    const intro = normalized.slice(0, yearStarts[0].start).trim();
    const items = years.map((year) => {
      const current = yearStarts.find((item) => item.year === year);
      if (!current) return "";
      const next = yearStarts.find((item) => item.start > current.start);
      const chunk = normalized.slice(current.start, next?.start ?? normalized.length).trim();
      return chunk.replace(new RegExp(`^나의 ${year}년 연운\\s*`, "u"), "").trim();
    });
    return { intro, items };
  }

  const marker = "나의 20";
  const markerMatches = [...normalized.matchAll(new RegExp(`(?=${marker})`, "g"))].map((match) => match.index ?? 0);
  if (markerMatches.length === 0) return { intro: normalized, items: [] };

  const intro = normalized.slice(0, markerMatches[0]).trim();
  const items = markerMatches
    .map((start, idx) => normalized.slice(start, markerMatches[idx + 1] ?? normalized.length).trim())
    .filter(Boolean);

  return { intro, items };
}

export type ContentToDocumentParams = {
  name: string;
  gender: string;
  calendarLabel: string;
  birthLabel: string;
  saju: SajuResult;
};

/** 1장 사주의 기초적인 이해 - 고정 안내 문단 (PDF 형식) */
const CHAPTER1_FIXED_PARAGRAPHS = [
  "안녕하세요. 본격적인 사주풀이에 앞서, 사주에 대해 간단한 설명드리고 시작할게요.",
  "사주(四柱)는 인간이 태어난 연(年), 월(月), 일(日), 시(時)의 네 가지 기둥을 의미하며, 이를 통해 인간의 운명과 길흉화복을 예측하는 동양의 전통 학문입니다. 통상 사주보다는 사주팔자(四柱八字)라는 단어가 더 익숙하실 텐데요, 이는 사주라는 네 개의 기둥이 총 여덟 글자로 구성되어 있기 때문입니다.",
  "연(年), 월(月), 일(日), 시(時)로 구성되는 네 개의 기둥은 다시 하늘과 땅으로 구분이 되는데요, 하늘은 곧 천간으로, 땅은 지지라고 부르게 됩니다. 예를 들면 누군가의 사주, 네 개의 기둥을 대표하는 기둥인 일주는 일주의 천간인 일간과 일주의 지지인 일지로 분리할 수 있습니다. 사주의 해석은 이로부터 시작됩니다.",
  "사주를 해석하는 방법은 다음과 같습니다. 먼저 연(年), 월(月), 일(日), 시(時)가 어떤 글자로 이루어져 있는지 확인해야 합니다. 사주는 음양오행(陰陽五行)의 원리에 따라 각각의 글자가 음과 양, 그리고 오행인 화(火), 수(水), 목(木), 금(金), 토(土)의 속성을 나눠 갖게 됩니다.",
  "옛날에 어른들께서 사주에 금이 많아 부자가 되겠다, 나무가 많아 아이들을 많이 낳겠다 할 때 그런 속성이지요. 화 수 목 금 토는 각각 음양 두 개의 면을 갖게 되는데, 이에 따라 같은 속성이더라도 해석이 달라질 수도 있답니다.",
  "사주는 단순히 여덟 글자로 구성된 누군가의 생년월일이 아닙니다. 본인의 과거, 현재, 미래를 내다보는 하나의 창이자 나침반, 삶의 지침이 되어주는 가장 오래되고 보증된 도구 중 하나입니다.",
  "근대의 많은 선현과 위인들도 사주를 통해 길을 찾고 미래를 보았던 것처럼, 어쩌면 지금의 사람들에게도 사주는 보이지 않던 미래를 보는 밝은 창이 되어주지 않을까 합니다.",
  "오랫동안 많은 이들의 지침이 되고 나침반이 되어줬던 사주에 대해서 알아보실 준비가 되셨을까요?",
  "바로 다음 장부터는 {{NAME}}님의 사주가 풀이될 예정입니다. 저희의 정성이 앞으로 길을 찾는 데 도움이 되기를 바라며, 다음 장에서 뵙겠습니다 :)",
];

/**
 * ReportContent + 메타 → ReportDocument (PDF 12장 구조)
 * 2장 사주원국 표는 extended(십성·십이운성·신살·귀인) 기반으로 생성.
 */
export function reportContentToDocument(
  content: ReportContent,
  params: ContentToDocumentParams,
): ReportDocument {
  const blocks: Block[] = [];
  const fpK = params.saju.fourPillars.korean;
  const extended = computeSajuExtended(fpK);
  const isExtended = extended != null;

  // ─── 목차 ───
  blocks.push({ type: "title", text: "목차" });
  blocks.push({
    type: "table",
    columns: ["장", "내용"],
    rows: REPORT_CHAPTER_TITLES.map((t, i) => [String(i + 1), t]),
  });

  // ─── 1장 사주의 기초적인 이해 ───
  blocks.push({
    type: "chapterImagePage",
    src: chapterTitleImageSrc(1),
    alt: "사주의 기초적인 이해",
  });
  CHAPTER1_FIXED_PARAGRAPHS.forEach((text) => {
    blocks.push({ type: "paragraph", text: text.replaceAll("{{NAME}}", params.name) });
  });

  // ─── 2장 나의 사주팔자 ───
  blocks.push({
    type: "chapterImagePage",
    src: chapterTitleImageSrc(2),
    alt: "나의 사주팔자",
  });

  let sajuTableData: { columns: string[]; rows: string[][]; cellElements: (FiveElementKey | null)[][] } | null = null;
  let daewoonTableData: DaewoonTableResult | null = null;
  let yeonunTableData: YeonunTableResult | null = null;
  let profileBlockData: Extract<Block, { type: "profileWithAnimal" }> | null = null;

  if (isExtended && extended) {
    const iconSrc = ZODIAC_ICON_BY_BRANCH[extended.dayBranch];
    profileBlockData = {
      type: "profileWithAnimal",
      animalImageSrc: iconSrc,
      animalLabel: extended.dayAnimalLabel,
      name: params.name,
      gender: params.gender,
      birthLabel: params.birthLabel,
      calendarLabel: params.calendarLabel,
      dayElementStem: params.saju.dayElement.stem,
      dayAnimalLabel: extended.dayAnimalLabel,
      disclaimer: "*일주 동물은 태어난 연도 띠가 아닌 일주의 지지가 나타내는 동물을 의미합니다.",
    };
    blocks.push(profileBlockData);

    const cols = ["시주", "일주", "월주", "연주"];
    const correctRows: string[][] = [
      ["십성", extended.pillars[0].sipseongStem, extended.pillars[1].sipseongStem, extended.pillars[2].sipseongStem, extended.pillars[3].sipseongStem],
      ["음양오행(천간)", ...extended.pillars.map((p) => `${p.stemHanja}(${p.stemYinYang}${p.stemElement})`)],
      ["천간", ...extended.pillars.map((p) => `${p.stemHanja}(${p.stemKorean})`)],
      ["지지", ...extended.pillars.map((p) => `${p.branchHanja}(${p.branchKorean})`)],
      ["음양오행(지지)", ...extended.pillars.map((p) => `${p.branchHanja}(${p.branchYinYang}${p.branchElement})`)],
      ["십성(지지)", ...extended.pillars.map((p) => p.sipseongBranch)],
      ["십이운성", ...extended.pillars.map((p) => p.sibiunseong)],
      ["십이신살", ...extended.pillars.map((p) => p.sibisinsal)],
      ["귀인", ...extended.pillars.map((p) => (p.gwin.length ? p.gwin.join(" · ") : "해당없음"))],
    ];
    const cellElements: (FiveElementKey | null)[][] = [
      [null, null, null, null, null],
      [null, extended.pillars[0].stemElement, extended.pillars[1].stemElement, extended.pillars[2].stemElement, extended.pillars[3].stemElement],
      [null, extended.pillars[0].stemElement, extended.pillars[1].stemElement, extended.pillars[2].stemElement, extended.pillars[3].stemElement],
      [null, extended.pillars[0].branchElement, extended.pillars[1].branchElement, extended.pillars[2].branchElement, extended.pillars[3].branchElement],
      [null, extended.pillars[0].branchElement, extended.pillars[1].branchElement, extended.pillars[2].branchElement, extended.pillars[3].branchElement],
      [null, null, null, null, null],
      [null, null, null, null, null],
      [null, null, null, null, null],
      [null, null, null, null, null],
    ];
    sajuTableData = { columns: ["구분", ...cols], rows: correctRows, cellElements };
    blocks.push({
      type: "sajuTableStyled",
      columns: sajuTableData.columns,
      rows: sajuTableData.rows,
      cellElements: sajuTableData.cellElements,
    });

    const dayStemHanja = extended.pillars[1].stemHanja;
    const dayStemLabel = `${dayStemHanja}(${extended.dayStemYinYang}${extended.dayStemElement})`;
    const elementKeys: FiveElementKey[] = ["목", "화", "토", "금", "수"];
    blocks.push({
      type: "elementWheel",
      dayStemLabel,
      personName: params.name,
      items: elementKeys.map((element) => ({
        element,
        pct: extended.elementPcts[element],
        count: extended.elementCounts[element],
      })),
    });

    blocks.push({
      type: "yinYangBar",
      yangPct: extended.yinYangPct.yang,
      yinPct: extended.yinYangPct.yin,
    });

    daewoonTableData = computeDaewoonTable(
      fpK,
      extended.dayStem,
      params.gender,
    );
    yeonunTableData = computeYeonunTable(extended.dayStem, new Date().getFullYear());

    blocks.push({
      type: "paragraph",
      text: "사주원국을 보았으니, 이제 음양오행(陰陽五行)에 대해서 좀 더 자세히 알아보도록 하겠습니다.",
    });
  } else {
    blocks.push({
      type: "paragraph",
      text: `${params.name}(${params.gender})\n${params.birthLabel} (${params.calendarLabel})\n오행: ${params.saju.dayElement.stem}`,
    });
    blocks.push({
      type: "table",
      columns: ["구분", "한글", "한자"],
      rows: [
        ["연주", fpK.year, params.saju.fourPillars.hanja.year.hanja],
        ["월주", fpK.month, params.saju.fourPillars.hanja.month.hanja],
        ["일주", fpK.day, params.saju.fourPillars.hanja.day.hanja],
        ["시주", fpK.hour, params.saju.fourPillars.hanja.hour.hanja],
      ],
    });
  }

  // 2장 해설 (content.sections[1])
  const sec2 = content.sections[1];
  if (sec2?.body?.trim()) {
    pushStructuredParagraphs(blocks, sec2.body, params.name);
  }

  // ─── 3~12장 (각각 제목 + 불릿) ───
  const ILJU_CHAPTER_INDEX = 2; // 3장 = sections[2] = 일주로 보는 나의 성격
  const SIPSEONG_CHAPTER_INDEX = 3; // 4장 = sections[3] = 십성 분석
  const SIPSEONG_ROW_INDICES = [0, 5]; // 십성, 십성(지지) 행
  const SIBIUNSEONG_CHAPTER_INDEX = 4; // 5장 = sections[4] = 십이운성 분석
  const SIBIUNSEONG_ROW_INDEX = 6; // 십이운성 행
  const SIBISINSAL_CHAPTER_INDEX = 5; // 6장 = sections[5] = 십이신살 및 귀인 분석
  const SIBISINSAL_GWIN_ROW_INDICES = [7, 8]; // 십이신살, 귀인 행
  const DAEWOON_CHAPTER_INDEX = 10; // 11장 = sections[10] = 나의 대운
  const YEONUN_CHAPTER_INDEX = 11; // 12장 = sections[11] = 나의 6년간 연운
  for (let i = 2; i < content.sections.length; i++) {
    const sec = content.sections[i];
    if (!sec) continue;
    const title = titleOnlyFromHeading(sec.heading);
    blocks.push({
      type: "chapterImagePage",
      src: chapterTitleImageSrc(i + 1),
      alt: `${i + 1}장 ${title}`,
    });
    if (i === ILJU_CHAPTER_INDEX && sajuTableData) {
      blocks.push({
        type: "sajuTableStyled",
        columns: sajuTableData.columns,
        rows: sajuTableData.rows,
        cellElements: sajuTableData.cellElements,
        highlightColumnIndex: 2,
      });
    }
    if (i === SIPSEONG_CHAPTER_INDEX && sajuTableData) {
      blocks.push({
        type: "sajuTableStyled",
        columns: sajuTableData.columns,
        rows: sajuTableData.rows,
        cellElements: sajuTableData.cellElements,
        highlightRowIndices: SIPSEONG_ROW_INDICES,
      });
    }
    if (i === SIBIUNSEONG_CHAPTER_INDEX && sajuTableData) {
      blocks.push({
        type: "sajuTableStyled",
        columns: sajuTableData.columns,
        rows: sajuTableData.rows,
        cellElements: sajuTableData.cellElements,
        highlightRowIndices: [SIBIUNSEONG_ROW_INDEX],
      });
    }
    if (i === SIBISINSAL_CHAPTER_INDEX && sajuTableData) {
      blocks.push({
        type: "sajuTableStyled",
        columns: sajuTableData.columns,
        rows: sajuTableData.rows,
        cellElements: sajuTableData.cellElements,
        highlightRowIndices: SIBISINSAL_GWIN_ROW_INDICES,
      });
    }
    if (i === DAEWOON_CHAPTER_INDEX && daewoonTableData) {
      blocks.push({
        type: "daewoonTable",
        daewoonsu: daewoonTableData.daewoonsu,
        firstPillarLabel: daewoonTableData.firstPillarLabel,
        ages: daewoonTableData.ages,
        columns: daewoonTableData.columns.map((col) => ({
          sipseongStem: col.sipseongStem,
          stem: col.stem,
          stemHanja: col.stemHanja,
          branch: col.branch,
          branchHanja: col.branchHanja,
          sipseongBranch: col.sipseongBranch,
          sibiunseong: col.sibiunseong,
          stemElement: col.stemElement,
          branchElement: col.branchElement,
        })),
      });

      if (sec.body?.trim()) {
        const { intro, items } = splitDaewoonBody(sec.body);
        if (intro) {
          pushStructuredParagraphs(blocks, intro, params.name);
        }

        daewoonTableData.columns.forEach((col, idx) => {
          blocks.push({
            type: "daewoonDetailTable",
            age: daewoonTableData.ages[idx],
            sipseongStem: col.sipseongStem,
            stem: col.stem,
            stemHanja: col.stemHanja,
            branch: col.branch,
            branchHanja: col.branchHanja,
            sipseongBranch: col.sipseongBranch,
            sibiunseong: col.sibiunseong,
            stemElement: col.stemElement,
            branchElement: col.branchElement,
          });

          const itemBody = items[idx];
          if (itemBody) {
            pushStructuredParagraphs(blocks, itemBody, params.name);
          }
        });
        continue;
      }
    }
    if (i === YEONUN_CHAPTER_INDEX && yeonunTableData) {
      blocks.push({
        type: "yeonunTable",
        columns: yeonunTableData.columns.map((col) => ({
          year: col.year,
          stem: col.stem,
          sipseongStem: col.sipseongStem,
          stemHanja: col.stemHanja,
          branch: col.branch,
          branchHanja: col.branchHanja,
          sipseongBranch: col.sipseongBranch,
          sibiunseong: col.sibiunseong,
          stemElement: col.stemElement,
          branchElement: col.branchElement,
        })),
      });

      if (sec.body?.trim()) {
        const { intro, items } = splitYeonunBody(sec.body, yeonunTableData.columns.map((col) => col.year));
        if (intro) {
          pushStructuredParagraphs(blocks, intro, params.name);
        }

        yeonunTableData.columns.forEach((col, idx) => {
          if (profileBlockData) {
            blocks.push({ ...profileBlockData });
          }
          blocks.push({
            type: "yeonunDetailTable",
            year: col.year,
            sipseongStem: col.sipseongStem,
            stem: col.stem,
            stemHanja: col.stemHanja,
            branch: col.branch,
            branchHanja: col.branchHanja,
            sipseongBranch: col.sipseongBranch,
            sibiunseong: col.sibiunseong,
            stemElement: col.stemElement,
            branchElement: col.branchElement,
          });

          const itemBody = items[idx];
          if (itemBody) {
            pushStructuredParagraphs(blocks, itemBody, params.name);
          }
        });
        continue;
      }
    }
    if (sec.body?.trim()) {
      pushStructuredParagraphs(blocks, sec.body, params.name);
    }
  }

  // ─── 오행 밸런스 (요약) ───
  blocks.push({ type: "title", text: "오행 밸런스" });
  blocks.push({ type: "paragraph", text: content.elementBalance.analysis });
  blocks.push({ type: "bulletList", items: content.elementBalance.tips });

  // ─── 면책 ───
  blocks.push({ type: "footer", text: content.disclaimer });

  // ─── 브랜드 마무리 (최대감사주) ───
  blocks.push({
    type: "brandClosing",
    brandName: "최대감사주",
    paragraphs: [
      "반갑습니다. 최대감사주를 찾아주셔서 감사합니다.",
      "사주는 삶을 돌아보는 작은 길잡이일 뿐, 모든 것을 정하는 것은 아니니 참고만 해 주세요.",
      "운세를 보다 보면 참 신기합니다. 결과보다 그 글을 읽는 동안 잠시 멈춰 서서 마음을 들여다보게 되니까요. 오늘의 글이 당신 하루에 조용한 위로 하나 놓고 갔으면 좋겠습니다.",
      "운이 좋든 조금 덜하든, 결국 삶은 당신이 만들어가는 이야기니까요.",
      "오늘도 당신의 하루가 누군가의 행운이 되기를 바랍니다.",
    ],
  });

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
