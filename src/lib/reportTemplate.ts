import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { ReportContent } from "@/lib/reportSchema";
import type { SajuResult } from "@/lib/saju";
import { reportContentToDocument } from "@/lib/reportContentToDocument";
import type { ReportDocument } from "@/lib/reportDocumentSchema";
import { renderReportFromDocument } from "@/lib/reportDocumentTemplate";

/** 서버에서 public 경로 파일을 읽어 data URL로 반환. 실패 시 원본 경로 그대로 반환. */
async function readPublicFileAsDataUrl(publicPath: string): Promise<string> {
  if (!publicPath.startsWith("/")) return publicPath;
  const fullPath = path.join(process.cwd(), "public", publicPath);
  if (!existsSync(fullPath)) return publicPath;
  try {
    const buf = await readFile(fullPath);
    const ext = path.extname(publicPath).toLowerCase();
    const mime = ext === ".png" ? "image/png" : ext === ".svg" ? "image/svg+xml" : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "image/png";
    return `data:${mime};base64,${buf.toString("base64")}`;
  } catch {
    return publicPath;
  }
}

async function readWorkspaceImageAsDataUrl(workspaceRelativePath: string): Promise<string | null> {
  const fullPath = path.join(process.cwd(), workspaceRelativePath);
  if (!existsSync(fullPath)) return null;
  try {
    const buf = await readFile(fullPath);
    const ext = path.extname(fullPath).toLowerCase();
    const mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".png" ? "image/png" : "image/jpeg";
    return `data:${mime};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

/** document 내 상대 경로 이미지(/로 시작)를 public 폴더 기준 data URL로 치환. PDF 렌더 시 엑박 방지. */
function joinUrl(baseUrl: string, relativePath: string): string {
  return new URL(relativePath.replace(/^\//, ""), baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
}

export async function embedPublicImagesInDocument(document: ReportDocument, assetBaseUrl?: string): Promise<ReportDocument> {
  const blocks = await Promise.all(
    document.blocks.map(async (block) => {
      if (block.type === "profileWithAnimal" && block.animalImageSrc.startsWith("/")) {
        if (assetBaseUrl) {
          return { ...block, animalImageSrc: joinUrl(assetBaseUrl, block.animalImageSrc) };
        }
        const dataUrl = await readPublicFileAsDataUrl(block.animalImageSrc);
        return { ...block, animalImageSrc: dataUrl };
      }
      if (block.type === "chapterImagePage") {
        if (assetBaseUrl) {
          return {
            ...block,
            src: `${joinUrl(assetBaseUrl, "api/asset/workspace")}?path=${encodeURIComponent(block.src)}`,
          };
        }
        const dataUrl = await readWorkspaceImageAsDataUrl(block.src);
        return dataUrl ? { ...block, src: dataUrl } : ({ type: "title", text: block.alt ?? "" } as const);
      }
      return block;
    }),
  );
  return { ...document, blocks };
}

export async function renderReportHtml(params: {
  name: string;
  gender?: string;
  calendarLabel: string;
  birthLabel: string;
  assetBaseUrl?: string;
  backgroundImageUrl?: string;
  footerLogoUrl?: string;
  /** Optional image URL shown between each section. Set REPORT_SECTION_DIVIDER_IMAGE_URL in env. */
  sectionDividerImageUrl?: string;
  saju: SajuResult;
  report: ReportContent;
  /** LLM-generated per-chapter one-line summaries (12 items) */
  chapterOneLiners?: string[];
}): Promise<string> {
  const document = reportContentToDocument(params.report, {
    name: params.name,
    gender: params.gender,
    calendarLabel: params.calendarLabel,
    birthLabel: params.birthLabel,
    saju: params.saju,
    chapterOneLiners: params.chapterOneLiners,
  });
  const documentWithEmbeddedImages = await embedPublicImagesInDocument(document, params.assetBaseUrl);

  // 2페이지(본문)부터는 한지 배경 고정 사용
  const hanjiBgDataUrl = params.assetBaseUrl
    ? `${joinUrl(params.assetBaseUrl, "api/asset/workspace")}?path=${encodeURIComponent("src/asset/images/hanji_back.jpg")}`
    : await readWorkspaceImageAsDataUrl("src/asset/images/hanji_back.jpg");

  return renderReportFromDocument(documentWithEmbeddedImages, {
    name: params.name,
    gender: params.gender,
    calendarLabel: params.calendarLabel,
    birthLabel: params.birthLabel,
    backgroundImageUrl: params.backgroundImageUrl,
    contentBackgroundImageUrl: hanjiBgDataUrl ?? undefined,
    footerLogoUrl: params.footerLogoUrl,
    sectionDividerImageUrl: params.sectionDividerImageUrl,
  });
}
