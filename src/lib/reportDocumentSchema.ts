/**
 * 사주 리포트 전용 문서 스키마.
 * LLM/파이프라인은 이 형식으로 출력하고, 렌더러는 블록 타입별로 HTML+CSS 적용.
 * 확장 시 Block 타입만 추가하면 됨.
 */

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
  | { type: "image"; src: string; alt?: string; caption?: string };

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
