## Saju PDF Generator (Google Form → Vercel → Drive)

Google Form 응답을 트리거로 Vercel API에서 **만세력(`manseryeok`) 계산 → Gemini로 HTML 생성(CSS 포함) → PDF 생성**을 수행하고, Apps Script가 PDF를 Google Drive에 업로드한 뒤 링크를 Google Sheets에 기록합니다.

### 로컬 실행

```bash
npm install
cp .env.example .env.local
npm run dev
```

`.env.local`에 아래 값을 채워주세요.

- `GEMINI_API_KEY`: Gemini API Key (코드 하드코딩 금지, Vercel 환경변수 권장)
- `GEMINI_MODEL`: 기본 `gemini-2.0-flash`
- `OPENAI_API_KEY`: (선택) 설정 시 Gemini 대신 OpenAI 호출
- `OPENAI_MODEL`: (선택) 기본 `gpt-4o-mini`
- `REPORT_COVER_IMAGE_URL`: (선택) 첫 페이지 커버 배경 이미지 URL
- `WEBHOOK_SECRET`: Apps Script와 공유하는 시크릿
- (옵션) `PUPPETEER_EXECUTABLE_PATH`: 로컬 PDF 렌더링용 Chrome 경로

예시:
- `REPORT_COVER_IMAGE_URL=https://<your-vercel-app>.vercel.app/saju-cover-sample.png`

로컬에서 **Gemini 없이** PDF 파이프라인만 빠르게 확인하려면:

```bash
SKIP_GEMINI=true WEBHOOK_SECRET=devsecret \
PUPPETEER_EXECUTABLE_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
PORT=3005 npm run dev
```

그리고 다른 터미널에서:

```bash
WEBHOOK_SECRET=devsecret BASE_URL=http://localhost:3005 bash scripts/smoke-generate.sh
```

### API

`POST /api/generate`  
Headers:
- `X-Webhook-Secret: <WEBHOOK_SECRET>`

Body:

```json
{
  "name": "홍길동",
  "gender": "남",
  "calendar": "solar",
  "birth": { "year": 1992, "month": 10, "day": 24, "hour": 5, "minute": 30 },
  "isLeapMonth": false
}
```

Response:
- `pdfBase64`: base64 encoded PDF
- `fileName`: 파일명
- `meta`: 만세력 일부 결과

### Apps Script

Apps Script 설정은 `apps-script/README.md`를 참고하세요.
