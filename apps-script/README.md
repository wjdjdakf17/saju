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
- `MAX_JOBS_PER_RUN`: 1회 poll 실행에서 처리할 최대 행 수 (기본 `6`)
- `MAX_RETRY_ERRORS`: 일시 오류(429/502/503/504) 허용 횟수 (기본 `40`)
- `MAX_JOB_MINUTES`: 단일 작업 최대 허용 시간(분) (기본 `180`)
- `STALL_MINUTES`: 진행률 정체 허용 시간(분) (기본 `15`)

### 3) 트리거 생성(설치형)
- Apps Script 편집기에서 **트리거(시계 아이콘)** → 트리거 추가
- 함수: `onFormSubmit`
- 이벤트 소스: 스프레드시트에서
- 이벤트 유형: 폼 제출 시 (또는 시트에 폼 응답이 들어올 때)

추가 설명:
- `onFormSubmit`은 `/start`만 호출하고 빠르게 종료됩니다.
- 실제 폴링은 `pollPendingJobs`가 수행하며, `onFormSubmit`이 처음 실행될 때 1분 주기 시간 트리거를 자동 생성합니다.
- 대기 작업이 0개가 되면 `pollPendingJobs` 트리거는 자동 삭제됩니다.
- 수동 설치/삭제가 필요하면 Apps Script에서 `installPollerTrigger`, `uninstallPollerTrigger`를 실행하세요.

### 4) 시트에 생성되는 컬럼
이 스크립트는 헤더(1행)에 아래 컬럼이 없으면 자동으로 추가합니다.

- `PDF_URL`
- `STATUS`
- `ERROR`
- `JOB_TOKEN`
- `JOB_STARTED_AT`
- `JOB_LAST_PROGRESS_AT`
- `JOB_LAST_PROGRESS`
- `JOB_RETRY_ERRORS`
- `JOB_EMAIL`
- `JOB_NAME`
