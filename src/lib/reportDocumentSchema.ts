/**
 * 사주 리포트 전용 문서 스키마.
 * LLM/파이프라인은 이 형식으로 출력하고, 렌더러는 블록 타입별로 HTML+CSS 적용.
 * 확장 시 Block 타입만 추가하면 됨.
 */

/** 오행 (표·카드 색상용) */
export type FiveElementKey = "목" | "화" | "토" | "금" | "수";

/** 1장 부표지: 한 페이지 전체 사용 */
export type ChapterSubcoverBlock = {
  type: "chapterSubcover";
  title: string;
  paragraphs: string[];
};

/** 장 시작 풀페이지 이미지 (1~12장 타이틀 이미지) */
export type ChapterImagePageBlock = {
  type: "chapterImagePage";
  src: string;
  alt?: string;
};

/** 2장 상단: 동물 이미지 + 인적사항 */
export type ProfileWithAnimalBlock = {
  type: "profileWithAnimal";
  animalImageSrc: string;
  animalLabel: string;
  name: string;
  gender: string;
  birthLabel: string;
  calendarLabel: string;
  dayElementStem: string;
  dayAnimalLabel: string;
  disclaimer: string;
};

/** 사주원국 표 (셀별 오행 배경색) */
export type SajuTableStyledBlock = {
  type: "sajuTableStyled";
  columns: string[];
  rows: string[][];
  /** cellElements[r][c]: c>=1 일 때 해당 셀 배경색 (목/화/토/금/수) */
  cellElements: (FiveElementKey | null)[][];
  /** 강조할 열 인덱스 (0-based, 예: 2 = 일주). 3장 일주로 보는 나의 성격에서 사용 */
  highlightColumnIndex?: number;
  /** 강조할 행 인덱스 (0-based). 4장 십성 분석에서 십성·십성(지지) 행 강조 */
  highlightRowIndices?: number[];
};

/** 나의 오행: 5개 요소 카드 (퍼센트·개수) */
export type ElementCardsBlock = {
  type: "elementCards";
  dayStemLabel: string;
  items: { element: FiveElementKey; pct: number; count: number }[];
};

/** 나의 오행: 원형 다이어그램 (상생/상극 화살표, 퍼센트·개수) */
export type ElementWheelBlock = {
  type: "elementWheel";
  dayStemLabel: string;
  personName: string;
  items: { element: FiveElementKey; pct: number; count: number }[];
};

/** 음양 비율 바 */
export type YinYangBarBlock = {
  type: "yinYangBar";
  yangPct: number;
  yinPct: number;
};

/** 11장 나의 대운: 대운표 (대운수, 10개 연령별 천간·지지·십성·십이운성) */
export type DaewoonTableBlock = {
  type: "daewoonTable";
  daewoonsu: number;
  firstPillarLabel: string;
  ages: number[];
  columns: {
    stem: string;
    branch: string;
    sipseongStem: string;
    stemHanja: string;
    branchHanja: string;
    sipseongBranch: string;
    sibiunseong: string;
    stemElement: FiveElementKey;
    branchElement: FiveElementKey;
  }[];
};

/** 11장 나의 대운: 개별 대운 상세 표 (각 나이별 1칸 요약) */
export type DaewoonDetailTableBlock = {
  type: "daewoonDetailTable";
  age: number;
  sipseongStem: string;
  stem: string;
  stemHanja: string;
  branch: string;
  branchHanja: string;
  sipseongBranch: string;
  sibiunseong: string;
  stemElement: FiveElementKey;
  branchElement: FiveElementKey;
};

/** 12장 나의 6년간 연운: 연운표 (6개 연도별 천간·지지·십성·십이운성) */
export type YeonunTableBlock = {
  type: "yeonunTable";
  columns: {
    year: number;
    stem: string;
    sipseongStem: string;
    stemHanja: string;
    branch: string;
    branchHanja: string;
    sipseongBranch: string;
    sibiunseong: string;
    stemElement: FiveElementKey;
    branchElement: FiveElementKey;
  }[];
};

/** 12장 나의 6년간 연운: 개별 연도 상세 표 */
export type YeonunDetailTableBlock = {
  type: "yeonunDetailTable";
  year: number;
  sipseongStem: string;
  stem: string;
  stemHanja: string;
  branch: string;
  branchHanja: string;
  sipseongBranch: string;
  sibiunseong: string;
  stemElement: FiveElementKey;
  branchElement: FiveElementKey;
};

/** 마지막 꼬리: 브랜드 마무리 문구 (최대감사주 등) */
export type BrandClosingBlock = {
  type: "brandClosing";
  brandName: string;
  paragraphs: string[];
};

export type Block =
  | { type: "title"; text: string }
  | { type: "subtitle"; text: string }
  | { type: "paragraph"; text: string }
  | { type: "keywords"; items: string[] }
  | { type: "bulletList"; title?: string; items: string[] }
  | { type: "orderedList"; title?: string; items: string[] }
  | { type: "scoreBlock"; title: string; score: number; maxScore?: number }
  | { type: "table"; columns: string[]; rows: string[][] }
  | { type: "keyValue"; pairs: Array<{ key: string; value: string }> }
  | { type: "divider" }
  | { type: "footer"; text: string }
  | { type: "image"; src: string; alt?: string; caption?: string }
  | ChapterSubcoverBlock
  | ChapterImagePageBlock
  | ProfileWithAnimalBlock
  | SajuTableStyledBlock
  | ElementCardsBlock
  | ElementWheelBlock
  | DaewoonTableBlock
  | DaewoonDetailTableBlock
  | YeonunTableBlock
  | YeonunDetailTableBlock
  | BrandClosingBlock
  | YinYangBarBlock;

export type ReportDocument = {
  id?: string;
  title: string;
  subtitle?: string;
  metadata?: {
    author?: string;
    createdAt?: string;
    language?: string;
    subject?: string;
    keywords?: string[];
  };
  /** 렌더 순서대로 나열. 페이지 브레이크는 block type 또는 wrapper로 제어 */
  blocks: Block[];
};

export function isBlockType<T extends Block["type"]>(
  block: Block,
  type: T,
): block is Extract<Block, { type: T }> {
  return block.type === type;
}
