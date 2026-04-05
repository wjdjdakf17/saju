import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { compile } from "typst";

import type { ReportContent } from "@/lib/reportSchema";
import type { SajuResult } from "@/lib/saju";

export async function renderPdfFromTypst(params: {
  name: string;
  gender?: string;
  calendarLabel: string;
  birthLabel: string;
  saju: SajuResult;
  report: ReportContent;
}): Promise<Uint8Array> {
  const tmpRoot = await mkdtemp(path.join(tmpdir(), "saju-typst-"));
  const typPath = path.join(tmpRoot, "report.typ");
  const pdfPath = path.join(tmpRoot, "report.pdf");

  try {
    const typSource = buildTypstDocument_(params);
    await writeFile(typPath, typSource, "utf8");
    await compile(typPath, pdfPath, { format: "pdf" });
    const pdf = await readFile(pdfPath);
    return new Uint8Array(pdf);
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
}

function buildTypstDocument_(params: {
  name: string;
  gender?: string;
  calendarLabel: string;
  birthLabel: string;
  saju: SajuResult;
  report: ReportContent;
}): string {
  const summaryKeywords = params.report.summary.keywords.map((k) => `- ${escapeTypst_(k)}`).join("\n");
  const summaryHighlights = params.report.summary.highlights.map((h) => `- ${escapeTypst_(h)}`).join("\n");
  const sectionBlocks = params.report.sections
    .map((section) => {
      const body = escapeTypst_(section.body || "");
      return `== ${escapeTypst_(section.heading)}\n${body}`;
    })
    .join("\n\n");
  const balanceTips = params.report.elementBalance.tips.map((t) => `- ${escapeTypst_(t)}`).join("\n");

  return `
#set page(margin: (x: 16mm, y: 14mm))
#set text(lang: "ko", size: 10pt)
#set heading(numbering: "1.")

= ${escapeTypst_(params.report.title)}

#box(
  inset: 10pt,
  radius: 8pt,
  stroke: rgb("#cbd5e1"),
  fill: rgb("#f8fafc"),
)[
  *이름:* ${escapeTypst_(params.name)}${params.gender?.trim() ? ` / ${escapeTypst_(params.gender.trim())}` : ""}  \\
  *달력:* ${escapeTypst_(params.calendarLabel)}  \\
  *생년월일:* ${escapeTypst_(params.birthLabel)}  \\
  *사주(한글):* ${escapeTypst_(params.saju.fourPillars.fullKorean)}  \\
  *사주(한자):* ${escapeTypst_(params.saju.fourPillars.fullHanja)}
]

== 한 줄 요약
${escapeTypst_(params.report.summary.oneLine)}

== 키워드
${summaryKeywords}

== 핵심 포인트
${summaryHighlights}

${sectionBlocks}

== 오행 밸런스
${escapeTypst_(params.report.elementBalance.analysis)}

${balanceTips}

== 면책
${escapeTypst_(params.report.disclaimer)}
`.trim();
}

function escapeTypst_(value: string): string {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/#/g, "\\#")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}");
}
