import { z } from "zod";

export const reportContentSchema = z.object({
  title: z.string().min(1).max(80),
  summary: z.object({
    oneLine: z.string().min(1).max(200),
    keywords: z.array(z.string().min(1).max(30)).min(6).max(12),
    highlights: z.array(z.string().min(1).max(120)).min(4).max(10),
  }),
  sections: z
    .array(
      z.object({
        heading: z.string().min(1).max(80),
        bullets: z.array(z.string().min(1).max(350)).min(6).max(16),
      }),
    )
    .length(14),
  elementBalance: z.object({
    analysis: z.string().min(1).max(900),
    tips: z.array(z.string().min(1).max(180)).min(4).max(10),
  }),
  disclaimer: z.string().min(1).max(300),
});

export type ReportContent = z.infer<typeof reportContentSchema>;
