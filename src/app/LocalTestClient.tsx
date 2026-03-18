"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type Birth = { year: number; month: number; day: number; hour: number; minute: number };
type Calendar = "solar" | "lunar";
type LlmProvider = "openai" | "gemini";

const MODEL_OPTIONS: Record<LlmProvider, string[]> = {
  openai: ["gpt-5", "gpt-5-mini", "gpt-4o-mini"],
  gemini: ["gemini-3.1-flash", "gemini-2.5-flash", "gemini-2.5-pro"],
};

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

function sanitizeLogPayload(payload: unknown): unknown {
  if (payload == null) return payload;
  if (typeof payload === "string") {
    return payload.length > 500 ? `${payload.slice(0, 500)}... [truncated ${payload.length - 500} chars]` : payload;
  }
  if (Array.isArray(payload)) {
    return payload.slice(0, 20).map(sanitizeLogPayload);
  }
  if (typeof payload === "object") {
    const entries = Object.entries(payload as Record<string, unknown>).map(([key, value]) => {
      if (key === "pdfBase64" && typeof value === "string") {
        return [key, `[omitted base64 payload: ${value.length} chars]`];
      }
      if ((key === "html" || key === "body") && typeof value === "string" && value.length > 500) {
        return [key, `${value.slice(0, 500)}... [truncated ${value.length - 500} chars]`];
      }
      return [key, sanitizeLogPayload(value)];
    });
    return Object.fromEntries(entries);
  }
  return payload;
}

export default function LocalTestClient() {
  const [name, setName] = useState("김태윤");
  const [gender, setGender] = useState("남자");
  const [calendar, setCalendar] = useState<Calendar>("solar");
  const [birth, setBirth] = useState<Birth>({ year: 1995, month: 10, day: 7, hour: 10, minute: 0 });
  const [llmProvider, setLlmProvider] = useState<LlmProvider>("openai");
  const [llmModel, setLlmModel] = useState("gpt-5");

  const [running, setRunning] = useState(false);
  const [stage, setStage] = useState<string>("-");
  const [progress, setProgress] = useState<number>(0);
  const [completedSteps, setCompletedSteps] = useState<number>(0);
  const [totalSteps, setTotalSteps] = useState<number>(0);
  const [jobToken, setJobToken] = useState<string>("");
  const [pdfUrl, setPdfUrl] = useState<string>("");
  const [fileName, setFileName] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [logs, setLogs] = useState<Array<{ t: string; label: string; payload: unknown }>>([]);
  const [verifyName, setVerifyName] = useState("김태윤");
  const [verifyBirthDate, setVerifyBirthDate] = useState("1995-10-07");
  const [verifyBirthTime, setVerifyBirthTime] = useState("10:00");
  const [verifyGender, setVerifyGender] = useState("남");
  const [verifyLoading, setVerifyLoading] = useState(false);
  const [verifyError, setVerifyError] = useState("");
  const [verifyResponse, setVerifyResponse] = useState<unknown>(null);

  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setLlmModel(MODEL_OPTIONS[llmProvider][0]);
  }, [llmProvider]);

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

  const pushLog = (label: string, payload: unknown) => {
    setLogs((prev) => [{ t: new Date().toISOString(), label, payload: sanitizeLogPayload(payload) }, ...prev].slice(0, 80));
  };

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
    setJobToken("");
    setError("");
    setLogs([]);
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
          llm: { provider: llmProvider, model: llmModel.trim() || undefined },
        }),
        signal: controller.signal,
      });
      const data = (await res.json()) as StartResponse;
      pushLog("start.response", data);

      if (!res.ok || "error" in data) {
        throw new Error(("message" in data && data.message) || `start_failed:${res.status}`);
      }

      setJobToken(data.jobToken);
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
        pushLog("poll.response", pdata);

        if (!pres.ok || ("error" in pdata && pdata.error)) {
          throw new Error(("message" in pdata && pdata.message) || `poll_failed:${pres.status}`);
        }

        if ("status" in pdata && pdata.status === "processing") {
          token = pdata.jobToken;
          setJobToken(token);
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
      pushLog("client.error", { message: msg, stack: e instanceof Error ? e.stack : undefined });
    }
  };

  return (
    <div className="mt-8 space-y-6">
      <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">로컬 생성 테스트</h2>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
              폼 없이 바로 생성합니다. 진행률/단계/응답 로그를 모두 보여줍니다.
            </p>
          </div>
          <div className="flex gap-2">
            <button
              className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm font-medium text-zinc-900 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-50 dark:hover:bg-zinc-800"
              onClick={reset}
              disabled={running}
            >
              Reset
            </button>
            <button
              className="rounded-lg bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-white"
              onClick={start}
              disabled={!canStart || running}
            >
              {running ? "Running..." : "Start"}
            </button>
            <button
              className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm font-medium text-zinc-900 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-50 dark:hover:bg-zinc-800"
              onClick={stop}
              disabled={!running}
            >
              Stop
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
                <div className="text-xs font-medium text-zinc-600 dark:text-zinc-400">LLM Provider</div>
                <select
                  value={llmProvider}
                  onChange={(e) => setLlmProvider(e.target.value as LlmProvider)}
                  className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-900"
                >
                  <option value="openai">OpenAI</option>
                  <option value="gemini">Gemini</option>
                </select>
              </div>
              <div>
                <div className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Model</div>
                <select
                  value={llmModel}
                  onChange={(e) => setLlmModel(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-900"
                >
                  {MODEL_OPTIONS[llmProvider].map((model) => (
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
                <div className="text-sm font-medium">진행 상황</div>
                <div className="text-sm tabular-nums text-zinc-700 dark:text-zinc-300">{progress}%</div>
              </div>
              <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-900">
                <div className="h-full bg-zinc-900 dark:bg-zinc-50" style={{ width: `${progress}%` }} />
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-zinc-600 dark:text-zinc-400">
                <div>
                  <span className="font-medium text-zinc-700 dark:text-zinc-300">stage</span>: {stage}
                </div>
                <div>
                  <span className="font-medium text-zinc-700 dark:text-zinc-300">steps</span>: {completedSteps}/{totalSteps}
                </div>
                <div>
                  <span className="font-medium text-zinc-700 dark:text-zinc-300">llm</span>: {llmProvider}/{llmModel}
                </div>
                <div className="col-span-2 break-all">
                  <span className="font-medium text-zinc-700 dark:text-zinc-300">jobToken</span>:{" "}
                  {jobToken ? jobToken.slice(0, 48) + "…" : "-"}
                </div>
              </div>

              {error ? (
                <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-200">
                  {error}
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

            <div className="rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
              <div className="mb-2 flex items-center justify-between">
                <div className="text-sm font-medium">로그 (최근 200개)</div>
                <button
                  className="text-xs text-zinc-600 underline hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-50"
                  onClick={() => setLogs([])}
                  type="button"
                >
                  Clear
                </button>
              </div>
              <div className="max-h-[360px] overflow-auto rounded-lg bg-zinc-950 p-3 text-xs text-zinc-100">
                <pre className="whitespace-pre-wrap wrap-break-word">
                  {logs.length
                    ? logs
                        .map((l) => `--- ${l.t} ${l.label} ---\n${JSON.stringify(l.payload, null, 2)}`)
                        .join("\n\n")
                    : "(no logs yet)"}
                </pre>
              </div>
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
