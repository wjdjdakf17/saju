import type { ReportContent } from "@/lib/reportSchema";
import { REPORT_CHAPTER_TITLES } from "@/lib/reportSchema";
import { computeSaju } from "@/lib/saju";
import type { SajuResult } from "@/lib/saju";

/** 샘플용 12장 구조 (PDF 형식) */
function buildSampleSections(): ReportContent["sections"] {
  const samples: Record<number, string[]> = {
    1: ["사주(四柱)는 연·월·일·시 네 기둥으로 운명을 살펴보는 동양의 학문입니다. 이제 고객님의 사주를 풀이해 드리겠습니다."],
    2: ["사주원국을 바탕으로 오행과 음양이 고객님에게 미치는 영향을 요약하면, 수와 금의 조화가 두드러집니다.", "일간을 중심으로 한 해석은 아래 각 장에서 자세히 다룹니다."],
    3: ["일주(일간+일지)는 성격의 핵심을 나타냅니다. 단단하고 결단력 있는 면과 유연하고 지혜로운 면이 조화를 이룹니다.", "목표를 향해 나아가되 주변과의 균형을 유지하는 것이 중요합니다."],
    4: ["연·월·일·시 각 기둥의 십성(비견, 식신, 상관, 편재, 정재, 편관, 정관, 편인, 정인, 겁재)이 일간과 어떤 관계인지 살펴보면 대인관계와 재물·직업운의 흐름을 파악할 수 있습니다."],
    5: ["십이운성(장생, 목욕, 관대, 건록, 제왕, 쇠, 병, 사, 묘, 절, 태, 양)은 인생 단계별 에너지를 나타냅니다. 현재 단계에 맞는 마음가짐과 행동을 하는 것이 좋습니다."],
    6: ["십이신살과 귀인(천을귀인, 문창귀인 등)이 있는 기둥은 그 시기 도움과 변화의 에너지를 나타냅니다. 귀인을 잘 활용하면 어려운 상황에서도 극복할 수 있습니다."],
    7: ["연애운과 결혼운은 일간 성격과 십성·신살의 조합으로 풀이합니다. 신뢰와 안정을 중시하는 성향이 있으며, 진심을 나누는 관계가 유리합니다."],
    8: ["재물운은 편재·정재·식상이 있는 기둥과 대운·연운을 함께 보아 판단합니다. 꾸준한 노력과 계획적인 관리가 재물을 키우는 데 도움이 됩니다."],
    9: ["직업운은 정관·편관·식상 등이 어우러진 구조를 봅니다. 체계적이고 책임감 있는 태도로 직장·사업에서 인정받을 수 있는 흐름입니다."],
    10: ["건강운은 오행 균형과 해당 시기 기운을 참고합니다. 스트레스 관리와 규칙적인 생활이 중요하며, 신장·호흡기·소화기 케어를 권합니다."],
    11: ["대운은 10년 단위의 큰 흐름입니다. 대운표를 참고해 현재 어떤 대운인지, 앞으로의 전환 시기를 파악하면 인생 계획에 도움이 됩니다."],
    12: ["연운은 매해 바뀌는 운의 흐름입니다. 최근 6년간 연운을 참고해 해당 연도에 유의할 점과 활약할 분야를 살펴보시면 됩니다."],
  };
  return REPORT_CHAPTER_TITLES.map((title, i) => ({
    heading: `${String(i + 1).padStart(2, "0")}. ${title}`,
    body: (samples[i + 1] ?? ["해당 장의 상세 풀이가 여기에 채워집니다."]).join("\n\n"),
  })) as ReportContent["sections"];
}

export const sampleReportContent: ReportContent = {
  title: "김장조님의 사주팔자 분석",
  summary: {
    oneLine: "김장조님의 사주팔자는 수와 토의 균형을 이루며, 양의 에너지가 강한 특징을 보입니다.",
    keywords: ["사주팔자", "명리학", "오행", "음양", "일주", "대운", "연운"],
    highlights: [
      "을해년·병자월·임진일·을사시로 구성된 사주원국",
      "일주(임진)를 중심으로 한 성격과 운세 해석",
      "12장 구성의 정통 사주 리포트 형식",
    ],
  },
  sections: buildSampleSections(),
  elementBalance: {
    analysis:
      "오행의 편중이 강할수록 특정 시기에는 성과가 빠르게 나타나지만, 반대 시기에는 피로와 시행착오가 늘 수 있습니다. 일정·수면·운동의 기본 루틴을 고정하면 운의 변동 폭을 줄이고 장기 성과를 안정화하는 데 도움이 됩니다.",
    tips: [
      "주간 단위 휴식 시간을 캘린더에 고정하세요.",
      "소화·순환·근골격계 컨디션을 점검하세요.",
      "수면 시간을 일정하게 유지하세요.",
      "카페인·야식·과음 빈도를 줄이세요.",
    ],
  },
  disclaimer: "본 문서는 참고용 해석이며, 의학·법률·투자에 대한 확정적 조언이 아닙니다.",
};

const sampleBirth = { year: 1995, month: 10, day: 9, hour: 10, minute: 0 };

export function getSampleSaju(): SajuResult {
  return computeSaju({
    calendar: "solar",
    birth: sampleBirth,
    isLeapMonth: false,
  });
}

export const sampleParams = {
  name: "김장조",
  gender: "남자",
  calendarLabel: "양력",
  birthLabel: "1995-10-09 10:00",
};
