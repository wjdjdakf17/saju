import type { ReportDocument, Block, FiveElementKey } from "@/lib/reportDocumentSchema";

export type DocumentRenderParams = {
  name: string;
  gender?: string;
  calendarLabel: string;
  birthLabel: string;
  backgroundImageUrl?: string;
  /** 2페이지(본문)부터 쓸 배경. 없으면 backgroundImageUrl 사용 */
  contentBackgroundImageUrl?: string;
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

/**
 * LLM이 생성하는 가독성 저해 패턴 제거:
 * - 한자 내부 한글 읽기 주석 제거: 辛(신)金 → 辛金  (결과: 신금(辛金))
 * - 한국어 조사 이중 표기 제거: 은(는) → 은, 이(가) → 이, 을(를) → 을, 과(와) → 과
 */
function cleanupLlmArtifacts(text: string): string {
  // CJK 한자 한 글자 뒤에 한글 1~3자 괄호 주석 제거: 辛(신) → 辛
  let t = text.replace(/[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF]\(([가-힣]{1,3})\)/g, (match) =>
    match.replace(/\([가-힣]{1,3}\)/, ""),
  );
  // 조사 이중 표기
  const particlePairs: [RegExp, string][] = [
    [/은\(는\)/g, "은"], [/는\(은\)/g, "는"],
    [/이\(가\)/g, "이"], [/가\(이\)/g, "가"],
    [/을\(를\)/g, "을"], [/를\(을\)/g, "를"],
    [/과\(와\)/g, "과"], [/와\(과\)/g, "와"],
    [/으로\(로\)/g, "으로"], [/로\(으로\)/g, "로"],
    [/아\(야\)/g, "아"], [/야\(아\)/g, "야"],
  ];
  for (const [pattern, replacement] of particlePairs) {
    t = t.replace(pattern, replacement);
  }
  return t;
}

/**
 * 한 줄 안에서 "레이블:" 패턴이 이어질 때 앞에 줄바꿈을 삽입한다.
 * 예: "초년: 어쩌구 청년: 저쩌구" → "초년: 어쩌구\n청년: 저쩌구"
 */
function normalizeLineBreaksBeforeLabels(text: string): string {
  // 특징/영향 : 앞 줄바꿈 (collapseInnerNewlines로 한 줄이 됐을 때도 분리)
  let t = text.replace(/([^\n])\s*(특징\s*:)/g, "$1\n$2");
  t = t.replace(/([^\n])\s*(영향\s*:)/g, "$1\n$2");
  // 장점/단점 앞 줄바꿈
  t = t.replace(/([^\n])(장점\s*:|단점\s*:)/g, "$1\n$2");
  // 초년/청년/중년/말년 앞 줄바꿈 (기 포함 모두)
  t = t.replace(/([^\n])\s*(초년기?|청년기?|중년기?|말년기?)\s*:/g, "$1\n$2:");
  // 언제/어디서/누구와/어떻게 앞 줄바꿈
  t = t.replace(/([^\n])\s*(언제|어디서|누구와|어떻게)\s*:/g, "$1\n$2:");
  return t;
}

/** HTML-이스케이프된 문자열에서 레이블 키워드를 볼드 처리 */
function applyInlineBoldLabels(html: string): string {
  // 특징:/영향:/장점:/단점: → <strong>
  html = html.replace(
    /(^|<br \/>)\s*(특징|영향|장점|단점)\s*:/g,
    '$1<strong class="doc-label-bold">$2</strong>:',
  );
  // 초년:/청년:/중년:/말년: (콜론 있는 형식) → 스테이지 레이블 pill
  html = html.replace(
    /(^|<br \/>)\s*(초년기?|청년기?|중년기?|말년기?)\s*:/g,
    '$1<span class="doc-stage-label">$2</span>:',
  );
  // 언제:/어디서:/누구와:/어떻게: → 볼드
  html = html.replace(
    /(^|<br \/>)\s*(언제|어디서|누구와|어떻게)\s*:/g,
    '$1<strong class="doc-label-bold">$2</strong>:',
  );
  return html;
}

/** 단락 텍스트의 첫 20자 안에 인생 단계 키워드가 있으면 해당 단계명을 반환 */
function detectLeadingStage(text: string): string | null {
  // "먼저", "다음으로", "이어서", "마지막으로" 등 connector 이후에도 매칭
  const m = text.trimStart().match(
    /^(?:먼저[,，\s]*|다음으로[,，\s]*|이어서[,，\s]*|마지막으로[,，\s]*)?(초년기|청년기|중년기|말년기)/,
  );
  if (!m || (m.index ?? 0) > 8) return null;
  return m[1] ?? null;
}

/** 스테이지 섹션 헤더 HTML 반환 */
function stageHeaderHtml(stageName: string): string {
  return `<div class="doc-stage-header"><span class="doc-stage-header-label">${escapeHtml(stageName)}</span><span class="doc-stage-header-rule"></span></div>`;
}

function renderParagraphHtml(text: string): string {
  const raw = normalizeLineBreaksBeforeLabels(cleanupLlmArtifacts(String(text)));
  const tipPrefix = "핵심 요약";
  const trimmedStart = raw.replace(/^\s+/, "");
  if (trimmedStart.startsWith(tipPrefix)) {
    const leadingWsLen = raw.length - trimmedStart.length;
    const leadingWs = raw.slice(0, leadingWsLen);
    const rest = trimmedStart.slice(tipPrefix.length);

    return `${escapeHtml(leadingWs)}<span class="doc-inlineTitle">${escapeHtml(tipPrefix)}</span>${escapeHtml(rest)}`.replace(/\n/g, "<br />");
  }

  // 단락이 인생 단계(초년기/청년기/중년기/말년기)로 시작하면 섹션 구분 헤더 삽입
  // 헤더를 주입한 뒤에는 본문에서 스테이지 레이블 접두어를 제거해 중복 렌더링을 방지한다.
  const stageKey = detectLeadingStage(raw);
  if (stageKey) {
    // "먼저 청년기 :", "이어서 중년기:" 등 다양한 형태의 접두어를 제거
    const bodyText = raw
      .replace(
        /^(?:먼저[,，\s]*|다음으로[,，\s]*|이어서[,，\s]*|마지막으로[,，\s]*)?(초년기|청년기|중년기|말년기)\s*:?\s*/,
        "",
      )
      .trimStart();
    const bodyHtml = applyInlineBoldLabels(escapeHtml(bodyText).replace(/\n/g, "<br />"));
    return `${stageHeaderHtml(stageKey)}<div class="doc-stage-body">${bodyHtml}</div>`;
  }

  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const [firstLine, ...restLines] = lines;
  const headingCandidate = firstLine?.trim() ?? "";
  const hasBody = restLines.some((line) => line.trim().length > 0);
  const looksLikeSectionLead = hasBody
    && headingCandidate.length > 0
    && headingCandidate.length <= 30
    && !/[.!?]$/.test(headingCandidate)
    && !headingCandidate.includes("님,")
    && !headingCandidate.includes(":");

  if (looksLikeSectionLead) {
    const rest = restLines.join("\n").trimStart();
    const bodyHtml = applyInlineBoldLabels(escapeHtml(rest).replace(/\n/g, "<br />"));
    return `<span class="doc-paragraphLeadTitle">${escapeHtml(headingCandidate)}</span>${rest ? `<br />${bodyHtml}` : ""}`;
  }

  return applyInlineBoldLabels(escapeHtml(raw).replace(/\n/g, "<br />"));
}

function renderBlock(block: Block): string {
  switch (block.type) {
    case "title":
      return `<div class="doc-block doc-title">${escapeHtml(block.text)}</div>`;
    case "subtitle":
      return `<div class="doc-block doc-subtitle">${escapeHtml(block.text)}</div>`;
    case "paragraph":
      return `<div class="doc-block doc-paragraph">${renderParagraphHtml(block.text)}</div>`;
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
        <table class="doc-table${block.columns.length === 2 && block.columns[0] === "장" && block.columns[1] === "내용" ? " doc-table--toc" : ""}">
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
    case "chapterImagePage":
      return `<section class="doc-chapterImagePage"><img src="${escapeHtml(block.src)}" alt="${escapeHtml(block.alt ?? "")}" class="doc-chapterImage" /></section>`;
    case "chapterSubcover": {
      const ps = block.paragraphs.map((p) => `<p class="doc-subcover-p">${escapeHtml(p)}</p>`).join("");
      return `<div class="doc-block doc-chapter-subcover"><h2 class="doc-subcover-title">${escapeHtml(block.title)}</h2>${ps}</div>`;
    }
    case "profileWithAnimal": {
      const g = block.gender.trim();
      const nameLine = g ? `${escapeHtml(block.name)}(${escapeHtml(g)})` : escapeHtml(block.name);
      const infoLines = [
        nameLine,
        `${escapeHtml(block.birthLabel)} (${escapeHtml(block.calendarLabel)})`,
        `오행: ${escapeHtml(block.dayElementStem)} | 일주 동물: ${escapeHtml(block.dayAnimalLabel)}`,
        `<em class="doc-profile-disclaimer">${escapeHtml(block.disclaimer)}</em>`,
      ];
      return `<div class="doc-block doc-profile-with-animal">
        <div class="doc-profile-animal-panel"><img src="${escapeHtml(block.animalImageSrc)}" alt="${escapeHtml(block.animalLabel)}" class="doc-profile-animal-img" /><span class="doc-profile-animal-label">${escapeHtml(block.animalLabel)}</span></div>
        <div class="doc-profile-info">${infoLines.map((line) => `<p class="doc-profile-line">${line}</p>`).join("")}</div>
      </div>`;
    }
    case "sajuTableStyled": {
      const hi = block.highlightColumnIndex;
      const highlightRows = new Set(block.highlightRowIndices ?? []);
      const thead = `<thead><tr>${block.columns.map((c, ci) => {
        const hClass = hi === ci ? " doc-saju-th--highlight" : "";
        return `<th class="${hClass}">${escapeHtml(c)}</th>`;
      }).join("")}</tr></thead>`;
      const tbody = block.rows
        .map((row, ri) => {
          const rowClass = highlightRows.has(ri) ? " doc-saju-tr--highlight" : "";
          const cells = row.map((cell, ci) => {
            const el = block.cellElements[ri]?.[ci];
            const cellClass = el ? ` doc-cell-${el}` : "";
            const highlightClass = hi === ci ? " doc-saju-td--highlight" : "";
            return `<td class="doc-saju-td${cellClass}${highlightClass}">${escapeHtml(cell)}</td>`;
          });
          return `<tr class="${rowClass.trim()}">${cells.join("")}</tr>`;
        })
        .join("");
      return `<div class="doc-block doc-saju-table-wrap"><table class="doc-table doc-saju-table">${thead}<tbody>${tbody}</tbody></table></div>`;
    }
    case "elementCards": {
      const elementLabels: Record<string, string> = { 목: "나무", 화: "불", 토: "흙", 금: "금", 수: "물" };
      const elementHanja: Record<string, string> = { 목: "木", 화: "火", 토: "土", 금: "金", 수: "水" };
      const cardItems = block.items.map(
        (item) =>
          `<div class="doc-element-card doc-element-${item.element}">
            <span class="doc-element-char">${escapeHtml(elementHanja[item.element] ?? item.element)}</span>
            <span class="doc-element-name">${escapeHtml(elementLabels[item.element] ?? item.element)}</span>
            <span class="doc-element-pct">${item.pct}% - ${item.count}개</span>
          </div>`,
      );
      return `<div class="doc-block doc-element-cards">
        <p class="doc-element-cards-title">나의 오행: ${escapeHtml(block.dayStemLabel)}</p>
        <div class="doc-element-cards-grid">${cardItems.join("")}</div>
      </div>`;
    }
    case "elementWheel": {
      const elementOrder: FiveElementKey[] = ["목", "화", "토", "금", "수"];
      const itemByEl = Object.fromEntries(block.items.map((i) => [i.element, i]));
      const cx = 260;
      const cy = 240;
      const r = 136;
      const circleR = 50;
      const outerCurveR = 160;
      const deg = (i: number) => (270 - i * 72) * (Math.PI / 180);
      const pos = (i: number) => ({
        x: cx + r * Math.cos(deg(i)),
        y: cy + r * Math.sin(deg(i)),
      });
      const pointOnEdge = (from: { x: number; y: number }, to: { x: number; y: number }, offset: number) => {
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const len = Math.hypot(dx, dy) || 1;
        return {
          x: from.x + (dx / len) * offset,
          y: from.y + (dy / len) * offset,
        };
      };
      const positions = elementOrder.map((_, i) => pos(i));
      const elColors: Record<FiveElementKey, string> = {
        목: "#2f8f97",
        화: "#de7a72",
        토: "#d8a642",
        금: "#9e978f",
        수: "#3f4653",
      };
      const sangsaengSegments: [number, number][] = [[0, 1], [1, 2], [2, 3], [3, 4], [4, 0]];
      const sangsaengPaths = sangsaengSegments.map(([a, b]) => {
        // Normalize angles so they are within π of each other (prevents wrong-side arc when crossing 0°)
        let angA = deg(a);
        let angB = deg(b);
        if (angA - angB > Math.PI) angB += 2 * Math.PI;
        else if (angB - angA > Math.PI) angA += 2 * Math.PI;
        const mid = (angA + angB) / 2;
        const start = pointOnEdge(positions[a], positions[b], circleR + 16);
        const end = pointOnEdge(positions[b], positions[a], circleR + 18);
        return `M ${start.x} ${start.y} Q ${cx + outerCurveR * Math.cos(mid)} ${cy + outerCurveR * Math.sin(mid)} ${end.x} ${end.y}`;
      });
      const sanggukSegments: [number, number][] = [[0, 2], [2, 4], [4, 1], [1, 3], [3, 0]];
      const sanggukPaths = sanggukSegments.map(
        ([a, b]) => {
          const start = pointOnEdge(positions[a], positions[b], circleR + 16);
          const end = pointOnEdge(positions[b], positions[a], circleR + 18);
          return `M ${start.x} ${start.y} L ${end.x} ${end.y}`;
        },
      );
      const circlesHtml = elementOrder
        .map((el, i) => {
          const item = itemByEl[el];
          const p = positions[i];
          const pct = item?.pct ?? 0;
          const count = item?.count ?? 0;
          return `<g class="doc-ohaeng-circle">
            <circle cx="${p.x}" cy="${p.y}" r="${circleR + 5}" fill="rgba(255,255,255,0.7)"/>
            <circle cx="${p.x}" cy="${p.y}" r="${circleR}" fill="${elColors[el]}" stroke="#ffffff" stroke-width="3"/>
            <text x="${p.x}" y="${p.y - 10}" text-anchor="middle" class="doc-ohaeng-name">${escapeHtml(el)}</text>
            <text x="${p.x}" y="${p.y + 16}" text-anchor="middle" class="doc-ohaeng-value">${pct}% - ${count}개</text>
          </g>`;
        })
        .join("");
      return `<div class="doc-block doc-ohaeng-wheel">
        <p class="doc-ohaeng-title">나의 오행: ${escapeHtml(block.dayStemLabel)}</p>
        <div class="doc-ohaeng-legend">
          <span class="doc-ohaeng-legend-item"><svg width="24" height="12" viewBox="0 0 24 12"><path d="M1 6 H18" stroke="#4e82e6" stroke-width="2.1" fill="none"/><path d="M13.5 3 L19 6 L13.5 9 Z" fill="#4e82e6"/></svg> 상생</span>
          <span class="doc-ohaeng-legend-item"><svg width="24" height="12" viewBox="0 0 24 12"><path d="M1 6 H18" stroke="#e06464" stroke-width="1.9" fill="none" stroke-dasharray="4 3"/><path d="M13.5 3 L19 6 L13.5 9 Z" fill="#e06464"/></svg> 상극</span>
        </div>
        <div class="doc-ohaeng-frame">
        <svg class="doc-ohaeng-svg" viewBox="0 0 520 480" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <marker id="doc-ohaeng-arrow-blue" markerWidth="13" markerHeight="13" refX="12" refY="6.5" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,1 L12,6.5 L0,12 Z" fill="#4e82e6"/></marker>
            <marker id="doc-ohaeng-arrow-red" markerWidth="13" markerHeight="13" refX="12" refY="6.5" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,1 L12,6.5 L0,12 Z" fill="#e06464"/></marker>
          </defs>
          <circle cx="${cx}" cy="${cy}" r="106" fill="none" stroke="rgba(210, 180, 140, 0.28)" stroke-width="1.5" stroke-dasharray="4 8"/>
          ${sangsaengPaths.map((d) => `<path d="${d}" fill="none" stroke="#4e82e6" stroke-width="2.3" stroke-opacity="0.95" stroke-linecap="round" stroke-linejoin="round" marker-end="url(#doc-ohaeng-arrow-blue)"/>`).join("\n          ")}
          ${sanggukPaths.map((d) => `<path d="${d}" fill="none" stroke="#e06464" stroke-width="1.9" stroke-opacity="0.9" stroke-dasharray="5 4" stroke-linecap="round" stroke-linejoin="round" marker-end="url(#doc-ohaeng-arrow-red)"/>`).join("")}
          ${circlesHtml}
        </svg>
        </div>
        <p class="doc-ohaeng-footer">${escapeHtml(block.personName)}님의 음양오행 구성</p>
      </div>`;
    }
    case "yinYangBar":
      return `<div class="doc-block doc-yin-yang-bar">
        <div class="doc-yy-bar">
          <span class="doc-yy-seg doc-yy-yang" style="width:${block.yangPct}%">양 ${block.yangPct}%</span>
          <span class="doc-yy-seg doc-yy-yin" style="width:${block.yinPct}%">${block.yinPct}% 음</span>
        </div>
      </div>`;
    case "daewoonTable": {
      const ageHeaderCells = block.ages.map((age) => `<th class="doc-dw-th">${escapeHtml(String(age))}</th>`).join("");
      const sipseongStemRow = `<tr><td class="doc-dw-label">십성</td>${block.columns.map((c) => `<td class="doc-dw-td">${escapeHtml(c.sipseongStem)}</td>`).join("")}</tr>`;
      const stemRow = `<tr><td class="doc-dw-label">천간</td>${block.columns.map((c) => `<td class="doc-dw-td doc-dw-pillar doc-cell-${escapeHtml(c.stemElement)}">${escapeHtml(`${c.stemHanja}(${c.stem})`)}</td>`).join("")}</tr>`;
      const branchRow = `<tr><td class="doc-dw-label">지지</td>${block.columns.map((c) => `<td class="doc-dw-td doc-dw-pillar doc-cell-${escapeHtml(c.branchElement)}">${escapeHtml(`${c.branchHanja}(${c.branch})`)}</td>`).join("")}</tr>`;
      const sipseongBranchRow = `<tr><td class="doc-dw-label">십성</td>${block.columns.map((c) => `<td class="doc-dw-td">${escapeHtml(c.sipseongBranch)}</td>`).join("")}</tr>`;
      const sibiunseongRow = `<tr><td class="doc-dw-label">십이운성</td>${block.columns.map((c) => `<td class="doc-dw-td">${escapeHtml(c.sibiunseong)}</td>`).join("")}</tr>`;
      return `<div class="doc-block doc-daewoon-wrap">
        <p class="doc-daewoon-title">대운수: ${block.daewoonsu} (${escapeHtml(block.firstPillarLabel)})</p>
        <p class="doc-daewoon-intro">대운수는 내가 태어난 후, 언제부터 나의 특별한 운의 흐름이 시작되는지를 알려주는 숫자입니다!</p>
        <div class="doc-daewoon-table-wrap">
          <table class="doc-table doc-daewoon-table">
            <thead><tr><th class="doc-dw-th doc-dw-label-th"></th>${ageHeaderCells}</tr></thead>
            <tbody>${sipseongStemRow}${stemRow}${branchRow}${sipseongBranchRow}${sibiunseongRow}</tbody>
          </table>
        </div>
        <p class="doc-daewoon-footer">이 표는 당신의 대운표입니다. 대운수는 내가 태어난 이후, 몇 년부터 대운이 시작되는지를 나타내는 중요한 지표입니다. 예를 들어 대운수가 ${block.daewoonsu}라면, ${block.daewoonsu}세, ${block.daewoonsu + 10}세, ${block.daewoonsu + 20}세… 이렇게 10년 단위로 나의 대운이 변화하게 됩니다.</p>
      </div>`;
    }
    case "daewoonDetailTable": {
      const labels = ["구분", "십성", "천간", "지지", "십성", "십이운성"];
      const values = [
        `<div class="doc-daewoon-detail-value">${escapeHtml(String(block.age))}</div>`,
        `<div class="doc-daewoon-detail-value">${escapeHtml(block.sipseongStem)}</div>`,
        `<div class="doc-daewoon-detail-value doc-daewoon-detail-pillar doc-cell-${escapeHtml(block.stemElement)}">${escapeHtml(block.stem)}</div>`,
        `<div class="doc-daewoon-detail-value doc-daewoon-detail-pillar doc-cell-${escapeHtml(block.branchElement)}">${escapeHtml(block.branch)}</div>`,
        `<div class="doc-daewoon-detail-value">${escapeHtml(block.sipseongBranch)}</div>`,
        `<div class="doc-daewoon-detail-value">${escapeHtml(block.sibiunseong)}</div>`,
      ].join("");
      return `<div class="doc-block doc-daewoon-detail">
        <div class="doc-daewoon-detail-grid">
          ${labels.map((label) => `<div class="doc-daewoon-detail-label">${escapeHtml(label)}</div>`).join("")}
          ${values}
        </div>
      </div>`;
    }
    case "yeonunTable": {
      const headerRow = `<tr><th class="doc-yn-th doc-yn-label-th">구분</th><th class="doc-yn-th">십성</th><th class="doc-yn-th">천간</th><th class="doc-yn-th">지지</th><th class="doc-yn-th">십성</th><th class="doc-yn-th">십이운성</th></tr>`;
      const yearRows = block.columns.map(
        (c) => `<tr class="doc-yn-year-row">
          <td class="doc-yn-td doc-yn-year">${escapeHtml(String(c.year))}년</td>
          <td class="doc-yn-td">${escapeHtml(c.sipseongStem)}</td>
          <td class="doc-yn-td doc-yn-pillar doc-cell-${escapeHtml(c.stemElement)}">${escapeHtml(`${c.stemHanja}(${c.stem})`)}</td>
          <td class="doc-yn-td doc-yn-pillar doc-cell-${escapeHtml(c.branchElement)}">${escapeHtml(`${c.branchHanja}(${c.branch})`)}</td>
          <td class="doc-yn-td">${escapeHtml(c.sipseongBranch)}</td>
          <td class="doc-yn-td">${escapeHtml(c.sibiunseong)}</td>
        </tr>`,
      ).join("");
      return `<div class="doc-block doc-yeonun-wrap">
        <div class="doc-yeonun-table-wrap">
          <table class="doc-table doc-yeonun-table">
            <thead>${headerRow}</thead>
            <tbody>${yearRows}</tbody>
          </table>
        </div>
        <p class="doc-yeonun-footer">이 표는 당신의 연운표입니다. 연운은 매해마다 변화하는 운의 흐름을 보여주며, 해당 연도의 간지(년주)와 일간의 관계로 십성·십이운성을 해석합니다.</p>
      </div>`;
    }
    case "yeonunDetailTable": {
      const labels = ["구분", "십성", "천간", "지지", "십성", "십이운성"];
      const values = [
        `<div class="doc-yeonun-detail-value">${escapeHtml(String(block.year))}년</div>`,
        `<div class="doc-yeonun-detail-value">${escapeHtml(block.sipseongStem)}</div>`,
        `<div class="doc-yeonun-detail-value doc-yeonun-detail-pillar doc-cell-${escapeHtml(block.stemElement)}">${escapeHtml(block.stem)}</div>`,
        `<div class="doc-yeonun-detail-value doc-yeonun-detail-pillar doc-cell-${escapeHtml(block.branchElement)}">${escapeHtml(block.branch)}</div>`,
        `<div class="doc-yeonun-detail-value">${escapeHtml(block.sipseongBranch)}</div>`,
        `<div class="doc-yeonun-detail-value">${escapeHtml(block.sibiunseong)}</div>`,
      ].join("");
      return `<div class="doc-block doc-yeonun-detail">
        <div class="doc-yeonun-detail-grid">
          ${labels.map((label) => `<div class="doc-yeonun-detail-label">${escapeHtml(label)}</div>`).join("")}
          ${values}
        </div>
      </div>`;
    }
    case "reportSummary": {
      const keywordsHtml = block.keywords.map((k) => `<span class="doc-summary-chip">${escapeHtml(k)}</span>`).join("");
      const highlightsHtml = block.highlights.map((h) => `<li class="doc-summary-highlight-item">${escapeHtml(h)}</li>`).join("");
      const chapterRowsHtml = block.chapterSummaries.map((c) =>
        `<div class="doc-summary-chapter-row">
          <span class="doc-summary-chapter-num">${c.number}</span>
          <span class="doc-summary-chapter-title">${escapeHtml(c.title)}</span>
          <span class="doc-summary-chapter-excerpt">${escapeHtml(c.excerpt)}</span>
        </div>`,
      ).join("");
      return `<section class="doc-summary-page">
        <div class="doc-summary-header">
          <p class="doc-summary-eyebrow">전체 리포트 요약</p>
          <h2 class="doc-summary-name">${escapeHtml(block.name)}님을 위한 핵심 정리</h2>
          <p class="doc-summary-oneline">${escapeHtml(block.oneLine)}</p>
          <div class="doc-summary-chips">${keywordsHtml}</div>
        </div>
        <div class="doc-summary-section">
          <p class="doc-summary-section-label">핵심 포인트</p>
          <ul class="doc-summary-highlight-list">${highlightsHtml}</ul>
        </div>
        <div class="doc-summary-section">
          <p class="doc-summary-section-label">장별 핵심 한 줄</p>
          <div class="doc-summary-chapters">${chapterRowsHtml}</div>
        </div>
      </section>`;
    }
    case "brandClosing": {
      const paragraphsHtml = block.paragraphs.map((p) => `<p class="doc-brand-p">${escapeHtml(p)}</p>`).join("");
      return `<div class="doc-block doc-brand-closing">
        <div class="doc-brand-closing-inner">
          ${paragraphsHtml}
          <p class="doc-brand-name">${escapeHtml(block.brandName)}</p>
        </div>
      </div>`;
    }
    default:
      return "";
  }
}

/** 문서 블록을 카드 단위로 묶음: 제목(title) / chapterSubcover / chapterImagePage 기준 */
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
    if (b.type === "chapterSubcover" || b.type === "chapterImagePage" || b.type === "reportSummary") {
      flush();
      cards.push([b]);
      continue;
    }
    if (b.type === "title") {
      flush();
      current.push(b);
      continue;
    }
    if (b.type === "footer") {
      flush();
      current.push(b);
      flush();
      continue;
    }
    if (b.type === "brandClosing") {
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
  @import url('https://fonts.googleapis.com/css2?family=Noto+Serif+KR:wght@400;500;600;700;900&family=Nanum+Myeongjo:wght@400;700;800&display=swap');
  @page { size: A4; margin: 0; }
  @page cover { size: A4; margin: 0; }
  @page content { size: A4; margin: 0; }
  :root {
    --doc-bg: #f5f0e8;
    --doc-card-bg: #ffffff;
    --doc-card-border: #e5e2dd;
    --doc-text: #1a1918;
    --doc-text-muted: #57534e;
    --doc-accent: #44403c;
    --doc-score-fill: #57534e;
    --doc-font: "Noto Serif KR", "Nanum Myeongjo", "AppleMyungjo", "Batang", serif;
    --doc-line-height: 2.02;
    --doc-space: 1.5rem;
    --doc-radius: 12px;
  }
  * { box-sizing: border-box; }
  html, body { min-height: 100%; margin: 0; }
  body {
    font-family: var(--doc-font);
    font-size: 19px;
    line-height: var(--doc-line-height);
    color: var(--doc-text);
    background: var(--doc-bg);
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .doc-contentWrap {
    position: relative;
    width: 210mm;
    max-width: 210mm;
    min-height: 297mm;
    margin: 0 auto;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .doc-contentOverlay {
    display: none;
  }
  .doc-contentInner {
    position: relative;
    z-index: 1;
    width: 100%;
    max-width: none;
    margin: 0;
    padding: 0;
    box-sizing: border-box;
  }
  .doc-contentPad {
    width: 100%;
    box-sizing: border-box;
    padding-top: 0;
    padding-bottom: 0;
  }
  @media print {
    .doc-contentWrap { min-height: 0; }
    .doc-contentPad {
      padding-top: 0;
      padding-bottom: 0;
    }
  }

  /* 표지: A4 1페이지 전체 사용 */
  .doc-coverPage {
    page: cover;
    position: relative;
    z-index: 2;
    height: 297mm;
    min-height: 297mm;
    width: 210mm;
    margin: 0 auto;
    padding: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    break-after: page;
    page-break-after: always;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .doc-coverPage::before {
    content: "";
    position: absolute;
    inset: 14mm 10mm;
    border: 1.5px solid rgba(121, 83, 52, 0.2);
    border-radius: 20px;
    z-index: 1;
    pointer-events: none;
  }
  .doc-coverPage::after {
    content: "";
    position: absolute;
    inset: 18mm 14mm;
    border: 1px solid rgba(121, 83, 52, 0.14);
    border-radius: 16px;
    z-index: 1;
    pointer-events: none;
  }
  .doc-chapterImagePage {
    page: cover;
    position: relative;
    z-index: 2;
    width: 210mm;
    height: 297mm;
    min-height: 297mm;
    margin: 0 auto;
    break-after: page;
    page-break-after: always;
    overflow: hidden;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .doc-chapterImage {
    display: block;
    width: 210mm;
    height: 297mm;
    object-fit: cover;
  }
  .doc-coverBg {
    position: absolute;
    inset: 0;
    z-index: 0;
    background-size: cover;
    background-position: center;
    background-repeat: no-repeat;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .doc-coverPanel {
    position: relative;
    z-index: 2;
    width: min(520px, 86%);
    border-radius: 20px;
    background:
      linear-gradient(180deg, rgba(255, 251, 245, 0.95) 0%, rgba(255, 249, 241, 0.95) 100%);
    border: 1px solid rgba(121, 83, 52, 0.22);
    box-shadow:
      0 14px 34px rgba(56, 36, 23, 0.14),
      inset 0 0 0 1px rgba(255, 255, 255, 0.6);
    padding: 34px 34px 26px;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
    overflow: hidden;
  }
  .doc-coverPanel::before {
    content: "";
    position: absolute;
    inset: 10px;
    border: 1px solid rgba(130, 94, 63, 0.18);
    border-radius: 14px;
    pointer-events: none;
  }
  .doc-coverPanel::after {
    content: "";
    position: absolute;
    left: 50%;
    top: 14px;
    transform: translateX(-50%);
    width: 140px;
    height: 10px;
    border-top: 2px solid rgba(136, 98, 64, 0.4);
    border-bottom: 2px solid rgba(136, 98, 64, 0.12);
    border-radius: 999px;
    pointer-events: none;
  }
  @media print {
    .doc-coverPanel {
      background: rgba(255, 255, 255, 0.95);
      box-shadow: 0 2px 14px rgba(56, 36, 23, 0.12);
    }
  }
  .doc-cover-ornamentTop {
    margin: 0 auto 12px;
    width: fit-content;
    padding: 2px 14px;
    border: 1px solid rgba(129, 88, 55, 0.28);
    border-radius: 999px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.14em;
    color: #6b4a2f;
    background: rgba(255, 250, 242, 0.75);
  }
  .doc-cover-eyebrow { font-size: 13px; letter-spacing: 0.2em; color: #5b3b26; margin: 0 0 14px; font-weight: 800; text-align: center; }
  .doc-cover-title { font-size: 40px; font-weight: 900; letter-spacing: -0.03em; margin: 0; line-height: 1.24; color: #1f1712; text-align: center; }
  .doc-cover-subtitle { margin: 16px auto 0; font-size: 16px; line-height: 1.78; color: #4d3d33; text-align: center; max-width: 92%; }
  .doc-cover-metaRow { margin-top: 18px; display: flex; flex-wrap: wrap; gap: 10px; justify-content: center; }
  .doc-cover-chip { display: inline-flex; align-items: center; gap: 8px; padding: 9px 14px; border-radius: 999px; background: rgba(125, 89, 57, 0.12); border: 1px solid rgba(125, 89, 57, 0.18); color: #4f3724; font-size: 13px; font-weight: 700; }
  .doc-cover-rule { height: 1px; background: linear-gradient(90deg, rgba(125, 89, 57, 0) 0%, rgba(125, 89, 57, 0.44) 50%, rgba(125, 89, 57, 0) 100%); margin: 22px 0 16px; }
  .doc-cover-brand { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .doc-cover-brandName { font-size: 14px; font-weight: 800; letter-spacing: 0.1em; color: #4f3724; margin: 0; }
  .doc-cover-summary-hint {
    margin: 18px -34px -26px;
    border-top: 1px solid rgba(125, 89, 57, 0.18);
    background: linear-gradient(135deg, #5c3317 0%, #7c4a1e 100%);
    border-radius: 0 0 20px 20px;
    padding: 0;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .doc-cover-summary-hint-inner {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 14px 22px;
  }
  .doc-cover-summary-hint-badge {
    display: inline-flex;
    align-items: center;
    padding: 3px 10px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.2);
    border: 1px solid rgba(255, 255, 255, 0.35);
    font-size: 11px;
    font-weight: 800;
    color: #fff;
    letter-spacing: 0.06em;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .doc-cover-summary-hint-text {
    flex: 1;
    font-size: 14px;
    font-weight: 500;
    color: rgba(255, 255, 255, 0.9);
    line-height: 1.4;
  }
  .doc-cover-summary-hint-text strong {
    font-weight: 800;
    color: #fff;
  }
  .doc-cover-summary-hint-arrow {
    font-size: 18px;
    color: rgba(255, 255, 255, 0.7);
    flex-shrink: 0;
    font-weight: 300;
  }
  .doc-cover-stamp {
    width: 64px;
    height: 64px;
    border-radius: 999px;
    border: 2px solid rgba(143, 36, 31, 0.75);
    color: #8f241f;
    font-size: 12px;
    font-weight: 900;
    letter-spacing: 0.12em;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: rgba(255, 246, 244, 0.8);
  }

  .doc-stack { display: block; }
  .doc-card {
    page: content;
    background: transparent;
    border: none;
    border-radius: 0;
    padding: 10mm 16mm 12mm;
    margin-bottom: 0;
    box-shadow: none;
    break-inside: auto;
    page-break-inside: auto;
    -webkit-box-decoration-break: clone;
    box-decoration-break: clone;
  }
  .doc-card:last-child { margin-bottom: 0; }
  .doc-card.doc-card--break { break-before: page; page-break-before: always; }

  .doc-block { margin-bottom: var(--doc-space); }
  .doc-block:last-child { margin-bottom: 0; }
  .doc-title { font-size: 27px; font-weight: 800; letter-spacing: -0.02em; color: var(--doc-text); margin-bottom: 12px; }
  .doc-subtitle { font-size: 18px; color: var(--doc-text-muted); margin-bottom: 18px; line-height: 1.9; }
  .doc-paragraph { font-size: 18px; color: var(--doc-text); line-height: 2.08; margin-bottom: 18px; white-space: pre-line; }
  .doc-inlineTitle {
    display: inline-block;
    font-size: 20px;
    font-weight: 900;
    letter-spacing: -0.01em;
    color: #1c1917;
    background: rgba(251, 191, 36, 0.22);
    border: 1px solid rgba(245, 158, 11, 0.28);
    padding: 2px 8px;
    border-radius: 999px;
    margin-right: 8px;
    transform: translateY(-0.5px);
  }
  .doc-paragraphLeadTitle {
    display: inline-block;
    font-size: 18px;
    font-weight: 900;
    letter-spacing: -0.01em;
    color: #1c1917;
    margin-bottom: 8px;
  }
  .doc-label-bold {
    font-weight: 800;
    color: #1c1917;
  }
  .doc-stage-label {
    display: inline-block;
    font-weight: 800;
    color: #7c3f20;
    background: rgba(139, 69, 19, 0.08);
    border: 1px solid rgba(139, 69, 19, 0.18);
    border-radius: 6px;
    padding: 1px 7px;
    margin-right: 3px;
    font-size: 0.95em;
    letter-spacing: -0.01em;
  }

  /* ─── 인생 단계 섹션 구분 헤더 ─── */
  .doc-stage-header {
    display: flex;
    align-items: center;
    gap: 14px;
    margin: 28px 0 10px;
    break-inside: avoid;
    page-break-inside: avoid;
  }
  .doc-stage-header-label {
    display: inline-flex;
    align-items: center;
    padding: 5px 18px;
    border-radius: 999px;
    background: #7c3f20;
    color: #fff;
    font-size: 15px;
    font-weight: 800;
    letter-spacing: 0.04em;
    flex-shrink: 0;
    white-space: nowrap;
  }
  .doc-stage-header-rule {
    flex: 1;
    height: 2px;
    border-radius: 999px;
    background: linear-gradient(90deg, rgba(124, 63, 32, 0.4) 0%, rgba(124, 63, 32, 0.05) 100%);
  }
  .doc-stage-body {
    font-size: inherit;
    line-height: inherit;
    color: inherit;
    padding-left: 4px;
  }
  .doc-keywords { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 14px; }
  .doc-chip {
    display: inline-block;
    padding: 8px 14px;
    border-radius: 8px;
    border: 1px solid #d6d3d1;
    background: #fafaf9;
    color: var(--doc-text-muted);
    font-size: 15px;
    font-weight: 600;
  }
  .doc-bulletList-title { font-size: 18px; font-weight: 700; margin-bottom: 16px; color: var(--doc-text); }
  .doc-bulletList-ul, .doc-orderedList-ol { margin: 0; padding-left: 24px; }
  .doc-bulletList-ul { list-style: disc; }
  .doc-bulletList-item, .doc-orderedList-item {
    margin-bottom: 18px;
    font-size: 18px;
    line-height: 2.05;
    color: var(--doc-text);
  }
  .doc-bulletList-item:last-child, .doc-orderedList-item:last-child { margin-bottom: 0; }
  .doc-orderedList-ol { list-style: decimal; padding-left: 26px; }
  .doc-orderedList-item { list-style: decimal; margin-left: 0; padding-left: 4px; }

  .doc-scoreBlock { margin-bottom: 6px; }
  .doc-scoreBlock-head { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-bottom: 16px; }
  .doc-scoreBlock-title { font-size: 18px; font-weight: 700; color: var(--doc-text); flex: 1 1 auto; }
  .doc-scoreBar-wrap { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
  .doc-scoreBar { width: 88px; height: 11px; background: #e7e5e4; border-radius: 999px; overflow: hidden; }
  .doc-scoreBar-fill { height: 100%; background: var(--doc-score-fill); border-radius: 999px; }
  .doc-scoreBar-num { font-size: 17px; font-weight: 700; color: var(--doc-text); min-width: 28px; }

  .doc-table-wrap { overflow-x: auto; border-radius: 10px; border: 1px solid var(--doc-card-border); margin-top: 14px; margin-bottom: 14px; break-inside: avoid; page-break-inside: avoid; }
  .doc-table { width: 100%; border-collapse: collapse; font-size: 17px; }
  .doc-table th, .doc-table td { padding: 13px 15px; text-align: center; border: 1px solid #e7e5e4; }
  .doc-table th { background: #f1f0ed; font-weight: 700; color: var(--doc-text); }
  .doc-table td:first-child { text-align: left; background: #fafaf9; font-weight: 600; color: var(--doc-text-muted); }
  .doc-table tr:nth-child(even) td { background: #fcfcfb; }
  .doc-table td { background: #ffffff; color: var(--doc-text); line-height: 1.7; }
  .doc-table--toc td:first-child,
  .doc-table--toc th:first-child { text-align: center; }

  .doc-keyValue { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .doc-kv-row { border: 1px solid #e7e5e4; border-radius: 10px; padding: 12px 14px; background: #fafaf9; }
  .doc-kv-key { display: block; font-size: 13px; color: var(--doc-text-muted); text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 6px; }
  .doc-kv-val { font-size: 18px; font-weight: 600; color: var(--doc-text); }

  .doc-footer { font-size: 16px; color: var(--doc-text-muted); line-height: 1.8; margin-top: 10px; }
  .doc-divider { height: 1px; background: #e7e5e4; margin: 22px 0; }
  .doc-image { text-align: center; margin: 20px 0; }
  .doc-img { max-width: 180px; height: auto; opacity: 0.9; }
  .doc-img-caption { display: block; font-size: 15px; color: var(--doc-text-muted); margin-top: 10px; }

  .doc-sectionDivider { text-align: center; margin: 20px 0; }
  .doc-sectionDivider img { max-width: 100px; height: auto; opacity: 0.65; }
  .doc-pageFooterLogo {
    position: absolute;
    right: 24px;
    bottom: 24px;
    width: 72px;
    height: auto;
    z-index: 50;
    opacity: 0.92;
    pointer-events: none;
  }
  @media print {
    .doc-pageFooterLogo {
      right: 6mm;
      bottom: 6mm;
      width: 20mm;
      z-index: 50;
    }
  }
  .doc-coverFooterLogo {
    position: absolute;
    right: 24px;
    bottom: 24px;
    width: 72px;
    height: auto;
    z-index: 3;
    opacity: 0.92;
    pointer-events: none;
  }
  @media print {
    .doc-coverFooterLogo {
      right: 6mm;
      bottom: 6mm;
      width: 20mm;
    }
  }

  /* 목차 카드: 다음 페이지로 */
  .doc-card--toc { break-after: page; page-break-after: always; }
  /* 1장 부표지: 한 페이지 전체, 제목 크게 */
  .doc-card--subcover { break-after: page; page-break-after: always; min-height: 220mm; display: flex; align-items: center; justify-content: center; }
  .doc-chapter-subcover { width: 100%; }
  .doc-subcover-title { font-size: 28px; font-weight: 800; letter-spacing: -0.02em; color: var(--doc-text); margin: 0 0 28px; text-align: center; }
  .doc-subcover-p { font-size: 18px; line-height: 2; color: var(--doc-text); margin: 0 0 20px; }
  .doc-subcover-p:last-child { margin-bottom: 0; }

  /* 2장: 동물 + 인적사항 (좌 패널 + 우 텍스트) */
  .doc-profile-with-animal { display: flex; gap: 28px; align-items: flex-start; margin-bottom: 24px; flex-wrap: wrap; }
  .doc-profile-animal-panel { flex-shrink: 0; width: 160px; background: #f1f0ed; border-radius: 12px; padding: 16px; text-align: center; border: 1px solid #e7e5e4; }
  .doc-profile-animal-img { width: 100%; height: auto; max-height: 140px; object-fit: contain; display: block; }
  .doc-profile-animal-label { display: block; font-size: 15px; font-weight: 700; color: var(--doc-text); margin-top: 10px; }
  .doc-profile-info { flex: 1; min-width: 200px; }
  .doc-profile-line { font-size: 18px; line-height: 1.85; margin: 0 0 10px; color: var(--doc-text); }
  .doc-profile-line:first-child { font-size: 19px; font-weight: 700; }
  .doc-profile-disclaimer { font-size: 14px; color: var(--doc-text-muted); font-style: normal; }

  /* 사주원국 표: 셀별 오행 배경색 */
  .doc-saju-table-wrap { margin: 20px 0; border-radius: 12px; border: 1px solid var(--doc-card-border); overflow: hidden; break-inside: avoid; page-break-inside: avoid; }
  .doc-saju-table { font-size: 17px; }
  .doc-saju-table th, .doc-saju-table .doc-saju-td { padding: 13px 15px; text-align: center; border: 1px solid #e7e5e4; }
  .doc-saju-table th { background: #f1f0ed; font-weight: 700; color: var(--doc-text); }
  .doc-saju-table .doc-saju-td { background: #ffffff; }
  .doc-saju-table .doc-saju-td:first-child { text-align: center; background: #fafaf9 !important; font-weight: 600; color: var(--doc-text-muted); }
  .doc-cell-목 { background: #c5e3dc !important; color: #1a4d42; }
  .doc-cell-화 { background: #f5d5ce !important; color: #8b4512; }
  .doc-cell-토 { background: #e8dfc8 !important; color: #5c4a32; }
  .doc-cell-금 { background: #e0d9d0 !important; color: #4a4038; }
  .doc-cell-수 { background: #d0dae8 !important; color: #2c3d5c; }
  .doc-saju-table .doc-saju-th--highlight,
  .doc-saju-table .doc-saju-td--highlight { box-shadow: inset 0 0 0 2px #c53030; font-weight: 700; }
  .doc-saju-table tr.doc-saju-tr--highlight .doc-saju-td { box-shadow: inset 0 0 0 2px #c53030; font-weight: 600; }

  /* 나의 오행: 5개 카드 */
  .doc-element-cards { margin: 24px 0; }
  .doc-element-cards-title { font-size: 17px; font-weight: 700; color: var(--doc-text); margin: 0 0 16px; padding-left: 12px; border-left: 4px solid #888; }
  .doc-element-cards-grid { display: flex; flex-wrap: wrap; gap: 12px; }
  .doc-element-card { flex: 1; min-width: 80px; max-width: 120px; border-radius: 12px; padding: 14px; text-align: center; color: #fff; font-weight: 600; }
  .doc-element-char { display: block; font-size: 22px; margin-bottom: 4px; font-family: var(--doc-font); }
  .doc-element-name { display: block; font-size: 13px; opacity: 0.95; margin-bottom: 6px; }
  .doc-element-pct { display: block; font-size: 14px; }
  .doc-element-목 { background: #2d7d6e; }
  .doc-element-화 { background: #c75a4a; }
  .doc-element-토 { background: #b8956e; }
  .doc-element-금 { background: #8b7355; }
  .doc-element-수 { background: #4a6fa5; }

  /* 나의 오행: 원형 다이어그램 (상생/상극) */
  .doc-ohaeng-wheel { text-align: center; margin: 28px 0 36px; break-inside: avoid; page-break-inside: avoid; }
  .doc-ohaeng-title { font-size: 19px; font-weight: 800; color: var(--doc-text); margin: 14px 0 10px; }
  .doc-ohaeng-legend { display: flex; justify-content: center; gap: 20px; margin-bottom: 14px; font-size: 14px; color: var(--doc-text-muted); }
  .doc-ohaeng-legend-item { display: inline-flex; align-items: center; gap: 6px; font-weight: 600; }
  .doc-ohaeng-frame {
    width: 100%;
    max-width: 430px;
    margin: 0 auto;
    padding: 18px 14px 14px;
    border-radius: 24px;
    background: linear-gradient(180deg, rgba(255,255,255,0.72), rgba(255,255,255,0.5));
    border: 1px solid rgba(214, 211, 209, 0.9);
    box-shadow: 0 10px 24px rgba(120, 113, 108, 0.08);
  }
  .doc-ohaeng-svg { width: 100%; max-width: 390px; height: auto; display: block; margin: 0 auto; overflow: visible; }
  .doc-ohaeng-name { font-size: 20px; font-weight: 800; fill: #fff; font-family: var(--doc-font); }
  .doc-ohaeng-value { font-size: 13px; font-weight: 700; fill: rgba(255,255,255,0.98); font-family: var(--doc-font); }
  .doc-ohaeng-footer { font-size: 14px; color: var(--doc-text-muted); margin: 18px 0 0; }

  /* 11장 대운표 */
  .doc-daewoon-wrap { margin: 24px 0; break-inside: avoid; page-break-inside: avoid; }
  .doc-daewoon-title { font-size: 19px; font-weight: 800; color: var(--doc-text); margin: 0 0 8px; }
  .doc-daewoon-intro { font-size: 16px; color: var(--doc-text-muted); margin: 0 0 16px; line-height: 1.85; }
  .doc-daewoon-table-wrap { overflow-x: auto; border-radius: 12px; border: 1px solid var(--doc-card-border); margin: 12px 0; }
  .doc-daewoon-table { width: 100%; border-collapse: collapse; font-size: 16px; }
  .doc-daewoon-table .doc-dw-th, .doc-daewoon-table .doc-dw-td { padding: 11px 9px; text-align: center; border: 1px solid #e7e5e4; }
  .doc-daewoon-table .doc-dw-label-th { background: #f1f0ed; font-weight: 700; min-width: 64px; }
  .doc-daewoon-table .doc-dw-label { text-align: left; background: #fafaf9; font-weight: 600; color: var(--doc-text-muted); }
  .doc-daewoon-table .doc-dw-pillar { font-weight: 700; font-size: 15px; min-width: 44px; }
  .doc-daewoon-footer { font-size: 14px; color: var(--doc-text-muted); margin: 14px 0 0; line-height: 1.8; }
  .doc-daewoon-detail { margin: 22px 0 14px; break-inside: avoid; page-break-inside: avoid; }
  .doc-daewoon-detail-grid {
    display: grid;
    grid-template-columns: repeat(6, minmax(0, 1fr));
    gap: 8px;
    padding: 14px;
    border-radius: 16px;
    background: rgba(255,255,255,0.88);
    border: 1px solid rgba(229, 226, 221, 0.95);
  }
  .doc-daewoon-detail-label,
  .doc-daewoon-detail-value {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 52px;
    padding: 10px 8px;
    border-radius: 10px;
    text-align: center;
  }
  .doc-daewoon-detail-label {
    background: #f5f3ef;
    color: var(--doc-text-muted);
    font-size: 14px;
    font-weight: 700;
  }
  .doc-daewoon-detail-value {
    background: #ffffff;
    color: var(--doc-text);
    font-size: 16px;
    font-weight: 700;
    line-height: 1.35;
  }
  .doc-daewoon-detail-pillar {
    font-size: 18px;
    font-weight: 800;
  }

  /* 12장 6년 연운표 (연도별 한 행 공통 스타일) */
  .doc-yeonun-wrap { margin: 24px 0; break-inside: avoid; page-break-inside: avoid; }
  .doc-yeonun-table-wrap { overflow-x: auto; border-radius: 12px; border: 1px solid var(--doc-card-border); margin: 12px 0; background: #f8f7f5; }
  .doc-yeonun-table { width: 100%; border-collapse: separate; border-spacing: 6px; font-size: 16px; }
  .doc-yeonun-table .doc-yn-th, .doc-yeonun-table .doc-yn-td { padding: 11px 12px; text-align: center; border-radius: 8px; font-weight: 600; }
  .doc-yeonun-table thead .doc-yn-th { background: #f1f0ed; color: var(--doc-text-muted); font-size: 13px; }
  .doc-yeonun-table .doc-yn-label-th { text-align: left; min-width: 72px; }
  .doc-yeonun-table .doc-yn-year-row .doc-yn-td { background: #fff; color: var(--doc-text); }
  .doc-yeonun-table .doc-yn-year { text-align: left; font-weight: 700; color: var(--doc-text); }
  .doc-yeonun-table .doc-yn-pillar { font-weight: 700; font-size: 15px; min-width: 44px; color: #fff; }
  .doc-yeonun-table .doc-yn-year-row .doc-yn-pillar.doc-cell-목 { background: #2d7d6e !important; color: #fff !important; }
  .doc-yeonun-table .doc-yn-year-row .doc-yn-pillar.doc-cell-화 { background: #c75a4a !important; color: #fff !important; }
  .doc-yeonun-table .doc-yn-year-row .doc-yn-pillar.doc-cell-토 { background: #b8956e !important; color: #fff !important; }
  .doc-yeonun-table .doc-yn-year-row .doc-yn-pillar.doc-cell-금 { background: #8b7355 !important; color: #fff !important; }
  .doc-yeonun-table .doc-yn-year-row .doc-yn-pillar.doc-cell-수 { background: #4a6fa5 !important; color: #fff !important; }
  .doc-yeonun-footer { font-size: 14px; color: var(--doc-text-muted); margin: 14px 0 0; line-height: 1.8; }
  .doc-yeonun-detail { margin: 18px 0 14px; break-inside: avoid; page-break-inside: avoid; }
  .doc-yeonun-detail-grid {
    display: grid;
    grid-template-columns: repeat(6, minmax(0, 1fr));
    gap: 8px;
    padding: 14px;
    border-radius: 16px;
    background: rgba(255,255,255,0.88);
    border: 1px solid rgba(229, 226, 221, 0.95);
  }
  .doc-yeonun-detail-label,
  .doc-yeonun-detail-value {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 52px;
    padding: 10px 8px;
    border-radius: 10px;
    text-align: center;
  }
  .doc-yeonun-detail-label {
    background: #f5f3ef;
    color: var(--doc-text-muted);
    font-size: 14px;
    font-weight: 700;
  }
  .doc-yeonun-detail-value {
    background: #ffffff;
    color: var(--doc-text);
    font-size: 16px;
    font-weight: 700;
    line-height: 1.35;
  }
  .doc-yeonun-detail-pillar {
    font-size: 18px;
    font-weight: 800;
  }

  /* 마지막 꼬리: 브랜드 마무리 (최대감사주) */
  .doc-brand-closing { margin-top: 32px; padding-top: 24px; border-top: 1px solid #e7e5e4; }
  .doc-brand-closing-inner { max-width: 560px; }
  .doc-brand-closing .doc-brand-p { font-size: 17px; line-height: 1.85; color: var(--doc-text); margin: 0 0 16px; }
  .doc-brand-closing .doc-brand-p:last-of-type { margin-bottom: 20px; }
  .doc-brand-closing .doc-brand-name { font-size: 14px; font-weight: 700; color: var(--doc-accent); margin: 0; letter-spacing: 0.02em; }

  /* ─── 전체 요약 페이지 ─── */
  .doc-summary-page {
    break-before: page;
    page-break-before: always;
    padding: 44px 44px 40px;
    background: linear-gradient(160deg, #fdf9f5 0%, #fff8ef 100%);
    border-radius: 20px;
    border: 1px solid rgba(193, 154, 107, 0.22);
    display: flex;
    flex-direction: column;
    gap: 24px;
  }
  .doc-summary-eyebrow {
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: #9a6b3a;
    margin: 0 0 8px;
  }
  .doc-summary-name {
    font-size: 24px;
    font-weight: 900;
    letter-spacing: -0.02em;
    color: #1c1917;
    margin: 0 0 10px;
    line-height: 1.28;
  }
  .doc-summary-oneline {
    font-size: 16px;
    line-height: 1.7;
    color: #44403c;
    margin: 0 0 14px;
  }
  .doc-summary-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 7px;
  }
  .doc-summary-chip {
    display: inline-block;
    padding: 4px 11px;
    border-radius: 999px;
    background: rgba(155, 107, 58, 0.1);
    border: 1px solid rgba(155, 107, 58, 0.22);
    color: #7c4a1e;
    font-size: 12px;
    font-weight: 700;
  }
  .doc-summary-section {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .doc-summary-section-label {
    font-size: 11px;
    font-weight: 800;
    letter-spacing: 0.1em;
    color: #9a6b3a;
    margin: 0;
    text-transform: uppercase;
    border-bottom: 1.5px solid rgba(155, 107, 58, 0.2);
    padding-bottom: 6px;
  }
  .doc-summary-highlight-list {
    margin: 0;
    padding: 0;
    list-style: none;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px 20px;
  }
  .doc-summary-highlight-item {
    font-size: 14px;
    line-height: 1.6;
    color: #1c1917;
    padding-left: 16px;
    position: relative;
  }
  .doc-summary-highlight-item::before {
    content: "▸";
    position: absolute;
    left: 0;
    color: #c1966b;
    font-size: 10px;
    top: 4px;
  }
  .doc-summary-chapters {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .doc-summary-chapter-row {
    display: grid;
    grid-template-columns: 26px 130px 1fr;
    align-items: baseline;
    gap: 10px;
    padding: 7px 10px;
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.6);
    border: 1px solid rgba(193, 154, 107, 0.12);
  }
  .doc-summary-chapter-num {
    width: 22px;
    height: 22px;
    border-radius: 5px;
    background: #c1966b;
    color: #fff;
    font-size: 11px;
    font-weight: 800;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }
  .doc-summary-chapter-title {
    font-size: 13px;
    font-weight: 700;
    color: #1c1917;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .doc-summary-chapter-excerpt {
    font-size: 13px;
    line-height: 1.5;
    color: #57534e;
  }
  .doc-card--final {
    position: relative;
    break-before: page;
    page-break-before: always;
    min-height: 297mm;
    padding-bottom: 44mm;
  }

  /* 음양 바 */
  .doc-yin-yang-bar { margin: 34px 0 30px; break-inside: avoid; page-break-inside: avoid; }
  .doc-yy-bar {
    display: flex;
    width: 100%;
    height: 42px;
    border-radius: 10px;
    overflow: hidden;
    border: 1px solid rgba(17, 24, 39, 0.22);
    background: rgba(248,250,252,0.9);
    box-shadow: none;
  }
  .doc-yy-seg {
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 14px;
    font-weight: 800;
    color: rgba(26, 25, 24, 0.88);
    text-shadow: 0 1px 0 rgba(255,255,255,0.65);
    letter-spacing: -0.01em;
  }
  .doc-yy-yang {
    background: linear-gradient(135deg, #0f4c81 0%, #1f5f99 55%, #2f6fa8 100%);
    color: rgba(255, 255, 255, 0.96);
    text-shadow: none;
  }
  .doc-yy-yin {
    background: linear-gradient(135deg, #334155 0%, #475569 55%, #64748b 100%);
    color: rgba(255, 255, 255, 0.96);
    text-shadow: none;
  }
`;

export function renderReportFromDocument(
  document: ReportDocument,
  params: DocumentRenderParams,
): string {
  const coverBgStyle = params.backgroundImageUrl
    ? `background-image: url('${escapeCssUrl(params.backgroundImageUrl)}'); background-size: cover; background-position: center; background-repeat: no-repeat;`
    : "background: linear-gradient(165deg, #d4c6ad 0%, #e8dfd0 50%, #d9cfc0 100%);";
  const contentBgStyle = params.contentBackgroundImageUrl
    ? `background-image: url('${escapeCssUrl(params.contentBackgroundImageUrl)}'); background-size: 210mm 297mm; background-position: center top; background-repeat: repeat-y;`
    : coverBgStyle;
  const footerLogoHtml = params.footerLogoUrl
    ? `<img class="doc-pageFooterLogo" src="${escapeHtml(params.footerLogoUrl)}" alt="" />`
    : "";
  const coverFooterLogoHtml = params.footerLogoUrl
    ? `<img class="doc-coverFooterLogo" src="${escapeHtml(params.footerLogoUrl)}" alt="" />`
    : "";

  /**
   * 같은 카드 내에서 연속으로 동일한 스테이지 헤더(초년기/청년기 등)가 나오면
   * 두 번째부터는 제거한다. renderParagraphHtml이 각 단락을 독립적으로 처리하므로
   * 같은 단계를 소개하는 짧은 문장과 본문 문장이 연달아 헤더를 생성할 수 있다.
   */
  function deduplicateStageHeaders(html: string): string {
    let lastStage: string | null = null;
    return html.replace(
      /<div class="doc-stage-header"><span class="doc-stage-header-label">([^<]+)<\/span><span class="doc-stage-header-rule"><\/span><\/div>/g,
      (match, stage) => {
        if (stage === lastStage) return "";
        lastStage = stage;
        return match;
      },
    );
  }

  const cards = groupBlocksIntoCards(document.blocks);
  const finalCardIndex = cards.length - 1;
  const cardsHtml = cards
    .map((cardBlocks, index) => {
      const first = cardBlocks[0];
      const isImagePage = first?.type === "chapterImagePage";
      const isToc = first?.type === "title" && "text" in first && first.text === "목차";
      const isSubcover = first?.type === "chapterSubcover";
      const isFinalCard = index === finalCardIndex;
      const cardClass = ["doc-card", isToc ? "doc-card--toc" : "", isSubcover ? "doc-card--subcover" : "", isFinalCard ? "doc-card--final" : ""].filter(Boolean).join(" ");
      const isSummaryPage = first?.type === "reportSummary";
      const rawHtml = cardBlocks.map((b) => renderBlock(b)).join("");
      const blockHtml = deduplicateStageHeaders(rawHtml);
      if (isImagePage || isSummaryPage) return blockHtml;
      return `<div class="${cardClass}">${blockHtml}${isFinalCard ? footerLogoHtml : ""}</div>`;
    })
    .join("");

  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(document.title)}</title>
  <style>${DOC_CSS}</style>
</head>
<body class="doc-body" style="${contentBgStyle}">
  <section class="doc-coverPage">
    <div class="doc-coverBg" style="${coverBgStyle}"></div>
    ${coverFooterLogoHtml}
    <div class="doc-coverPanel">
      <p class="doc-cover-ornamentTop">프리미엄 사주 리포트</p>
      <p class="doc-cover-eyebrow">사주 결과</p>
      <h1 class="doc-cover-title">${escapeHtml(params.name)}님 정통 평생 운세</h1>
      <p class="doc-cover-subtitle">사주 원국·오행·십성·운세 흐름을 바탕으로, 지금의 선택에 도움이 되는 해석과 조언을 담았습니다.</p>
      <div class="doc-cover-metaRow">
        <span class="doc-cover-chip">출생 ${escapeHtml(params.birthLabel)}</span>
        <span class="doc-cover-chip">${escapeHtml(params.calendarLabel)}</span>
        <span class="doc-cover-chip">발행 ${escapeHtml(document.metadata?.createdAt ?? new Date().toISOString().slice(0, 10))}</span>
      </div>
      <div class="doc-cover-rule"></div>
      <div class="doc-cover-brand">
        <p class="doc-cover-brandName">최대감사주</p>
        <span class="doc-cover-stamp">정통</span>
      </div>
      <div class="doc-cover-summary-hint">
        <div class="doc-cover-summary-hint-inner">
          <span class="doc-cover-summary-hint-badge">핵심 요약</span>
          <span class="doc-cover-summary-hint-text">리포트 마지막 페이지에 <strong>전체 핵심 요약본</strong>이 있습니다</span>
          <span class="doc-cover-summary-hint-arrow">→</span>
        </div>
      </div>
    </div>
  </section>
  <div class="doc-contentWrap">
    <div class="doc-contentInner">
      <div class="doc-contentPad">
        <div class="doc-stack">
          ${cardsHtml}
        </div>
      </div>
    </div>
  </div>
</body>
</html>`;
}
