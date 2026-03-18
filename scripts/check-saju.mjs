/**
 * 만세력(computeSaju) 로컬 응답 확인 스크립트
 * 사용: node scripts/check-saju.mjs
 */
import { calculateFourPillars } from "manseryeok";

const birth = {
  year: 1995,
  month: 10,
  day: 7,
  hour: 10,
  minute: 0,
};

const fp = calculateFourPillars({
  ...birth,
  isLunar: false, // 양력
});

const korean = fp.toObject();
const hanja = fp.toHanjaObject();

console.log("=== 만세력 응답 (김태윤, 1995-10-07 오전 10시, 양력) ===\n");

console.log("fourPillars.korean:", JSON.stringify(korean, null, 2));
console.log("\nfourPillars.hanja:", JSON.stringify(hanja, null, 2));
console.log("\nfullKorean:", fp.toString());
console.log("fullHanja:", fp.toHanjaString());
console.log("\ndayElement (일간 오행):", fp.dayElement);
console.log("dayYinYang (일간 음양):", fp.dayYinYang);

console.log("\n=== 전체 SajuResult 형태 ===");
const result = {
  fourPillars: {
    korean,
    hanja,
    fullKorean: fp.toString(),
    fullHanja: fp.toHanjaString(),
  },
  dayElement: fp.dayElement,
  dayYinYang: fp.dayYinYang,
};
console.log(JSON.stringify(result, null, 2));
