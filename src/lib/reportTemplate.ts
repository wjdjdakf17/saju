import type { ReportContent } from "@/lib/reportSchema";
import type { SajuResult } from "@/lib/saju";

export function renderReportHtml(params: {
  name: string;
  gender: string;
  calendarLabel: string;
  birthLabel: string;
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
    .map((sec) => {
      const bullets = sec.bullets.map((b) => `<li>${escapeHtml_(b)}</li>`).join("");
      return `
        <section class="card avoidBreak">
          <h2 class="h2">${escapeHtml_(sec.heading)}</h2>
          <ul class="ul">${bullets}</ul>
        </section>
      `;
    })
    .join("");

  const tips = report.elementBalance.tips.map((t) => `<li>${escapeHtml_(t)}</li>`).join("");

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
        background: #f4f4f5;
        color: #0f172a;
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
      }

      .page { max-width: 820px; margin: 0 auto; padding: 0; }
      .stack { display: grid; gap: 12px; }
      .card {
        background: #ffffff;
        border: 1px solid #e4e4e7;
        border-radius: 16px;
        padding: 18px 18px;
        box-shadow: 0 1px 0 rgba(15, 23, 42, 0.03);
      }
      .avoidBreak { break-inside: avoid; page-break-inside: avoid; }

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

      .chips { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
      .chip { display: inline-block; padding: 6px 10px; border-radius: 999px; background: #0ea5e9; color: #ffffff; font-size: 12px; font-weight: 700; }

      .h2 { margin: 0 0 10px; font-size: 15px; font-weight: 800; letter-spacing: -0.02em; }
      .p { margin: 0; font-size: 13px; color: #334155; line-height: 1.65; }
      .ul { margin: 0; padding-left: 16px; color: #334155; font-size: 13px; line-height: 1.65; }
      .ul li { margin: 6px 0; }

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
    <div class="page">
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

function escapeHtml_(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
