import { z } from "zod";

export const reportContentSchema = z.object({
  title: z.string().min(1).max(80),
  summary: z.object({
    oneLine: z.string().min(1).max(200),
    keywords: z.array(z.string().min(1).max(30)).min(4).max(8),
    highlights: z.array(z.string().min(1).max(120)).min(2).max(6),
  }),
  sections: z
    .array(
      z.object({
        heading: z.string().min(1).max(40),
        bullets: z.array(z.string().min(1).max(200)).min(2).max(10),
      }),
    )
    .min(2)
    .max(6),
  elementBalance: z.object({
    analysis: z.string().min(1).max(600),
    tips: z.array(z.string().min(1).max(160)).min(2).max(8),
  }),
  disclaimer: z.string().min(1).max(300),
});

export type ReportContent = z.infer<typeof reportContentSchema>;

