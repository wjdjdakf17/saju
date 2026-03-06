import { calculateFourPillars } from "manseryeok";

export type CalendarType = "solar" | "lunar";

export type BirthInput = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};

export type SajuResult = {
  fourPillars: {
    korean: { year: string; month: string; day: string; hour: string };
    hanja: {
      year: { korean: string; hanja: string };
      month: { korean: string; hanja: string };
      day: { korean: string; hanja: string };
      hour: { korean: string; hanja: string };
    };
    fullKorean: string;
    fullHanja: string;
  };
  dayElement: { stem: string; branch: string };
  dayYinYang: { stem: string; branch: string };
};

export function computeSaju(params: {
  calendar: CalendarType;
  birth: BirthInput;
  isLeapMonth?: boolean;
}): SajuResult {
  const fp = calculateFourPillars({
    ...params.birth,
    isLunar: params.calendar === "lunar",
    isLeapMonth: params.calendar === "lunar" ? !!params.isLeapMonth : undefined,
  });

  return {
    fourPillars: {
      korean: fp.toObject(),
      hanja: fp.toHanjaObject(),
      fullKorean: fp.toString(),
      fullHanja: fp.toHanjaString(),
    },
    dayElement: fp.dayElement,
    dayYinYang: fp.dayYinYang,
  };
}

