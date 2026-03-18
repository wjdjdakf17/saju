import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_PREFIXES = ["src/asset/images/"];

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".svg") return "image/svg+xml";
  return "application/octet-stream";
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const relPath = url.searchParams.get("path") || "";
  const normalized = relPath.replace(/^\/+/, "");

  if (!ALLOWED_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return NextResponse.json({ error: "forbidden_asset_path" }, { status: 403 });
  }

  const fullPath = path.join(process.cwd(), normalized);
  if (!existsSync(fullPath)) {
    return NextResponse.json({ error: "asset_not_found" }, { status: 404 });
  }

  try {
    const buf = await readFile(fullPath);
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        "Content-Type": getMimeType(fullPath),
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown_error";
    return NextResponse.json({ error: "asset_read_failed", message }, { status: 500 });
  }
}
