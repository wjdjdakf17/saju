#!/usr/bin/env bash
set -euo pipefail

: "${WEBHOOK_SECRET:?Set WEBHOOK_SECRET}"
: "${BASE_URL:=http://localhost:3000}"
: "${MAX_POLLS:=80}"
: "${POLL_INTERVAL_MS:=2500}"

WEBHOOK_SECRET="$WEBHOOK_SECRET" BASE_URL="$BASE_URL" MAX_POLLS="$MAX_POLLS" POLL_INTERVAL_MS="$POLL_INTERVAL_MS" node - <<'NODE'
const fs = require("fs");

const secret = process.env.WEBHOOK_SECRET;
const baseUrl = process.env.BASE_URL || "http://localhost:3000";
const maxPolls = Number(process.env.MAX_POLLS || "80");
const pollIntervalMs = Number(process.env.POLL_INTERVAL_MS || "2500");

const requestBody = {
  name: "홍길동",
  gender: "남",
  calendar: "solar",
  birth: { year: 1992, month: 10, day: 24, hour: 5, minute: 30 },
  isLeapMonth: false,
};

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Webhook-Secret": secret,
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  return { status: res.status, data };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const start = await postJson(`${baseUrl}/api/generate/start`, requestBody);
  if (start.status < 200 || start.status >= 300 || !start.data?.jobToken) {
    console.error("Start failed:", start.status, start.data);
    process.exit(1);
  }

  let jobToken = start.data.jobToken;

  for (let i = 0; i < maxPolls; i += 1) {
    if (i > 0) await sleep(pollIntervalMs);

    const poll = await postJson(`${baseUrl}/api/generate/poll`, { jobToken });
    if (poll.status < 200 || poll.status >= 300) {
      console.error("Poll failed:", poll.status, poll.data);
      process.exit(1);
    }

    if (poll.data?.status === "completed" && poll.data?.pdfBase64 && poll.data?.fileName) {
      const out = poll.data.fileName.replace(/[\\/:*?"<>|]/g, "_");
      fs.writeFileSync(out, Buffer.from(poll.data.pdfBase64, "base64"));
      console.log("Wrote PDF:", out);
      return;
    }

    if (poll.data?.status === "processing" && poll.data?.jobToken) {
      jobToken = poll.data.jobToken;
      continue;
    }

    console.error("Unexpected poll response:", poll.data);
    process.exit(1);
  }

  console.error("Polling timeout");
  process.exit(1);
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
NODE
