import type { SajuResult } from "@/lib/saju";

export function generateFallbackHtml(params: {
  name: string;
  gender: string;
  calendarLabel: string;
  birthLabel: string;
  backgroundImageUrl?: string;
  footerLogoUrl?: string;
  saju: SajuResult;
}): string {
  const { saju } = params;
  const { korean, hanja } = saju.fourPillars;
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
    <title>${escapeHtml_(params.name)} 사주 리포트</title>
    <style>
      @import url('https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;700;800&family=Noto+Sans+KR:wght@400;500;700;800&display=swap');
      :root { color-scheme: light; }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "Noto Sans KR", "Noto Sans JP", "Noto Sans CJK KR", system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple SD Gothic Neo", sans-serif;
        background: #efe7da;
        color: #18181b;
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
      }
      .pageBg { position: fixed; inset: 0; z-index: 0; background-position: center top; background-repeat: no-repeat; background-size: cover; }
      .pageBgOverlay { position: fixed; inset: 0; z-index: 0; background: rgba(255, 255, 255, 0.68); }
      .pageFooterLogo { position: fixed; left: 50%; bottom: 4mm; transform: translateX(-50%); width: 24mm; height: auto; z-index: 2; opacity: 0.95; }
      .page { position: relative; z-index: 1; max-width: 820px; margin: 0 auto; padding: 28px; }
      .card { background: #fff; border: 1px solid #e4e4e7; border-radius: 16px; padding: 20px; }
      .header { display:flex; justify-content:space-between; gap: 16px; align-items:flex-start; }
      .title { font-size: 22px; font-weight: 700; margin: 0; letter-spacing: -0.02em; }
      .muted { color: #52525b; font-size: 13px; margin: 6px 0 0; }
      .grid { display:grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 14px; }
      .kv { border: 1px solid #e4e4e7; border-radius: 12px; padding: 12px; }
      .k { font-size: 12px; color:#71717a; margin: 0 0 6px; }
      .v { font-size: 14px; font-weight: 600; margin: 0; }
      table { width: 100%; border-collapse: collapse; margin-top: 14px; overflow: hidden; border-radius: 12px; border: 1px solid #e4e4e7; }
      th, td { padding: 10px 12px; border-bottom: 1px solid #e4e4e7; text-align: left; font-size: 13px; }
      th { background: #fafafa; color:#3f3f46; font-weight: 700; }
      tr:last-child td { border-bottom: 0; }
      .pill { display:inline-block; padding: 2px 10px; border: 1px solid #e4e4e7; border-radius: 999px; font-size: 12px; color:#3f3f46; background:#fff; }
      .footer { margin-top: 14px; font-size: 11px; color:#71717a; line-height: 1.5; }
    </style>
  </head>
  <body>
    <div class="pageBg" style="${pageBackgroundStyle}"></div>
    <div class="pageBgOverlay"></div>
    ${footerLogoHtml}
    <div class="page">
      <div class="card">
        <div class="header">
          <div>
            <h1 class="title">사주 리포트 (Fallback)</h1>
            <p class="muted">Gemini 없이도 PDF 파이프라인이 정상 동작하는지 확인하기 위한 기본 템플릿입니다.</p>
          </div>
          <span class="pill">${escapeHtml_(params.calendarLabel)}</span>
        </div>

        <div class="grid">
          <div class="kv">
            <p class="k">이름 / 성별</p>
            <p class="v">${escapeHtml_(params.name)} · ${escapeHtml_(params.gender)}</p>
          </div>
          <div class="kv">
            <p class="k">생년월일/시간</p>
            <p class="v">${escapeHtml_(params.birthLabel)}</p>
          </div>
        </div>

        <table>
          <thead>
            <tr>
              <th>구분</th>
              <th>한글</th>
              <th>한자</th>
            </tr>
          </thead>
          <tbody>
            <tr><td>연주</td><td>${escapeHtml_(korean.year)}</td><td>${escapeHtml_(hanja.year.hanja)}</td></tr>
            <tr><td>월주</td><td>${escapeHtml_(korean.month)}</td><td>${escapeHtml_(hanja.month.hanja)}</td></tr>
            <tr><td>일주</td><td>${escapeHtml_(korean.day)}</td><td>${escapeHtml_(hanja.day.hanja)}</td></tr>
            <tr><td>시주</td><td>${escapeHtml_(korean.hour)}</td><td>${escapeHtml_(hanja.hour.hanja)}</td></tr>
          </tbody>
        </table>

        <div class="grid">
          <div class="kv">
            <p class="k">오행(일간/일지)</p>
            <p class="v">천간=${escapeHtml_(saju.dayElement.stem)} · 지지=${escapeHtml_(saju.dayElement.branch)}</p>
          </div>
          <div class="kv">
            <p class="k">음양(일간/일지)</p>
            <p class="v">천간=${escapeHtml_(saju.dayYinYang.stem)} · 지지=${escapeHtml_(saju.dayYinYang.branch)}</p>
          </div>
        </div>

        <div class="footer">
          면책: 본 문서는 참고용이며, 의학·법률·투자 조언이 아닙니다.
        </div>
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

function escapeCssUrl_(s: string): string {
  return String(s).replace(/["'()\\\n\r]/g, "");
}
