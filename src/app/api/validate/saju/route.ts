import { NextResponse } from "next/server";
import { z } from "zod";

import { optionalGenderSchema } from "@/lib/asyncJob";
import { computeSaju } from "@/lib/saju";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const requestSchema = z.object({
  name: z.string().trim().min(1).max(50),
  gender: optionalGenderSchema,
  birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "birthDate must be YYYY-MM-DD"),
  birthTime: z.string().regex(/^\d{2}:\d{2}$/, "birthTime must be HH:MM"),
});

function isValidDatePart(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function parseBirth(birthDate: string, birthTime: string) {
  const [y, m, d] = birthDate.split("-").map((v) => Number(v));
  const [h, min] = birthTime.split(":").map((v) => Number(v));

  if (
    !Number.isInteger(y) ||
    !Number.isInteger(m) ||
    !Number.isInteger(d) ||
    !Number.isInteger(h) ||
    !Number.isInteger(min)
  ) {
    return null;
  }

  if (y < 1900 || y > 2100) return null;
  if (m < 1 || m > 12) return null;
  if (!isValidDatePart(y, m, d)) return null;
  if (h < 0 || h > 23) return null;
  if (min < 0 || min > 59) return null;

  return { year: y, month: m, day: d, hour: h, minute: min };
}

export async function POST(req: Request) {
  try {
    const json = await req.json();
    const parsed = requestSchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "invalid_request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const birth = parseBirth(parsed.data.birthDate, parsed.data.birthTime);
    if (!birth) {
      return NextResponse.json(
        {
          error: "invalid_birth",
          message:
            "생년월일 또는 태어난시간 형식이 올바르지 않습니다. YYYY-MM-DD / HH:MM 형식을 사용하세요.",
        },
        { status: 400 },
      );
    }

    const saju = computeSaju({
      calendar: "solar",
      birth,
      isLeapMonth: false,
    });

    return NextResponse.json({
      status: "ok",
      input: {
        name: parsed.data.name,
        gender: parsed.data.gender,
        birthDate: parsed.data.birthDate,
        birthTime: parsed.data.birthTime,
        calendar: "solar",
      },
      normalizedBirth: birth,
      saju,
      verifiedAt: new Date().toISOString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown_error";
    return NextResponse.json({ error: "server_error", message }, { status: 500 });
  }
}
