/**
 * 만세력 기반 확장 데이터: 십성, 십이운성, 십이신살, 귀인, 일주동물, 오행비율
 * fourPillars 한글만으로 계산 (천간=첫글자, 지지=둘째글자)
 */
import {
  HEAVENLY_STEMS,
  HEAVENLY_STEMS_HANJA,
  EARTHLY_BRANCHES,
  EARTHLY_BRANCHES_HANJA,
  getHeavenlyStemElement,
  getHeavenlyStemYinYang,
  getEarthlyBranchElement,
  getEarthlyBranchYinYang,
  type HeavenlyStem,
  type EarthlyBranch,
  type FiveElement,
  type YinYang,
} from "manseryeok";

const STEM_INDEX: Record<string, number> = {};
HEAVENLY_STEMS.forEach((s, i) => {
  STEM_INDEX[s] = i;
});
const BRANCH_INDEX: Record<string, number> = {};
EARTHLY_BRANCHES.forEach((b, i) => {
  BRANCH_INDEX[b] = i;
});

function parsePillar(korean: string): { stem: HeavenlyStem; branch: EarthlyBranch } | null {
  if (korean.length < 2) return null;
  const s = korean[0] as HeavenlyStem;
  const b = korean[1] as EarthlyBranch;
  if (HEAVENLY_STEMS.includes(s) && EARTHLY_BRANCHES.includes(b)) {
    return { stem: s, branch: b };
  }
  return null;
}

/** 오행 상생: 목→화→토→금→수→목 */
const ELEMENT_PRODUCES: Record<FiveElement, FiveElement> = {
  목: "화",
  화: "토",
  토: "금",
  금: "수",
  수: "목",
};
/** 오행 상극: 목克土, 土克水, 水克火, 火克金, 金克木 */
const ELEMENT_OVERCOMES: Record<FiveElement, FiveElement> = {
  목: "토",
  토: "수",
  수: "화",
  화: "금",
  금: "목",
};

/** 十星: 일간 대비 타 천간의 십성 */
const SIPSEONG_NAMES: Record<string, string> = {
  bijeon: "비견",
  geopjae: "겁재",
  siksin: "식신",
  sangwan: "상관",
  pyeonjae: "편재",
  jeongjae: "정재",
  pyeongwan: "편관",
  jeonggwan: "정관",
  pyeonin: "편인",
  jeongin: "정인",
};

function getSipseong(
  dayStem: HeavenlyStem,
  targetStem: HeavenlyStem,
): string {
  const dayEl = getHeavenlyStemElement(dayStem);
  const dayYY = getHeavenlyStemYinYang(dayStem);
  const el = getHeavenlyStemElement(targetStem);
  const yy = getHeavenlyStemYinYang(targetStem);
  const sameYy = dayYY === yy;
  const sameEl = dayEl === el;
  if (sameEl) {
    return sameYy ? SIPSEONG_NAMES.bijeon : SIPSEONG_NAMES.geopjae;
  }
  const producesMe = ELEMENT_PRODUCES[el] === dayEl;
  const iProduce = ELEMENT_PRODUCES[dayEl] === el;
  const overcomesMe = ELEMENT_OVERCOMES[el] === dayEl;
  const iOvercome = ELEMENT_OVERCOMES[dayEl] === el;
  if (producesMe) return sameYy ? SIPSEONG_NAMES.pyeonin : SIPSEONG_NAMES.jeongin;
  if (iProduce) return sameYy ? SIPSEONG_NAMES.siksin : SIPSEONG_NAMES.sangwan;
  if (iOvercome) return sameYy ? SIPSEONG_NAMES.pyeonjae : SIPSEONG_NAMES.jeongjae;
  if (overcomesMe) return sameYy ? SIPSEONG_NAMES.pyeongwan : SIPSEONG_NAMES.jeonggwan;
  return "-";
}

/** 지지 藏干 本氣 (해당 지지의 대표 천간) */
const BRANCH_HIDDEN_STEM: Record<EarthlyBranch, HeavenlyStem> = {
  자: "계",
  축: "기",
  인: "갑",
  묘: "을",
  진: "무",
  사: "병",
  오: "정",
  미: "기",
  신: "경",
  유: "신",
  술: "무",
  해: "임",
};

/** 십이운성 (日干 기준 地支별): 長生~養 */
const SIBIUNSEONG_TABLE: Record<HeavenlyStem, EarthlyBranch[]> = {
  갑: ["해", "자", "축", "인", "묘", "진", "사", "오", "미", "신", "유", "술"],
  을: ["오", "사", "진", "묘", "인", "축", "자", "해", "술", "유", "신", "미"],
  병: ["인", "묘", "진", "사", "오", "미", "신", "유", "술", "해", "자", "축"],
  정: ["유", "신", "미", "오", "사", "진", "묘", "인", "축", "자", "해", "술"],
  무: ["인", "묘", "진", "사", "오", "미", "신", "유", "술", "해", "자", "축"],
  기: ["유", "신", "미", "오", "사", "진", "묘", "인", "축", "자", "해", "술"],
  경: ["사", "오", "미", "신", "유", "술", "해", "자", "축", "인", "묘", "진"],
  신: ["자", "해", "술", "유", "신", "미", "오", "사", "진", "묘", "인", "축"],
  임: ["유", "술", "해", "자", "축", "인", "묘", "진", "사", "오", "미", "신"],
  계: ["오", "미", "신", "유", "술", "해", "자", "축", "인", "묘", "진", "사"],
};

const SIBIUNSEONG_NAMES = ["장생", "목욕", "관대", "건록", "제왕", "쇠", "병", "사", "묘", "절", "태", "양"];

function getSibiunseong(dayStem: HeavenlyStem, branch: EarthlyBranch): string {
  const row = SIBIUNSEONG_TABLE[dayStem];
  if (!row) return "-";
  const idx = EARTHLY_BRANCHES.indexOf(branch);
  if (idx < 0) return "-";
  return SIBIUNSEONG_NAMES[row.indexOf(branch)] ?? "-";
}

/** 기둥 위치별 십이신살 (PDF 형식: 시=화개, 일=육해, 월=역마, 연=년) */
const SIBISINSAL_BY_POSITION: Record<number, string> = {
  0: "화개살",
  1: "육해살",
  2: "역마살",
  3: "년살",
};

function getSibisinsal(_branch: EarthlyBranch, position: number): string {
  return SIBISINSAL_BY_POSITION[position] ?? "-";
}

/** 귀인: 天乙貴人 (천간 인덱스 0~9 → 해당 귀인 지지). 갑0→축미, 을1→자신, 병2정3→해유, 무4→축미, 기5→자신, 경6신7→인오, 임8계9→묘사 */
const CHEONILGWIN_BY_INDEX: EarthlyBranch[][] = [
  ["축", "미"],   // 0 갑
  ["자", "신"],   // 1 을
  ["해", "유"],   // 2 병
  ["해", "유"],   // 3 정
  ["축", "미"],   // 4 무
  ["자", "신"],   // 5 기
  ["인", "오"],   // 6 경
  ["인", "오"],   // 7 신
  ["묘", "사"],   // 8 임
  ["묘", "사"],   // 9 계
];
/** 문창귀인: 甲→巳, 乙→午, ... (천간 인덱스 0~9) */
const MUNCHANGGWIN_BY_INDEX: EarthlyBranch[] = ["사", "오", "신", "유", "신", "유", "해", "자", "인", "묘"];

function getGwin(dayStem: HeavenlyStem, branch: EarthlyBranch): string[] {
  const g: string[] = [];
  const stemIdx = STEM_INDEX[dayStem as string];
  if (stemIdx == null) return g;
  const cheonil = CHEONILGWIN_BY_INDEX[stemIdx];
  const munchang = MUNCHANGGWIN_BY_INDEX[stemIdx];
  if (cheonil?.includes(branch)) g.push("천을귀인");
  if (munchang === branch) g.push("문창귀인");
  return g;
}

/** 지지 → 동물 */
const BRANCH_ANIMAL: Record<EarthlyBranch, string> = {
  자: "쥐",
  축: "소",
  인: "호랑이",
  묘: "토끼",
  진: "용",
  사: "뱀",
  오: "말",
  미: "양",
  신: "원숭이",
  유: "닭",
  술: "개",
  해: "돼지",
};

/** 오행 → 색 (일주 동물 표현용) */
const ELEMENT_COLOR: Record<FiveElement, string> = {
  목: "푸른",
  화: "빨간",
  토: "노란",
  금: "하얀",
  수: "검은",
};

export type PillarKorean = { year: string; month: string; day: string; hour: string };
export type ExtendedPillar = {
  stemKorean: string;
  stemHanja: string;
  branchKorean: string;
  branchHanja: string;
  stemElement: FiveElement;
  stemYinYang: YinYang;
  branchElement: FiveElement;
  branchYinYang: YinYang;
  sipseongStem: string;
  sipseongBranch: string;
  sibiunseong: string;
  sibisinsal: string;
  gwin: string[];
};

export type SajuExtendedResult = {
  pillars: [ExtendedPillar, ExtendedPillar, ExtendedPillar, ExtendedPillar]; // 시 주 일 월 연
  dayStem: HeavenlyStem;
  dayBranch: EarthlyBranch;
  dayStemElement: FiveElement;
  dayStemYinYang: YinYang;
  dayAnimal: string;
  dayAnimalLabel: string;
  elementCounts: Record<FiveElement, number>;
  elementPcts: Record<FiveElement, number>;
  yinYangCount: { yang: number; yin: number };
  yinYangPct: { yang: number; yin: number };
};

const PILLAR_ORDER: ("hour" | "day" | "month" | "year")[] = ["hour", "day", "month", "year"];

export function computeSajuExtended(pillarKorean: PillarKorean): SajuExtendedResult | null {
  const dayPillar = parsePillar(pillarKorean.day);
  if (!dayPillar) return null;

  const pillars: ExtendedPillar[] = [];
  const allElements: FiveElement[] = [];
  const allYinYang: YinYang[] = [];

  for (let i = 0; i < PILLAR_ORDER.length; i++) {
    const key = PILLAR_ORDER[i];
    const kr = pillarKorean[key];
    const p = parsePillar(kr);
    if (!p) return null;

    const stemIdx = STEM_INDEX[p.stem];
    const branchIdx = BRANCH_INDEX[p.branch];
    const stemHanja = HEAVENLY_STEMS_HANJA[stemIdx] ?? "";
    const branchHanja = EARTHLY_BRANCHES_HANJA[branchIdx] ?? "";
    const stemEl = getHeavenlyStemElement(p.stem);
    const stemYY = getHeavenlyStemYinYang(p.stem);
    const branchEl = getEarthlyBranchElement(p.branch);
    const branchYY = getEarthlyBranchYinYang(p.branch);

    allElements.push(stemEl, branchEl);
    allYinYang.push(stemYY, branchYY);

    const hiddenStem = BRANCH_HIDDEN_STEM[p.branch];
    const sipseongStem = getSipseong(dayPillar.stem, p.stem);
    const sipseongBranch = getSipseong(dayPillar.stem, hiddenStem);
    const sibiunseong = getSibiunseong(dayPillar.stem, p.branch);
    const sibisinsal = getSibisinsal(p.branch, i);
    const gwin = getGwin(dayPillar.stem, p.branch);

    pillars.push({
      stemKorean: p.stem,
      stemHanja,
      branchKorean: p.branch,
      branchHanja,
      stemElement: stemEl,
      stemYinYang: stemYY,
      branchElement: branchEl,
      branchYinYang: branchYY,
      sipseongStem,
      sipseongBranch,
      sibiunseong,
      sibisinsal,
      gwin,
    });
  }

  const elementCounts: Record<FiveElement, number> = { 목: 0, 화: 0, 토: 0, 금: 0, 수: 0 };
  for (const e of allElements) elementCounts[e]++;
  const total = allElements.length;
  const elementPcts: Record<FiveElement, number> = {} as Record<FiveElement, number>;
  (Object.keys(elementCounts) as FiveElement[]).forEach((k) => {
    elementPcts[k] = total > 0 ? Math.round((elementCounts[k] / total) * 100) : 0;
  });

  let yang = 0,
    yin = 0;
  for (const yy of allYinYang) {
    if (yy === "양") yang++;
    else yin++;
  }
  const yinYangPct = {
    yang: total > 0 ? Math.round((yang / total) * 100) : 0,
    yin: total > 0 ? Math.round((yin / total) * 100) : 0,
  };

  const dayStemEl = getHeavenlyStemElement(dayPillar.stem);
  const dayAnimal = BRANCH_ANIMAL[dayPillar.branch];
  const color = ELEMENT_COLOR[dayStemEl];
  const dayAnimalLabel = `${color} ${dayAnimal}`;

  return {
    pillars: pillars as [ExtendedPillar, ExtendedPillar, ExtendedPillar, ExtendedPillar],
    dayStem: dayPillar.stem,
    dayBranch: dayPillar.branch,
    dayStemElement: dayStemEl,
    dayStemYinYang: getHeavenlyStemYinYang(dayPillar.stem),
    dayAnimal,
    dayAnimalLabel,
    elementCounts,
    elementPcts,
    yinYangCount: { yang, yin },
    yinYangPct,
  };
}

/** 대운표 1열(10년) 데이터 */
export type DaewoonColumn = {
  stem: HeavenlyStem;
  branch: EarthlyBranch;
  stemHanja: string;
  branchHanja: string;
  sipseongStem: string;
  sipseongBranch: string;
  sibiunseong: string;
  stemElement: FiveElement;
  branchElement: FiveElement;
};

export type DaewoonTableResult = {
  /** 대운수 (1~10, 첫 대운 시작 나이 단위) */
  daewoonsu: number;
  /** 첫 대운 기둥 라벨 (한자, 예: 계해) */
  firstPillarLabel: string;
  /** 10개 연령 컬럼 (2, 12, 22, ...) */
  ages: number[];
  columns: DaewoonColumn[];
};

/**
 * 대운표 계산. 월주 기준으로 순행/역행하여 10개 기둥 생성.
 * 순행: 양년 남자 / 음년 여자. 역행: 음년 남자 / 양년 여자.
 */
export function computeDaewoonTable(
  pillarKorean: PillarKorean,
  dayStem: HeavenlyStem,
  gender: string,
  birthMonth?: number,
  birthDay?: number,
): DaewoonTableResult | null {
  const monthPillar = parsePillar(pillarKorean.month);
  const yearPillar = parsePillar(pillarKorean.year);
  if (!monthPillar || !yearPillar) return null;

  const yearYang = getHeavenlyStemYinYang(yearPillar.stem) === "양";
  const isMale = gender === "남자";
  const forward = (yearYang && isMale) || (!yearYang && !isMale);

  const si = STEM_INDEX[monthPillar.stem];
  const bi = BRANCH_INDEX[monthPillar.branch];
  const columns: DaewoonColumn[] = [];

  for (let k = 0; k < 10; k++) {
    const step = forward ? k : -k;
    const sIdx = (si + step + 100) % 10;
    const bIdx = (bi + step + 120) % 12;
    const stem = HEAVENLY_STEMS[sIdx] as HeavenlyStem;
    const branch = EARTHLY_BRANCHES[bIdx] as EarthlyBranch;
    const stemHanja = HEAVENLY_STEMS_HANJA[sIdx] ?? "";
    const branchHanja = EARTHLY_BRANCHES_HANJA[bIdx] ?? "";
    const hiddenStem = BRANCH_HIDDEN_STEM[branch];
    columns.push({
      stem,
      branch,
      stemHanja,
      branchHanja,
      sipseongStem: getSipseong(dayStem, stem),
      sipseongBranch: getSipseong(dayStem, hiddenStem),
      sibiunseong: getSibiunseong(dayStem, branch),
      stemElement: getHeavenlyStemElement(stem),
      branchElement: getEarthlyBranchElement(branch),
    });
  }

  const daewoonsu = birthMonth != null && birthDay != null
    ? (Math.abs(birthMonth * 31 + birthDay) % 10) || 10
    : 2;
  const ages = Array.from({ length: 10 }, (_, i) => daewoonsu + i * 10);
  const first = columns[0];
  const firstPillarLabel = `${first.stemHanja}(${first.stem})${first.branchHanja}(${first.branch})`;

  return { daewoonsu, firstPillarLabel, ages, columns };
}

/** 연운표 1열(1년) 데이터 */
export type YeonunColumn = {
  year: number;
  stem: HeavenlyStem;
  branch: EarthlyBranch;
  stemHanja: string;
  branchHanja: string;
  sipseongStem: string;
  sipseongBranch: string;
  sibiunseong: string;
  stemElement: FiveElement;
  branchElement: FiveElement;
};

export type YeonunTableResult = {
  years: number[];
  columns: YeonunColumn[];
};

/**
 * 6년 연운표 계산. 기준 연도부터 6개 연도의 연주(년주) 간지 + 십성·십이운성.
 * 연도 간지는 (year - 4) % 10 = 천간, (year - 4) % 12 = 지지.
 */
export function computeYeonunTable(
  dayStem: HeavenlyStem,
  startYear: number,
): YeonunTableResult {
  const years: number[] = [];
  const columns: YeonunColumn[] = [];

  for (let i = 0; i < 6; i++) {
    const year = startYear + i;
    const sIdx = (year - 4 + 100) % 10;
    const bIdx = (year - 4 + 120) % 12;
    const stem = HEAVENLY_STEMS[sIdx] as HeavenlyStem;
    const branch = EARTHLY_BRANCHES[bIdx] as EarthlyBranch;
    const stemHanja = HEAVENLY_STEMS_HANJA[sIdx] ?? "";
    const branchHanja = EARTHLY_BRANCHES_HANJA[bIdx] ?? "";
    const hiddenStem = BRANCH_HIDDEN_STEM[branch];
    years.push(year);
    columns.push({
      year,
      stem,
      branch,
      stemHanja,
      branchHanja,
      sipseongStem: getSipseong(dayStem, stem),
      sipseongBranch: getSipseong(dayStem, hiddenStem),
      sibiunseong: getSibiunseong(dayStem, branch),
      stemElement: getHeavenlyStemElement(stem),
      branchElement: getEarthlyBranchElement(branch),
    });
  }

  return { years, columns };
}
