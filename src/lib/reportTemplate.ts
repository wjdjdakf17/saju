import type { ReportContent } from "@/lib/reportSchema";
import type { SajuResult } from "@/lib/saju";

export function renderReportHtml(params: {
  name: string;
  gender: string;
  calendarLabel: string;
  birthLabel: string;
  backgroundImageUrl?: string;
  footerLogoUrl?: string;
  saju: SajuResult;
  report: ReportContent;
}): string {
  const { report, saju } = params;
  const fpK = saju.fourPillars.korean;
  const fpH = saju.fourPillars.hanja;

  const keywords = report.summary.keywords
    .map((k) => `<span class="chip">${escapeHtml_(k)}</span>`)
    .join("");

  const highlights = report.summary.highlights
    .map((h) => `<li>${escapeHtml_(h)}</li>`)
    .join("");

  const sections = report.sections
    .map((sec, index) => {
      const { titleOnly, score } = parseHeadingScore_(sec.heading);
      const bullets = sec.bullets.map((b) => `<li>${escapeHtml_(b)}</li>`).join("");
      const sectionBreakClass = (index + 1) % 2 === 0 ? " sectionBreak" : "";
      const scoreBarHtml =
        score != null
          ? `<div class="scoreBarWrap"><div class="scoreBar" aria-hidden="true"><div class="scoreBarFill" style="width: ${score}%"></div></div><span class="scoreNum">${score}</span></div>`
          : "";
      return `
        <section class="card avoidBreak${sectionBreakClass}">
          <div class="h2Row">
            <h2 class="h2">${escapeHtml_(titleOnly)}</h2>
            ${scoreBarHtml}
          </div>
          <ul class="ul">${bullets}</ul>
        </section>
      `;
    })
    .join("");

  const tips = report.elementBalance.tips.map((t) => `<li>${escapeHtml_(t)}</li>`).join("");
  const footerLogoHtml = params.footerLogoUrl
    ? `<img class="pageFooterLogo" src="${escapeHtml_(params.footerLogoUrl)}" alt="footer logo" />`
    : "";
  const pageBackgroundStyle = params.backgroundImageUrl
    ? `background-image: url('${escapeCssUrl_(params.backgroundImageUrl)}');`
    : "background-image: linear-gradient(160deg, #d4c6ad 0%, #ece4d4 44%, #dbcfba 100%);";

  return `<!doctype html>
<html lang="ko">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml_(report.title)}</title>
    <style>
      @import url('https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;700;800&family=Noto+Sans+KR:wght@400;500;700;800&display=swap');
      @page { size: A4; margin: 14mm; }
      :root { color-scheme: light; }
      * { box-sizing: border-box; }
      html, body { height: 100%; }
      body {
        margin: 0;
        font-family: "Noto Sans KR", "Noto Sans JP", "Noto Sans CJK KR", system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple SD Gothic Neo", sans-serif;
        background: #efe7da;
        color: #0f172a;
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
      }
      .pageBg {
        position: fixed;
        inset: 0;
        z-index: 0;
        background-position: center top;
        background-repeat: no-repeat;
        background-size: cover;
      }
      .pageBgOverlay {
        position: fixed;
        inset: 0;
        z-index: 0;
        background: rgba(255, 255, 255, 0.68);
      }
      .pageFooterLogo {
        position: fixed;
        right: 14mm;
        bottom: 6mm;
        width: 22mm;
        height: auto;
        z-index: 2;
        opacity: 0.92;
      }

      .page { position: relative; z-index: 1; max-width: 820px; margin: 0 auto; padding: 28px 24px 44px; }
      .coverPage {
        min-height: 258mm;
        border-radius: 18px;
        overflow: hidden;
        border: 1px solid rgba(254, 252, 232, 0.52);
        background: rgba(2, 6, 23, 0.18);
        display: flex;
        align-items: flex-end;
        padding: 24px;
        margin-bottom: 4px;
        break-after: page;
        page-break-after: always;
      }
      .coverOverlay {
        width: 100%;
        border-radius: 14px;
        background: rgba(2, 6, 23, 0.45);
        border: 1px solid rgba(250, 250, 250, 0.22);
        color: #f8fafc;
        padding: 16px 16px;
      }
      .coverEyebrow { margin: 0 0 6px; font-size: 12px; letter-spacing: 0.08em; opacity: 0.9; }
      .coverTitle { margin: 0; font-size: 34px; line-height: 1.15; letter-spacing: -0.03em; font-weight: 800; }
      .coverMeta { margin: 10px 0 0; font-size: 13px; opacity: 0.95; }

      .stack { display: block; }
      .stack > * { margin-bottom: 18px; }
      .stack > *:last-child { margin-bottom: 0; }
      .card {
        background: #ffffff;
        border: 1px solid #e4e4e7;
        border-radius: 12px;
        padding: 20px 22px;
        box-shadow: 0 1px 3px rgba(15, 23, 42, 0.06);
      }
      .avoidBreak { break-inside: avoid; page-break-inside: avoid; }
      .sectionBreak { break-after: page; page-break-after: always; }

      .topbar {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 16px;
        margin-bottom: 8px;
      }
      .title { margin: 0; font-size: 22px; font-weight: 800; letter-spacing: -0.03em; }
      .subtitle { margin: 6px 0 0; font-size: 13px; color: #475569; line-height: 1.5; }

      .badge {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 6px 10px;
        border: 1px solid #e4e4e7;
        background: #fafafa;
        color: #334155;
        border-radius: 999px;
        font-size: 12px;
        white-space: nowrap;
      }

      .metaGrid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 12px; }
      .kv { border: 1px solid #eef2f7; border-radius: 14px; padding: 12px 12px; background: #fbfdff; }
      .k { margin: 0 0 6px; font-size: 11px; color: #64748b; letter-spacing: 0.02em; text-transform: uppercase; }
      .v { margin: 0; font-size: 14px; font-weight: 700; color: #0f172a; }

      .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; }
      .chip {
        display: inline-block;
        padding: 6px 12px;
        border-radius: 6px;
        border: 1px solid #cbd5e1;
        background: #f8fafc;
        color: #475569;
        font-size: 12px;
        font-weight: 600;
        letter-spacing: 0.01em;
      }

      .h2Row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 14px; }
      .h2 { margin: 0; font-size: 15px; font-weight: 800; letter-spacing: -0.02em; flex: 1 1 auto; }
      .scoreBarWrap { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
      .scoreBar { width: 72px; height: 10px; background: #e2e8f0; border-radius: 999px; overflow: hidden; }
      .scoreBarFill { height: 100%; background: linear-gradient(90deg, #475569, #64748b); border-radius: 999px; transition: width 0.2s ease; }
      .scoreNum { font-size: 13px; font-weight: 700; color: #0f172a; min-width: 24px; }
      .p { margin: 0; font-size: 13px; color: #334155; line-height: 1.85; }
      .ul { margin: 0; padding-left: 20px; color: #334155; font-size: 13px; line-height: 1.9; }
      .ul li { margin: 12px 0; padding-left: 4px; }
      .ul li:first-child { margin-top: 4px; }
      .ul li:last-child { margin-bottom: 4px; }

      table { width: 100%; border-collapse: collapse; overflow: hidden; border-radius: 14px; border: 1px solid #e4e4e7; }
      th, td { padding: 10px 12px; border-bottom: 1px solid #e4e4e7; text-align: left; font-size: 13px; }
      th { background: #f8fafc; color: #334155; font-weight: 800; }
      tr:last-child td { border-bottom: 0; }
      .small { font-size: 12px; color: #64748b; }
      .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; }

      .footer { font-size: 11px; color: #64748b; line-height: 1.5; }
    </style>
  </head>
  <body>
    <div class="pageBg" style="${pageBackgroundStyle}"></div>
    <div class="pageBgOverlay"></div>
    ${footerLogoHtml}
    <div class="page">
      <section class="coverPage">
        <div class="coverOverlay">
          <p class="coverEyebrow">SAJU REPORT</p>
          <h1 class="coverTitle">${escapeHtml_(params.name)}님 정통 평생 운세</h1>
          <p class="coverMeta">${escapeHtml_(params.birthLabel)} · ${escapeHtml_(params.calendarLabel)} · ${
    new Date().toISOString().slice(0, 10)
  }</p>
        </div>
      </section>
      <div class="stack">
        <header class="card avoidBreak">
          <div class="topbar">
            <div>
              <h1 class="title">${escapeHtml_(report.title)}</h1>
              <p class="subtitle">${escapeHtml_(report.summary.oneLine)}</p>
            </div>
            <span class="badge">${escapeHtml_(params.calendarLabel)} · 생성일 ${escapeHtml_(
    new Date().toISOString().slice(0, 10),
  )}</span>
          </div>

          <div class="metaGrid">
            <div class="kv">
              <p class="k">Name / Gender</p>
              <p class="v">${escapeHtml_(params.name)} · ${escapeHtml_(params.gender)}</p>
            </div>
            <div class="kv">
              <p class="k">Birth</p>
              <p class="v">${escapeHtml_(params.birthLabel)}</p>
              <p class="small">만세력 기준으로 산출된 사주팔자입니다.</p>
            </div>
          </div>

          <div class="chips">${keywords}</div>
        </header>

        <section class="card avoidBreak">
          <h2 class="h2">핵심 포인트</h2>
          <ul class="ul">${highlights}</ul>
        </section>

        <section class="card avoidBreak">
          <h2 class="h2">사주팔자</h2>
          <table>
            <thead>
              <tr>
                <th>구분</th>
                <th>한글</th>
                <th>한자</th>
              </tr>
            </thead>
            <tbody>
              <tr><td>연주</td><td>${escapeHtml_(fpK.year)}</td><td class="mono">${escapeHtml_(
    fpH.year.hanja,
  )}</td></tr>
              <tr><td>월주</td><td>${escapeHtml_(fpK.month)}</td><td class="mono">${escapeHtml_(
    fpH.month.hanja,
  )}</td></tr>
              <tr><td>일주</td><td>${escapeHtml_(fpK.day)}</td><td class="mono">${escapeHtml_(
    fpH.day.hanja,
  )}</td></tr>
              <tr><td>시주</td><td>${escapeHtml_(fpK.hour)}</td><td class="mono">${escapeHtml_(
    fpH.hour.hanja,
  )}</td></tr>
            </tbody>
          </table>
          <div class="metaGrid" style="margin-top: 10px;">
            <div class="kv">
              <p class="k">Elements (Day)</p>
              <p class="v">천간=${escapeHtml_(saju.dayElement.stem)} · 지지=${escapeHtml_(
    saju.dayElement.branch,
  )}</p>
            </div>
            <div class="kv">
              <p class="k">Yin/Yang (Day)</p>
              <p class="v">천간=${escapeHtml_(saju.dayYinYang.stem)} · 지지=${escapeHtml_(
    saju.dayYinYang.branch,
  )}</p>
            </div>
          </div>
        </section>

        ${sections}

        <section class="card avoidBreak">
          <h2 class="h2">오행 밸런스</h2>
          <p class="p">${escapeHtml_(report.elementBalance.analysis)}</p>
          <ul class="ul" style="margin-top: 8px;">${tips}</ul>
        </section>

        <footer class="card avoidBreak footer">
          ${escapeHtml_(report.disclaimer)}
        </footer>
      </div>
    </div>
  </body>
</html>`;
}

/** Extract score from heading like "01. 사주풀이 [종합 운명 점수: 85/100]" → { titleOnly: "01. 사주풀이", score: 85 } */
function parseHeadingScore_(heading: string): { titleOnly: string; score: number | null } {
  const match = heading.match(/(\d{1,3})\s*\/\s*100\s*\]/);
  if (!match) return { titleOnly: heading, score: null };
  const score = Math.min(100, Math.max(0, parseInt(match[1], 10)));
  const titleOnly = heading.replace(/\s*\[[^\]]*\d{1,3}\s*\/\s*100\s*\]\s*$/, "").trim();
  return { titleOnly: titleOnly || heading, score };
}

function escapeHtml_(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeCssUrl_(s: string): string {
  return String(s).replace(/["'()\\\n\r]/g, "");
}
