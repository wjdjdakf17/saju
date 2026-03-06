#!/usr/bin/env bash
set -euo pipefail

: "${WEBHOOK_SECRET:?Set WEBHOOK_SECRET}"
: "${BASE_URL:=http://localhost:3000}"

curl -sS "$BASE_URL/api/generate" \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: $WEBHOOK_SECRET" \
  -d '{
    "name": "홍길동",
    "gender": "남",
    "calendar": "solar",
    "birth": { "year": 1992, "month": 10, "day": 24, "hour": 5, "minute": 30 },
    "isLeapMonth": false
  }' \
| node -e '
  const fs = require("fs");
  const data = JSON.parse(fs.readFileSync(0, "utf8"));
  if (!data.pdfBase64 || !data.fileName) {
    console.error("Unexpected response:", data);
    process.exit(1);
  }
  const out = data.fileName.replace(/[\\/:*?\"<>|]/g, "_");
  fs.writeFileSync(out, Buffer.from(data.pdfBase64, "base64"));
  console.log("Wrote PDF:", out);
'

