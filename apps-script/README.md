## Apps Script 설정

### 1) 스크립트 만들기
- Google Sheets(응답이 저장되는 시트)에서 **확장 프로그램 → Apps Script**로 이동
- 이 레포의 `apps-script/Code.gs` 내용을 복사해서 붙여넣기

### 2) Script Properties(필수)
Apps Script 편집기에서 **프로젝트 설정 → 스크립트 속성**에 아래 키를 추가하세요.

- `VERCEL_ENDPOINT`: `https://<your-vercel-app>.vercel.app/api/generate` (스크립트가 `/start`, `/poll`를 자동으로 붙여 호출)
- `WEBHOOK_SECRET`: Vercel 환경변수 `WEBHOOK_SECRET`와 동일한 값

선택:
- `DRIVE_FOLDER_ID`: 업로드할 Drive 폴더 ID (미설정 시 내 드라이브 루트)
- `PUBLIC_SHARE`: `true`/`false` (기본 `true`, 링크 있는 사람 보기)
- `EMAIL_FIELD`: 폼에서 이메일을 받는 질문 제목 (기본 `이메일`)
- `MAX_POLLS`: 최대 폴링 횟수 (기본 `80`)
- `POLL_INTERVAL_MS`: 폴링 간격 ms (기본 `2500`)

### 3) 트리거 생성(설치형)
- Apps Script 편집기에서 **트리거(시계 아이콘)** → 트리거 추가
- 함수: `onFormSubmit`
- 이벤트 소스: 스프레드시트에서
- 이벤트 유형: 폼 제출 시 (또는 시트에 폼 응답이 들어올 때)

### 4) 시트에 생성되는 컬럼
이 스크립트는 헤더(1행)에 아래 컬럼이 없으면 자동으로 추가합니다.

- `PDF_URL`
- `STATUS`
- `ERROR`
