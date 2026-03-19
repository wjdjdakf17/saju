type LoginPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function getSingleParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = searchParams ? await searchParams : undefined;
  const next = getSingleParam(params?.next) || "/";
  const hasError = getSingleParam(params?.error) === "1";

  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-950 px-6 py-16 text-zinc-50">
      <div className="w-full max-w-md rounded-3xl border border-zinc-800 bg-zinc-900 p-8 shadow-2xl shadow-black/30">
        <div className="space-y-2">
          <p className="text-sm font-medium uppercase tracking-[0.24em] text-zinc-400">Protected Access</p>
          <h1 className="text-3xl font-semibold tracking-tight">관리자 로그인</h1>
          <p className="text-sm leading-6 text-zinc-400">
            비밀번호를 입력하면 리포트 생성 페이지와 미리보기 페이지에 접근할 수 있습니다.
          </p>
        </div>

        <form action="/api/auth/login" method="post" className="mt-8 space-y-4">
          <input type="hidden" name="next" value={next} />
          <label className="block space-y-2">
            <span className="text-sm font-medium text-zinc-300">비밀번호</span>
            <input
              type="password"
              name="password"
              autoFocus
              required
              className="w-full rounded-2xl border border-zinc-700 bg-zinc-950 px-4 py-3 text-base text-zinc-50 outline-none ring-0 transition focus:border-zinc-500"
              placeholder="관리자 비밀번호"
            />
          </label>
          {hasError ? (
            <p className="rounded-2xl border border-red-950 bg-red-950/40 px-4 py-3 text-sm text-red-200">
              비밀번호가 올바르지 않습니다.
            </p>
          ) : null}
          <button
            type="submit"
            className="w-full rounded-2xl bg-white px-4 py-3 text-sm font-semibold text-zinc-950 transition hover:bg-zinc-200"
          >
            로그인
          </button>
        </form>
      </div>
    </main>
  );
}
