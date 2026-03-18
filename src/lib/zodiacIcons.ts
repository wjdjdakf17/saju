import type { EarthlyBranch } from "manseryeok";

/**
 * 12지지 → 동물 이미지 경로.
 * public/12jigan/ 아래 영문 파일명 (src/asset/images/12jigan 과 동일).
 */
export const ZODIAC_ICON_BY_BRANCH: Record<EarthlyBranch, string> = {
  자: "/12jigan/mouse.png",
  축: "/12jigan/cow.png",
  인: "/12jigan/tiger.png",
  묘: "/12jigan/rabbit.png",
  진: "/12jigan/dragon.png",
  사: "/12jigan/snake.png",
  오: "/12jigan/horse.png",
  미: "/12jigan/sheep.png",
  신: "/12jigan/monkey.png",
  유: "/12jigan/chicken.png",
  술: "/12jigan/dog.png",
  해: "/12jigan/pig.png",
};

