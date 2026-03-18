import { z } from "zod";

/** PDF 형식 12장 구조 (사주결과.pdf 목차 기준) */
export const REPORT_CHAPTER_TITLES = [
  "사주에 대하여",
  "나의 사주팔자",
  "일주로 보는 나의 성격",
  "십성 분석",
  "십이운성 분석",
  "십이신살 및 귀인 분석",
  "연애운 및 결혼운 분석",
  "재물운 분석",
  "직업운 분석",
  "건강운 분석",
  "나의 대운",
  "나의 6년간 연운",
] as const;

export const reportContentSchema = z.object({
  title: z.string().min(1).max(80),
  summary: z.object({
    oneLine: z.string().min(1).max(200),
    keywords: z.array(z.string().min(1).max(30)).min(6).max(12),
    highlights: z.array(z.string().min(1).max(180)).min(4).max(10),
  }),
  sections: z
    .array(
      z.object({
        heading: z.string().min(1).max(80),
        body: z.string().min(1200).max(12000),
      }),
    )
    .length(12),
  elementBalance: z.object({
    analysis: z.string().min(1).max(900),
    tips: z.array(z.string().min(1).max(180)).min(4).max(10),
  }),
  disclaimer: z.string().min(1).max(300),
});

export type ReportContent = z.infer<typeof reportContentSchema>;
