"use client";

export default function PreviewPage() {
  return (
    <div className="min-h-screen bg-zinc-100 p-6">
      <div className="mx-auto max-w-lg space-y-4">
        <h1 className="text-xl font-semibold text-zinc-800">PDF 샘플 미리보기</h1>
        <p className="text-sm text-zinc-600">
          스타일 수정 후 아래 링크로 확인하세요. HTML은 새 탭에서 바로 보이고, PDF는 다운로드됩니다.
        </p>
        <div className="flex flex-wrap gap-3">
          <a
            href="/api/preview/report-html"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center rounded-lg bg-zinc-800 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700"
          >
            샘플 리포트 HTML 보기
          </a>
          <a
            href="/api/preview/report-pdf"
            download="sample_saju_report.pdf"
            className="inline-flex items-center rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
          >
            샘플 PDF 다운로드
          </a>
        </div>
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          <strong>로컬에서 스타일링할 때:</strong> reportTemplate.ts 수정 → 저장 → 위 &quot;샘플 리포트 HTML
          보기&quot; 새로고침하면 바로 반영됩니다.
        </div>
      </div>
    </div>
  );
}
