import { createHmac, timingSafeEqual } from "node:crypto";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { getOptionalEnv, mustGetEnv } from "@/lib/env";

export const ADMIN_SESSION_COOKIE = "saju_admin_session";

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;

function getSessionSecret(): string {
  return getOptionalEnv("AUTH_SESSION_SECRET") || mustGetEnv("WEBHOOK_SECRET");
}

function parseCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  const parts = header.split(/;\s*/);
  for (const part of parts) {
    const eqIndex = part.indexOf("=");
    if (eqIndex < 0) continue;
    const key = part.slice(0, eqIndex);
    if (key !== name) continue;
    return decodeURIComponent(part.slice(eqIndex + 1));
  }
  return null;
}

function sign(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

export function getAdminPassword(): string {
  return mustGetEnv("ADMIN_PASSWORD");
}

export function createAdminSessionToken(): string {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + SESSION_TTL_MS })).toString("base64url");
  const signature = sign(payload, getSessionSecret());
  return `${payload}.${signature}`;
}

export function isValidAdminSessionToken(token: string | null | undefined): boolean {
  if (!token) return false;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return false;

  const expectedSignature = sign(payload, getSessionSecret());
  if (!safeEqual(signature, expectedSignature)) return false;

  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: number };
    return typeof decoded.exp === "number" && decoded.exp > Date.now();
  } catch {
    return false;
  }
}

export function isAuthorizedRequest(req: Request): boolean {
  if (process.env.NODE_ENV !== "production") return true;

  const sessionToken = parseCookie(req.headers.get("cookie"), ADMIN_SESSION_COOKIE);
  if (isValidAdminSessionToken(sessionToken)) return true;

  const webhookSecret = getOptionalEnv("WEBHOOK_SECRET");
  const providedSecret = req.headers.get("x-webhook-secret") || "";
  return !!webhookSecret && providedSecret === webhookSecret;
}

export async function isAuthenticatedPageRequest(): Promise<boolean> {
  if (process.env.NODE_ENV !== "production") return true;
  const cookieStore = await cookies();
  return isValidAdminSessionToken(cookieStore.get(ADMIN_SESSION_COOKIE)?.value);
}

export async function requireAuthenticatedPage(nextPath: string): Promise<void> {
  const isAuthenticated = await isAuthenticatedPageRequest();
  if (!isAuthenticated) {
    redirect(`/login?next=${encodeURIComponent(nextPath)}`);
  }
}
