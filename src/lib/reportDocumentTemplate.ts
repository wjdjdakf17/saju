import type { ReportDocument, Block } from "@/lib/reportDocumentSchema";

export type DocumentRenderParams = {
  name: string;
  gender: string;
  calendarLabel: string;
  birthLabel: string;
  backgroundImageUrl?: string;
  footerLogoUrl?: string;
  sectionDividerImageUrl?: string;
};

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeCssUrl(s: string): string {
  return String(s).replace(/["'()\\\n\r]/g, "");
}

function renderBlock(block: Block): string {
  switch (block.type) {
    case "title":
      return `<div class="doc-block doc-title">${escapeHtml(block.text)}</div>`;
    case "subtitle":
      return `<div class="doc-block doc-subtitle">${escapeHtml(block.text)}</div>`;
    case "paragraph":
      return `<div class="doc-block doc-paragraph">${escapeHtml(block.text)}</div>`;
    case "keywords":
      return `<div class="doc-block doc-keywords">${block.items.map((k) => `<span class="doc-chip">${escapeHtml(k)}</span>`).join("")}</div>`;
    case "bulletList": {
      const titleHtml = block.title ? `<div class="doc-bulletList-title">${escapeHtml(block.title)}</div>` : "";
      const itemsHtml = block.items.map((i) => `<li class="doc-bulletList-item">${escapeHtml(i)}</li>`).join("");
      return `<div class="doc-block doc-bulletList">${titleHtml}<ul class="doc-bulletList-ul">${itemsHtml}</ul></div>`;
    }
    case "orderedList": {
      const titleHtml = block.title ? `<div class="doc-orderedList-title">${escapeHtml(block.title)}</div>` : "";
      const itemsHtml = block.items.map((i) => `<li class="doc-orderedList-item">${escapeHtml(i)}</li>`).join("");
      return `<div class="doc-block doc-orderedList">${titleHtml}<ol class="doc-orderedList-ol">${itemsHtml}</ol></div>`;
    }
    case "scoreBlock": {
      const max = block.maxScore ?? 100;
      const pct = Math.min(100, Math.max(0, (block.score / max) * 100));
      return `<div class="doc-block doc-scoreBlock">
        <div class="doc-scoreBlock-head">
          <span class="doc-scoreBlock-title">${escapeHtml(block.title)}</span>
          <div class="doc-scoreBar-wrap">
            <div class="doc-scoreBar" aria-hidden="true"><div class="doc-scoreBar-fill" style="width:${pct}%"></div></div>
            <span class="doc-scoreBar-num">${block.score}</span>
          </div>
        </div>
      </div>`;
    }
    case "table":
      return `<div class="doc-block doc-table-wrap">
        <table class="doc-table">
          <thead><tr>${block.columns.map((c) => `<th>${escapeHtml(c)}</th>`).join("")}</tr></thead>
          <tbody>${block.rows.map((row) => `<tr>${row.map((c) => `<td>${escapeHtml(c)}</td>`).join("")}</tr>`).join("")}</tbody>
        </table>
      </div>`;
    case "keyValue":
      return `<div class="doc-block doc-keyValue">${block.pairs.map((p) => `<div class="doc-kv-row"><span class="doc-kv-key">${escapeHtml(p.key)}</span><span class="doc-kv-val">${escapeHtml(p.value)}</span></div>`).join("")}</div>`;
    case "divider":
      return `<div class="doc-block doc-divider"></div>`;
    case "footer":
      return `<div class="doc-block doc-footer">${escapeHtml(block.text)}</div>`;
    case "image":
      return `<div class="doc-block doc-image"><img src="${escapeHtml(block.src)}" alt="${escapeHtml(block.alt ?? "")}" class="doc-img" />${block.caption ? `<span class="doc-img-caption">${escapeHtml(block.caption)}</span>` : ""}</div>`;
    default:
      return "";
  }
}

/** 문서 블록을 카드 단위로 묶음: 헤더 한 카드, 표/키밸류 각각, scoreBlock+bulletList 한 카드, 푸터 한 카드 */
function groupBlocksIntoCards(blocks: Block[]): Block[][] {
  const cards: Block[][] = [];
  let current: Block[] = [];

  const flush = () => {
    if (current.length) {
      cards.push([...current]);
      current = [];
    }
  };

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.type === "scoreBlock") {
      flush();
      current.push(b);
      if (blocks[i + 1]?.type === "bulletList") {
        current.push(blocks[i + 1]);
        i += 1;
      }
      flush();
      continue;
    }
    if (b.type === "table" || b.type === "footer") {
      flush();
      current.push(b);
      flush();
      continue;
    }
    if (b.type === "keyValue" && current.length > 0 && current[0].type === "keyValue" && current.every((x) => x.type === "keyValue")) {
      current.push(b);
      continue;
    }
    if (b.type === "keyValue") {
      flush();
      current.push(b);
      continue;
    }
    current.push(b);
  }
  flush();
  return cards;
}

const DOC_CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;500;600;700;800&display=swap');
  @page { size: A4; margin: 16mm; }
  :root {
    --doc-bg: #f5f0e8;
    --doc-card-bg: #ffffff;
    --doc-card-border: #e5e2dd;
    --doc-text: #1c1917;
    --doc-text-muted: #57534e;
    --doc-accent: #44403c;
    --doc-score-fill: #57534e;
    --doc-font: "Noto Sans KR", "Noto Sans CJK KR", "Malgun Gothic", "Apple SD Gothic Neo", sans-serif;
    --doc-line-height: 1.85;
    --doc-space: 1.25rem;
    --doc-radius: 12px;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    font-family: var(--doc-font);
    font-size: 15px;
    line-height: var(--doc-line-height);
    color: var(--doc-text);
    background: var(--doc-bg);
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .doc-page {
    position: relative;
    z-index: 1;
    max-width: 820px;
    margin: 0 auto;
    padding: 36px 40px 48px;
  }
  .doc-cover {
    min-height: 260mm;
    border-radius: var(--doc-radius);
    display: flex;
    align-items: flex-end;
    padding: 28px;
    break-after: page;
    page-break-after: always;
    background: rgba(30, 27, 24, 0.25);
    border: 1px solid rgba(255,255,255,0.12);
  }
  .doc-cover-inner {
    width: 100%;
    border-radius: 10px;
    background: rgba(30, 27, 24, 0.5);
    color: #fafaf9;
    padding: 20px 20px;
  }
  .doc-cover-eyebrow { font-size: 12px; letter-spacing: 0.1em; opacity: 0.9; margin: 0 0 8px; }
  .doc-cover-title { font-size: 32px; font-weight: 800; letter-spacing: -0.02em; margin: 0; line-height: 1.2; }
  .doc-cover-meta { font-size: 14px; opacity: 0.95; margin: 12px 0 0; }

  .doc-stack { display: block; }
  .doc-card {
    background: var(--doc-card-bg);
    border: 1px solid var(--doc-card-border);
    border-radius: var(--doc-radius);
    padding: 28px 36px;
    margin-bottom: 20px;
    box-shadow: 0 1px 2px rgba(0,0,0,0.04);
    break-inside: avoid;
    page-break-inside: avoid;
  }
  .doc-card:last-child { margin-bottom: 0; }
  .doc-card.doc-card--break { break-after: page; page-break-after: always; }

  .doc-block { margin-bottom: var(--doc-space); }
  .doc-block:last-child { margin-bottom: 0; }
  .doc-title { font-size: 20px; font-weight: 800; letter-spacing: -0.02em; color: var(--doc-text); margin-bottom: 8px; }
  .doc-subtitle { font-size: 14px; color: var(--doc-text-muted); margin-bottom: 14px; line-height: 1.7; }
  .doc-paragraph { font-size: 14px; color: var(--doc-text); line-height: 1.9; margin-bottom: 14px; }
  .doc-keywords { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
  .doc-chip {
    display: inline-block;
    padding: 6px 12px;
    border-radius: 6px;
    border: 1px solid #d6d3d1;
    background: #fafaf9;
    color: var(--doc-text-muted);
    font-size: 12px;
    font-weight: 600;
  }
  .doc-bulletList-title { font-size: 14px; font-weight: 700; margin-bottom: 12px; color: var(--doc-text); }
  .doc-bulletList-ul, .doc-orderedList-ol { margin: 0; padding: 0 0 0 20px; list-style: none; }
  .doc-bulletList-ul { padding-left: 28px; }
  .doc-bulletList-item, .doc-orderedList-item {
    position: relative;
    margin-bottom: 14px;
    padding-left: 8px;
    font-size: 14px;
    line-height: 1.9;
    color: var(--doc-text);
  }
  .doc-bulletList-item:last-child, .doc-orderedList-item:last-child { margin-bottom: 0; }
  .doc-bulletList-item::before {
    content: "ㅁ";
    position: absolute;
    left: -26px;
    top: 0.05em;
    font-size: 0.85em;
    font-weight: 700;
    color: var(--doc-accent);
    line-height: 1;
  }
  .doc-orderedList-ol { list-style: decimal; padding-left: 24px; }
  .doc-orderedList-item { list-style: decimal; margin-left: 0; padding-left: 4px; }

  .doc-scoreBlock { margin-bottom: 4px; }
  .doc-scoreBlock-head { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-bottom: 14px; }
  .doc-scoreBlock-title { font-size: 15px; font-weight: 700; color: var(--doc-text); flex: 1 1 auto; }
  .doc-scoreBar-wrap { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
  .doc-scoreBar { width: 80px; height: 10px; background: #e7e5e4; border-radius: 999px; overflow: hidden; }
  .doc-scoreBar-fill { height: 100%; background: var(--doc-score-fill); border-radius: 999px; }
  .doc-scoreBar-num { font-size: 14px; font-weight: 700; color: var(--doc-text); min-width: 28px; }

  .doc-table-wrap { overflow: hidden; border-radius: 10px; border: 1px solid var(--doc-card-border); margin-top: 8px; }
  .doc-table { width: 100%; border-collapse: collapse; font-size: 14px; }
  .doc-table th, .doc-table td { padding: 12px 14px; text-align: left; border-bottom: 1px solid #e7e5e4; }
  .doc-table th { background: #fafaf9; font-weight: 700; color: var(--doc-text-muted); }
  .doc-table tr:last-child td { border-bottom: 0; }
  .doc-table td { color: var(--doc-text); }

  .doc-keyValue { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .doc-kv-row { border: 1px solid #e7e5e4; border-radius: 10px; padding: 12px 14px; background: #fafaf9; }
  .doc-kv-key { display: block; font-size: 11px; color: var(--doc-text-muted); text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 6px; }
  .doc-kv-val { font-size: 14px; font-weight: 600; color: var(--doc-text); }

  .doc-footer { font-size: 12px; color: var(--doc-text-muted); line-height: 1.6; margin-top: 8px; }
  .doc-divider { height: 1px; background: #e7e5e4; margin: 20px 0; }
  .doc-image { text-align: center; margin: 16px 0; }
  .doc-img { max-width: 140px; height: auto; opacity: 0.85; }
  .doc-img-caption { display: block; font-size: 12px; color: var(--doc-text-muted); margin-top: 8px; }

  .doc-sectionDivider { text-align: center; margin: 20px 0; }
  .doc-sectionDivider img { max-width: 100px; height: auto; opacity: 0.65; }
  .doc-pageFooterLogo { position: fixed; right: 16mm; bottom: 8mm; width: 22mm; height: auto; z-index: 2; opacity: 0.9; }
`;

export function renderReportFromDocument(
  document: ReportDocument,
  params: DocumentRenderParams,
): string {
  const pageBgStyle = params.backgroundImageUrl
    ? `background-image: url('${escapeCssUrl(params.backgroundImageUrl)}');`
    : "background: linear-gradient(165deg, #d4c6ad 0%, #e8dfd0 50%, #d9cfc0 100%);";
  const footerLogoHtml = params.footerLogoUrl
    ? `<img class="doc-pageFooterLogo" src="${escapeHtml(params.footerLogoUrl)}" alt="" />`
    : "";
  const dividerHtml = params.sectionDividerImageUrl
    ? `<div class="doc-sectionDivider"><img src="${escapeHtml(params.sectionDividerImageUrl)}" alt="" /></div>`
    : "";

  const cards = groupBlocksIntoCards(document.blocks);
  let sectionIndex = 0;
  const cardsHtml = cards
    .map((cardBlocks) => {
      const isSectionCard = cardBlocks.some((b) => b.type === "scoreBlock");
      const breakAfter = isSectionCard && sectionIndex > 0 && sectionIndex % 2 === 0 ? " doc-card--break" : "";
      if (isSectionCard) sectionIndex++;

      const blockHtml = cardBlocks.map((b) => renderBlock(b)).join("");
      const cardHtml = `<div class="doc-card${breakAfter}">${blockHtml}</div>`;
      const addDivider = params.sectionDividerImageUrl && isSectionCard && sectionIndex < 14;
      return addDivider ? cardHtml + dividerHtml : cardHtml;
    })
    .join("");

  const coverMeta = `${params.birthLabel} · ${params.calendarLabel} · ${document.metadata?.createdAt ?? new Date().toISOString().slice(0, 10)}`;

  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(document.title)}</title>
  <style>${DOC_CSS}</style>
</head>
<body>
  <div class="doc-pageBg" style="position:fixed;inset:0;z-index:0;background-size:cover;background-position:center;${pageBgStyle}"></div>
  <div class="doc-pageOverlay" style="position:fixed;inset:0;z-index:0;background:rgba(255,255,255,0.65);"></div>
  ${footerLogoHtml}
  <div class="doc-page">
    <section class="doc-cover">
      <div class="doc-cover-inner">
        <p class="doc-cover-eyebrow">SAJU REPORT</p>
        <h1 class="doc-cover-title">${escapeHtml(params.name)}님 정통 평생 운세</h1>
        <p class="doc-cover-meta">${escapeHtml(coverMeta)}</p>
      </div>
    </section>
    <div class="doc-stack">
      ${cardsHtml}
    </div>
  </div>
</body>
</html>`;
}
