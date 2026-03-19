import LocalTestClient from "@/app/LocalTestClient";
import { requireAuthenticatedPage } from "@/lib/auth";

export default async function Home() {
  await requireAuthenticatedPage("/");

  return (
    <div className="min-h-screen bg-zinc-50 px-6 py-14 text-zinc-900 dark:bg-black dark:text-zinc-50">
      <main className="mx-auto w-full max-w-3xl">
        <div className="mb-6 flex items-center justify-end">
          <form action="/api/auth/logout" method="post">
            <button
              type="submit"
              className="inline-flex items-center rounded-xl border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-200 dark:hover:bg-zinc-900"
            >
              로그아웃
            </button>
          </form>
        </div>
        {/* <div className="rounded-2xl border border-zinc-200 bg-white p-8 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
          <h1 className="text-2xl font-semibold tracking-tight">Saju PDF Generator</h1>
          <p className="mt-2 text-zinc-600 dark:text-zinc-400">
            Google Form → Apps Script → Vercel API에서 만세력 + Gemini HTML → PDF(base64)를 생성합니다.
          </p>

          <div className="mt-6 space-y-3">
            <div className="text-sm font-medium text-zinc-700 dark:text-zinc-300">API</div>
            <div className="rounded-xl bg-zinc-900 p-4 text-sm text-zinc-50">
              <pre className="whitespace-pre-wrap break-words">
{`POST /api/generate/start
Header: X-Webhook-Secret: <WEBHOOK_SECRET>

{
  "name": "홍길동",
  "gender": "남",
  "calendar": "solar",
  "birth": { "year": 1992, "month": 10, "day": 24, "hour": 5, "minute": 30 },
  "isLeapMonth": false
}

POST /api/generate/poll
Header: X-Webhook-Secret: <WEBHOOK_SECRET>
Body: { "jobToken": "..." }`}
              </pre>
            </div>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              비동기 처리 완료 응답은 <span className="font-mono">pdfBase64</span>와 <span className="font-mono">fileName</span>을 포함합니다.
            </p>
          </div>
        </div> */}

        <LocalTestClient />
      </main>
    </div>
  );
}
