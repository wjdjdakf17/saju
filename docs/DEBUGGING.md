# 디버깅 & 속도

## 왜 GPT 쓰면 느리게 느껴지나

1. **1분마다 poll 한 번**  
   Apps Script 트리거가 1분 간격이라, 단계가 16개면 이론상 **최소 16분** 걸립니다.
2. **섹션을 14번 나눠 호출**  
   원래는 섹션 1개당 LLM 1번 → 14번 호출. 지금은 **섹션을 묶어서** 한 번에 2~3개씩 생성하므로 poll 횟수가 줄어듭니다.
3. **모델**  
   `gpt-4o-mini`가 가장 빠르고, `gpt-4o` / `gpt-4`는 호출당 지연이 큽니다.

### 더 빠르게 쓰려면

- **환경변수**  
  - `SECTION_BATCH_SIZE=3` (기본): 한 번에 섹션 3개 생성 → poll 약 7번 (summary 1 + 섹션 5 + tail 1 + render 1).  
  - `SECTION_BATCH_SIZE=5`로 올리면 poll이 더 줄어들지만, 한 번에 생성하는 토큰이 많아져 호출당 시간·비용이 늘 수 있음.
- **모델**  
  - 속도 우선이면 `OPENAI_MODEL=gpt-4o-mini` 사용.

---

# 진행이 0%에서 멈출 때 확인 방법

## 10분 지나도 0%면 → poll이 안 돌고 있는 것

진행이 **한 번도** 안 올라가면(0% 고정) **1분마다 도는 poll 트리거가 없거나, 돌아도 그 시트를 못 찾는 경우**가 대부분입니다.

### 1) 수동 poll로 API부터 확인

1. Apps Script 편집기에서 **함수 선택** → **runOnePollManually** 선택 후 **실행**.
2. 시트를 보면 **LAST_POLL_AT**, **LAST_POLL_STATUS**, **STATUS**가 갱신됩니다.
   - **STATUS**가 `PROCESSING 5%`처럼 바뀌면 → API는 정상. **트리거가 안 돌고 있는 것**이므로 아래 2)로 가세요.
   - **ERROR**에 메시지가 찍히면 → API 에러(주소/시크릿/서버 에러). 그 메시지로 원인 확인.

### 2) 1분 트리거 반드시 추가

- 왼쪽 **트리거(시계 아이콘)** → **트리거 추가**
- **함수**: `pollPendingJobs`
- **이벤트**: **시간 기반** → **분 기반 타이머** → **1분마다**
- 저장 후 트리거 목록에 **두 개** 있어야 함: `onFormSubmit`(양식 제출 시) + `pollPendingJobs`(1분마다).

또는 편집기에서 **installPollerTrigger** 한 번 실행해서 트리거 생성.

### 3) 스프레드시트가 맞는지

- 이 스크립트가 **폼 응답 받는 그 스프레드시트에 연결**돼 있어야 합니다.
- 폼 제출 시 `SPREADSHEET_ID`가 저장되므로, **한 번은 폼 제출 후**에 1분 트리거가 돌아야 poll이 해당 시트를 찾습니다.

---

## 1. 스프레드시트 ERROR 컬럼 먼저 보기

- **STATUS**가 `PROCESSING 0%`인데 **ERROR**에 문구가 있으면 → **poll이 한 번이라도 호출됐고, API가 에러를 반환한 것**입니다.
- 예: `Vercel poll error: 500 {"error":"server_error","message":"Missing required env var: OPENAI_API_KEY"}`
- 여기서 `message`나 `error` 값을 보면 원인을 알 수 있습니다.

## 2. ERROR가 비어 있는데 0%에서 멈춤

- **poll이 호출되지 않고 있을 가능성**이 큽니다.
- Apps Script **시간 기반 트리거**가 1분마다 `pollPendingJobs`를 실행합니다.
- 확인:
  - 편집기에서 **프로젝트 설정** → **트리거**에 `pollPendingJobs` 1분마다 있는지 확인.
  - 없으면: 폼 제출 후 한 번 **ensurePollerTrigger** 함수를 수동 실행해 트리거를 만들어 두세요.
- 시트에 **JOB_TOKEN**이 들어 있어야 poll 대상입니다. **STATUS**가 `DONE`/`FAILED`가 아니고 **JOB_TOKEN**이 있는 행만 poll 합니다.

## 3. 수동으로 poll 호출해서 응답 확인

로컬 또는 배포 URL 기준으로:

```bash
# 1) start 호출 후 jobToken 복사
curl -s -X POST "https://YOUR_VERCEL_URL/api/generate/start" \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: YOUR_WEBHOOK_SECRET" \
  -d '{"name":"홍길동","gender":"남","calendar":"solar","birth":{"year":1992,"month":10,"day":24,"hour":5,"minute":30},"isLeapMonth":false}' | jq .

# 2) 위에서 받은 jobToken으로 poll 호출 (실패 시 여기서 에러 메시지가 나옴)
curl -s -X POST "https://YOUR_VERCEL_URL/api/generate/poll" \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: YOUR_WEBHOOK_SECRET" \
  -d '{"jobToken":"여기에_복사한_jobToken"}' | jq .
```

- **200 + status: "processing"** → 정상 진행 중. `stage`, `progressPercent` 확인.
- **4xx/5xx + error, message** → 여기서 실패 원인 확인 (예: `openai_request_failed`, `Missing required env var: OPENAI_API_KEY`).

## 4. Vercel(또는 로컬) 로그로 어느 단계에서 실패하는지 보기

- 배포 환경: **Vercel 대시보드** → 해당 프로젝트 → **Logs** (또는 **Functions** 로그).
- 로컬: `npm run dev:pdf` 띄운 터미널 출력.

poll 처리 시 다음 로그가 찍히도록 되어 있습니다.

- `[poll] invalid_job_token` → 토큰 복호화 실패 (시크릿 불일치 등).
- `[poll] stage=summary completedSteps=0` → REPORT_DEBUG_OUTPUT=true일 때만.
- `[poll] running stage: summary (LLM)` → summary 단계(첫 LLM 호출) 진입.
- `[poll] failed` + 메시지/스택 → 에러 발생. 바로 아래에 `LlmRequestError`면 status, provider, details 로그도 출력됨.

**정리:** 0%에서 멈추면 대부분 **첫 poll의 summary 단계**에서 LLM 호출이 실패하는 경우입니다.  
→ **ERROR 셀** 또는 **수동 curl poll 응답** 또는 **서버 로그**에서 `message`/`details`를 보면 원인(API 키 누락, 할당량, 타임아웃 등)을 알 수 있습니다.

## 5. 디버그 출력 켜기

`.env`에 다음을 넣으면 poll 응답에 LLM 단계별 trace가 포함됩니다 (용도: 개발/디버깅).

```bash
REPORT_DEBUG_OUTPUT=true
```

- poll 응답 JSON에 `debug.traces` 배열이 붙고, 각 단계별 prompt/raw 등이 포함됩니다.
- 서버 로그에도 `[poll] stage=...`, `[poll] running stage: ...` 가 출력됩니다.
