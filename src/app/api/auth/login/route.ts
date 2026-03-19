import { NextResponse } from "next/server";

import {
  ADMIN_SESSION_COOKIE,
  createAdminSessionToken,
  getAdminPassword,
} from "@/lib/auth";

function resolveNextPath(raw: FormDataEntryValue | null): string {
  const value = typeof raw === "string" ? raw : "";
  return value.startsWith("/") ? value : "/";
}

export async function POST(req: Request) {
  const formData = await req.formData();
  const password = String(formData.get("password") || "");
  const nextPath = resolveNextPath(formData.get("next"));

  if (password !== getAdminPassword()) {
    const loginUrl = new URL("/login", req.url);
    loginUrl.searchParams.set("error", "1");
    if (nextPath !== "/") {
      loginUrl.searchParams.set("next", nextPath);
    }
    return NextResponse.redirect(loginUrl, { status: 303 });
  }

  const response = NextResponse.redirect(new URL(nextPath, req.url), { status: 303 });
  response.cookies.set({
    name: ADMIN_SESSION_COOKIE,
    value: createAdminSessionToken(),
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  });
  return response;
}
