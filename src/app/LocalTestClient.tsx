"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type Birth = { year: number; month: number; day: number; hour: number; minute: number };
type Calendar = "solar" | "lunar";
const GEMINI_MODELS = ["gemini-3.1-flash", "gemini-2.5-flash", "gemini-2.5-pro"] as const;

type StartResponse =
  | { status: "processing"; jobToken: string; progressPercent: number; stage: string; completedSteps: number; totalSteps: number }
  | { error: string; message?: string; details?: unknown };

type PollResponse =
  | { status: "processing"; jobToken: string; progressPercent: number; stage: string; completedSteps: number; totalSteps: number; debug?: unknown }
  | { status: "completed"; fileName: string; pdfBase64: string; meta?: unknown; debug?: unknown }
  | { error: string; message?: string; details?: unknown; debug?: unknown };

type SajuValidateResponse =
  | {
    status: "ok";
    input: { name: string; gender: string; birthDate: string; birthTime: string; calendar: "solar" };
    normalizedBirth: Birth;
    saju: unknown;
    verifiedAt: string;
  }
  | { error: string; message?: string; details?: unknown };

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function base64ToBlob(base64: string, mime = "application/pdf") {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

function getStageLabel(stage: string, running: boolean, error: string, pdfUrl: string): string {
  if (error) return "문제가 발생했어요";
  if (pdfUrl) return "리포트가 완성되었어요";
  if (!running) return "입력 후 생성 버튼을 눌러주세요";

  switch (stage) {
    case "summary":
      return "기본 해석을 준비하고 있어요";
    case "sections":
      return "상세 내용을 작성하고 있어요";
    case "tail":
      return "마무리 내용을 정리하고 있어요";
    case "render":
      return "PDF 파일로 정리하고 있어요";
    case "completed":
      return "리포트가 완성되었어요";
    default:
      return "리포트를 준비하고 있어요";
  }
}

function getStageDescription(stage: string, running: boolean, error: string, pdfUrl: string): string {
  if (error) return "잠시 후 다시 시도해 주세요. 문제가 계속되면 관리자에게 문의해 주세요.";
  if (pdfUrl) return "아래 버튼으로 PDF를 바로 다운로드할 수 있습니다.";
  if (!running) return "정보를 입력하면 개인 맞춤 사주 리포트를 바로 생성할 수 있습니다.";

  switch (stage) {
    case "summary":
      return "사주의 전체 흐름과 핵심 키워드를 분석하고 있습니다.";
    case "sections":
      return "성격, 운세, 오행 등 각 장의 내용을 순서대로 작성하고 있습니다.";
    case "tail":
      return "요약과 주의사항, 마지막 안내 문구를 정리하고 있습니다.";
    case "render":
      return "완성된 내용을 보기 좋은 PDF 형식으로 변환하고 있습니다.";
    default:
      return "조금만 기다려 주세요. 보통 잠시 후 다음 단계로 넘어갑니다.";
  }
}

export default function LocalTestClient() {
  const [name, setName] = useState("김태윤");
  const [gender, setGender] = useState("남자");
  const [calendar, setCalendar] = useState<Calendar>("solar");
  const [birth, setBirth] = useState<Birth>({ year: 1995, month: 10, day: 7, hour: 10, minute: 0 });
  const [llmModel, setLlmModel] = useState<string>(GEMINI_MODELS[0]);

  const [running, setRunning] = useState(false);
  const [stage, setStage] = useState<string>("-");
  const [progress, setProgress] = useState<number>(0);
  const [completedSteps, setCompletedSteps] = useState<number>(0);
  const [totalSteps, setTotalSteps] = useState<number>(0);
  const [pdfUrl, setPdfUrl] = useState<string>("");
  const [fileName, setFileName] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [verifyName, setVerifyName] = useState("김태윤");
  const [verifyBirthDate, setVerifyBirthDate] = useState("1995-10-07");
  const [verifyBirthTime, setVerifyBirthTime] = useState("10:00");
  const [verifyGender, setVerifyGender] = useState("남");
  const [verifyLoading, setVerifyLoading] = useState(false);
  const [verifyError, setVerifyError] = useState("");
  const [verifyResponse, setVerifyResponse] = useState<unknown>(null);

  const abortRef = useRef<AbortController | null>(null);

  const canStart = useMemo(() => {
    return (
      name.trim().length > 0 &&
      gender.trim().length > 0 &&
      birth.year >= 1900 &&
      birth.month >= 1 &&
      birth.day >= 1 &&
      birth.hour >= 0 &&
      birth.minute >= 0
    );
  }, [name, gender, birth]);

  const stageLabel = useMemo(() => getStageLabel(stage, running, error, pdfUrl), [stage, running, error, pdfUrl]);
  const stageDescription = useMemo(
    () => getStageDescription(stage, running, error, pdfUrl),
    [stage, running, error, pdfUrl],
  );

  const canVerify = useMemo(() => {
    return (
      verifyName.trim().length > 0 &&
      verifyGender.trim().length > 0 &&
      /^\d{4}-\d{2}-\d{2}$/.test(verifyBirthDate) &&
      /^\d{2}:\d{2}$/.test(verifyBirthTime)
    );
  }, [verifyName, verifyGender, verifyBirthDate, verifyBirthTime]);

  useEffect(() => {
    if (!canVerify) {
      setVerifyLoading(false);
      setVerifyError("");
      setVerifyResponse(null);
      return;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setVerifyLoading(true);
      try {
        const res = await fetch("/api/validate/saju", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: verifyName.trim(),
            gender: verifyGender.trim(),
            birthDate: verifyBirthDate,
            birthTime: verifyBirthTime,
          }),
          signal: controller.signal,
        });
        const data = (await res.json()) as SajuValidateResponse;
        if (controller.signal.aborted) return;

        setVerifyResponse(data);
        if (!res.ok || ("error" in data && data.error)) {
          setVerifyError(("message" in data && data.message) || `validate_failed:${res.status}`);
        } else {
          setVerifyError("");
        }
      } catch (e) {
        if (controller.signal.aborted) return;
        const msg = e instanceof Error ? e.message : String(e);
        setVerifyError(msg);
        setVerifyResponse({ error: "client_error", message: msg });
      } finally {
        if (!controller.signal.aborted) setVerifyLoading(false);
      }
    }, 350);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [canVerify, verifyName, verifyGender, verifyBirthDate, verifyBirthTime]);

  const stop = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setRunning(false);
  };

  const reset = () => {
    stop();
    setStage("-");
    setProgress(0);
    setCompletedSteps(0);
    setTotalSteps(0);
    setError("");
    if (pdfUrl) URL.revokeObjectURL(pdfUrl);
    setPdfUrl("");
    setFileName("");
  };

  const start = async () => {
    if (!canStart || running) return;
    reset();
    setRunning(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch("/api/generate/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          gender,
          calendar,
          birth,
          isLeapMonth: false,
          llm: { provider: "gemini", model: llmModel.trim() || undefined },
        }),
        signal: controller.signal,
      });
      const data = (await res.json()) as StartResponse;

      if (!res.ok || "error" in data) {
        throw new Error(("message" in data && data.message) || `start_failed:${res.status}`);
      }

      setStage(data.stage);
      setProgress(data.progressPercent);
      setCompletedSteps(data.completedSteps);
      setTotalSteps(data.totalSteps);

      // poll loop
      let token = data.jobToken;
      for (let i = 0; i < 200; i++) {
        await sleep(800);
        const pres = await fetch("/api/generate/poll", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jobToken: token }),
          signal: controller.signal,
        });
        const pdata = (await pres.json()) as PollResponse;

        if (!pres.ok || ("error" in pdata && pdata.error)) {
          throw new Error(("message" in pdata && pdata.message) || `poll_failed:${pres.status}`);
        }

        if ("status" in pdata && pdata.status === "processing") {
          token = pdata.jobToken;
          setStage(pdata.stage);
          setProgress(pdata.progressPercent);
          setCompletedSteps(pdata.completedSteps);
          setTotalSteps(pdata.totalSteps);
          continue;
        }

        if ("status" in pdata && pdata.status === "completed") {
          setStage("completed");
          setProgress(100);
          setFileName(pdata.fileName);
          const blob = base64ToBlob(pdata.pdfBase64);
          const url = URL.createObjectURL(blob);
          setPdfUrl(url);
          setRunning(false);
          abortRef.current = null;
          return;
        }
      }

      throw new Error("poll_timeout");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      setRunning(false);
      abortRef.current = null;
    }
  };

  return (
    <div className="mt-8 space-y-6">
      <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">사주 리포트 생성</h2>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
              고객 정보를 입력하면 Gemini로 사주 리포트를 생성하고 PDF로 내려받을 수 있습니다.
            </p>
          </div>
          <div className="flex gap-2">
            <button
              className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm font-medium text-zinc-900 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-50 dark:hover:bg-zinc-800"
              onClick={reset}
              disabled={running}
            >
              초기화
            </button>
            <button
              className="rounded-lg bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-white"
              onClick={start}
              disabled={!canStart || running}
            >
              {running ? "생성 중..." : "리포트 생성"}
            </button>
            <button
              className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm font-medium text-zinc-900 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-50 dark:hover:bg-zinc-800"
              onClick={stop}
              disabled={!running}
            >
              중지
            </button>
          </div>
        </div>

        <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="space-y-3">
            <div>
              <div className="text-xs font-medium text-zinc-600 dark:text-zinc-400">이름</div>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-900"
              />
            </div>
            <div>
              <div className="text-xs font-medium text-zinc-600 dark:text-zinc-400">성별</div>
              <input
                value={gender}
                onChange={(e) => setGender(e.target.value)}
                className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-900"
              />
            </div>
            <div>
              <div className="text-xs font-medium text-zinc-600 dark:text-zinc-400">양/음력</div>
              <select
                value={calendar}
                onChange={(e) => setCalendar(e.target.value as Calendar)}
                className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-900"
              >
                <option value="solar">양력</option>
                <option value="lunar">음력</option>
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="text-xs font-medium text-zinc-600 dark:text-zinc-400">LLM</div>
                <div className="mt-1 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-900">
                  Gemini
                </div>
              </div>
              <div>
                <div className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Model</div>
                <select
                  value={llmModel}
                  onChange={(e) => setLlmModel(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-900"
                >
                  {GEMINI_MODELS.map((model) => (
                    <option key={model} value={model}>
                      {model}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="grid grid-cols-5 gap-2">
              {(["year", "month", "day", "hour", "minute"] as const).map((k) => (
                <div key={k}>
                  <div className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
                    {k === "year" ? "년" : k === "month" ? "월" : k === "day" ? "일" : k === "hour" ? "시" : "분"}
                  </div>
                  <input
                    type="number"
                    value={birth[k]}
                    onChange={(e) => setBirth((b) => ({ ...b, [k]: Number(e.target.value) }))}
                    className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-900"
                  />
                </div>
              ))}
            </div>
          </div>

          <div className="space-y-3">
            <div className="rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
              <div className="flex items-center justify-between">
                <div className="text-sm font-medium">리포트 제작 상태</div>
                <div className="text-sm tabular-nums text-zinc-700 dark:text-zinc-300">{progress}%</div>
              </div>
              <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-900">
                <div className="h-full bg-zinc-900 dark:bg-zinc-50" style={{ width: `${progress}%` }} />
              </div>
              <div className="mt-4 rounded-xl border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-900/60">
                <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">{stageLabel}</div>
                <p className="mt-2 text-sm leading-6 text-zinc-600 dark:text-zinc-400">{stageDescription}</p>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-zinc-600 dark:text-zinc-400">
                <div>
                  <span className="font-medium text-zinc-700 dark:text-zinc-300">진행 단계</span>: {completedSteps}/{totalSteps || 0}
                </div>
                <div>
                  <span className="font-medium text-zinc-700 dark:text-zinc-300">선택 모델</span>: {llmModel}
                </div>
              </div>

              {error ? (
                <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-200">
                  생성 중 문제가 발생했습니다. 잠시 후 다시 시도해 주세요.
                </div>
              ) : null}

              {pdfUrl ? (
                <div className="mt-4 flex items-center justify-between gap-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3 dark:border-emerald-900/40 dark:bg-emerald-950/30">
                  <div className="text-sm text-emerald-900 dark:text-emerald-100">
                    완료: <span className="font-mono">{fileName || "out.pdf"}</span>
                  </div>
                  <a
                    href={pdfUrl}
                    download={fileName || "out.pdf"}
                    className="rounded-lg bg-emerald-700 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-600"
                  >
                    PDF 다운로드
                  </a>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">만세력 데이터 검증</h2>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
              이름/생년월일/태어난시간/성별만 입력하면 양력 기준 만세력 응답을 자동으로 계속 갱신합니다.
            </p>
          </div>
          <div className="text-xs text-zinc-500 dark:text-zinc-400">
            {!canVerify ? "입력 대기" : verifyLoading ? "검증 중..." : verifyError ? "오류" : "최신 응답"}
          </div>
        </div>

        <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="space-y-3">
            <div>
              <div className="text-xs font-medium text-zinc-600 dark:text-zinc-400">이름</div>
              <input
                value={verifyName}
                onChange={(e) => setVerifyName(e.target.value)}
                className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-900"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="text-xs font-medium text-zinc-600 dark:text-zinc-400">생년월일</div>
                <input
                  type="date"
                  value={verifyBirthDate}
                  onChange={(e) => setVerifyBirthDate(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-900"
                />
              </div>
              <div>
                <div className="text-xs font-medium text-zinc-600 dark:text-zinc-400">태어난시간</div>
                <input
                  type="time"
                  value={verifyBirthTime}
                  onChange={(e) => setVerifyBirthTime(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-900"
                />
              </div>
            </div>

            <div>
              <div className="text-xs font-medium text-zinc-600 dark:text-zinc-400">성별</div>
              <select
                value={verifyGender}
                onChange={(e) => setVerifyGender(e.target.value)}
                className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-900"
              >
                <option value="남">남</option>
                <option value="여">여</option>
                <option value="기타">기타</option>
              </select>
            </div>
          </div>

          <div className="rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
            <div className="mb-2 text-sm font-medium">응답(JSON)</div>
            {verifyError ? (
              <div className="mb-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-200">
                {verifyError}
              </div>
            ) : null}
            <div className="max-h-[360px] overflow-auto rounded-lg bg-zinc-950 p-3 text-xs text-zinc-100">
              <pre className="whitespace-pre-wrap wrap-break-word">
                {JSON.stringify(
                  verifyResponse ?? {
                    message: "입력값을 채우면 만세력 검증 응답이 여기에 표시됩니다.",
                  },
                  null,
                  2,
                )}
              </pre>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
