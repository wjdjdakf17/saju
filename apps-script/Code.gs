/**
 * Google Form -> Sheets async flow.
 *
 * 1) onFormSubmit: call /api/generate/start only, store job token, exit quickly
 * 2) pollPendingJobs (time trigger): continue /api/generate/poll per row
 * 3) completed: upload PDF to Drive and update sheet
 */

function onFormSubmit(e) {
  var props = PropertiesService.getScriptProperties();
  var endpoints = buildGenerateEndpoints_(mustGetProp_(props, "VERCEL_ENDPOINT"));
  var WEBHOOK_SECRET = mustGetProp_(props, "WEBHOOK_SECRET");
  var emailField = props.getProperty("EMAIL_FIELD") || "이메일";

  var named = e && e.namedValues ? e.namedValues : {};
  var sheet = e && e.range ? e.range.getSheet() : SpreadsheetApp.getActiveSheet();
  var row = e && e.range ? e.range.getRow() : sheet.getLastRow();

  try {
    var name = pick_(named, ["이름", "name", "Name"]);
    var gender = pick_(named, ["성별", "gender", "Gender"]);
    var calendarRaw = pick_(named, ["양력/음력", "양/음력", "달력", "calendar", "Calendar"]);
    var birthDateRaw = pick_(named, ["생년월일", "birthdate", "Birthdate", "Birthday"]);
    var birthTimeRaw = pick_(named, ["출생시간", "birthtime", "Birthtime"]);
    var email = pick_(named, [emailField, "email", "Email"]);

    var calendar = parseCalendar_(calendarRaw);
    var birthDate = parseDate_(birthDateRaw);
    var birthTime = parseTime_(birthTimeRaw);

    var requestBody = {
      name: name,
      gender: gender,
      calendar: calendar,
      birth: {
        year: birthDate.year,
        month: birthDate.month,
        day: birthDate.day,
        hour: birthTime.hour,
        minute: birthTime.minute
      },
      isLeapMonth: false
    };

    setByHeader_(sheet, row, "STATUS", "PROCESSING 0%");
    setByHeader_(sheet, row, "ERROR", "");

    var startResp = postJson_(endpoints.start, requestBody, WEBHOOK_SECRET);
    if (startResp.status < 200 || startResp.status >= 300) {
      failRow_(sheet, row, "Vercel start error: " + startResp.status + " " + startResp.text);
      return;
    }

    var startData = safeJsonParse_(startResp.text);
    if (!startData || !startData.jobToken) {
      failRow_(sheet, row, "Invalid start response: " + startResp.text);
      return;
    }

    var nowIso = new Date().toISOString();
    setByHeader_(sheet, row, "JOB_TOKEN", String(startData.jobToken));
    setByHeader_(sheet, row, "JOB_STARTED_AT", nowIso);
    setByHeader_(sheet, row, "JOB_LAST_PROGRESS_AT", nowIso);
    setByHeader_(sheet, row, "JOB_LAST_PROGRESS", "0");
    setByHeader_(sheet, row, "JOB_RETRY_ERRORS", "0");
    setByHeader_(sheet, row, "JOB_EMAIL", email || "");
    setByHeader_(sheet, row, "JOB_NAME", name || "");

    ensurePollerTrigger_();
  } catch (err) {
    var message = err && err.message ? err.message : String(err);
    failRow_(sheet, row, "onFormSubmit error: " + message);
  }
}

/**
 * Time-driven trigger entry point (every 1 minute).
 * Processes only a small number of jobs each run to stay within Apps Script limits.
 */
function pollPendingJobs() {
  var props = PropertiesService.getScriptProperties();
  var endpoints = buildGenerateEndpoints_(mustGetProp_(props, "VERCEL_ENDPOINT"));
  var WEBHOOK_SECRET = mustGetProp_(props, "WEBHOOK_SECRET");
  var DRIVE_FOLDER_ID = props.getProperty("DRIVE_FOLDER_ID");
  var PUBLIC_SHARE = (props.getProperty("PUBLIC_SHARE") || "true").toLowerCase() === "true";
  var emailField = props.getProperty("EMAIL_FIELD") || "이메일";

  var MAX_JOBS_PER_RUN = Number(props.getProperty("MAX_JOBS_PER_RUN") || "6");
  var MAX_RETRY_ERRORS = Number(props.getProperty("MAX_RETRY_ERRORS") || "40");
  var MAX_JOB_MINUTES = Number(props.getProperty("MAX_JOB_MINUTES") || "180");
  var STALL_MINUTES = Number(props.getProperty("STALL_MINUTES") || "15");

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheets = ss.getSheets();
  var processed = 0;
  var pendingCount = 0;

  for (var s = 0; s < sheets.length; s++) {
    if (processed >= MAX_JOBS_PER_RUN) break;
    var sheet = sheets[s];
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) continue;

    for (var row = 2; row <= lastRow; row++) {
      if (processed >= MAX_JOBS_PER_RUN) break;
      var status = String(getByHeader_(sheet, row, "STATUS") || "");
      var token = String(getByHeader_(sheet, row, "JOB_TOKEN") || "");
      if (!token) continue;
      if (status === "DONE" || status === "FAILED") continue;

      pendingCount += 1;
      processed += 1;
      try {
        processSinglePendingRow_({
          sheet: sheet,
          row: row,
          token: token,
          status: status,
          endpoints: endpoints,
          webhookSecret: WEBHOOK_SECRET,
          driveFolderId: DRIVE_FOLDER_ID,
          publicShare: PUBLIC_SHARE,
          emailField: emailField,
          maxRetryErrors: MAX_RETRY_ERRORS,
          maxJobMinutes: MAX_JOB_MINUTES,
          stallMinutes: STALL_MINUTES
        });
      } catch (err) {
        var message = err && err.message ? err.message : String(err);
        failRow_(sheet, row, "pollPendingJobs error: " + message);
      }
    }
  }

  var remaining = countPendingJobs_();
  if (remaining === 0) {
    removePollerTrigger_();
  }
}

function processSinglePendingRow_(params) {
  var sheet = params.sheet;
  var row = params.row;
  var token = params.token;

  // Hard timeout by total job age.
  var startedAt = parseDateSafe_(String(getByHeader_(sheet, row, "JOB_STARTED_AT") || ""));
  if (startedAt && (new Date().getTime() - startedAt.getTime()) > params.maxJobMinutes * 60 * 1000) {
    clearJobRuntimeColumns_(sheet, row);
    failRow_(sheet, row, "Job timeout: exceeded " + params.maxJobMinutes + " minutes");
    return;
  }

  var pollResp = postJson_(params.endpoints.poll, { jobToken: token }, params.webhookSecret);
  var pollStatus = pollResp.status;
  if (pollStatus < 200 || pollStatus >= 300) {
    if (pollStatus === 429 || pollStatus === 502 || pollStatus === 503 || pollStatus === 504) {
      var retry = Number(getByHeader_(sheet, row, "JOB_RETRY_ERRORS") || "0") + 1;
      setByHeader_(sheet, row, "JOB_RETRY_ERRORS", String(retry));
      setByHeader_(sheet, row, "STATUS", "PROCESSING (RETRY " + retry + ")");
      if (retry >= params.maxRetryErrors) {
        clearJobRuntimeColumns_(sheet, row);
        failRow_(sheet, row, "Too many transient poll errors: " + retry);
      }
      return;
    }
    clearJobRuntimeColumns_(sheet, row);
    failRow_(sheet, row, "Vercel poll error: " + pollStatus + " " + pollResp.text);
    return;
  }

  var pollData = safeJsonParse_(pollResp.text);
  if (!pollData) {
    clearJobRuntimeColumns_(sheet, row);
    failRow_(sheet, row, "Invalid poll JSON: " + pollResp.text);
    return;
  }

  if (pollData.status === "completed" && pollData.pdfBase64 && pollData.fileName) {
    finalizeCompletedRow_(sheet, row, pollData, params.driveFolderId, params.publicShare, params.emailField);
    return;
  }

  if (pollData.status === "processing" && pollData.jobToken) {
    var nowIso = new Date().toISOString();
    setByHeader_(sheet, row, "JOB_TOKEN", String(pollData.jobToken));
    setByHeader_(sheet, row, "JOB_RETRY_ERRORS", "0");

    var nextProgress = Number.isFinite(Number(pollData.progressPercent))
      ? Number(pollData.progressPercent)
      : null;
    var prevProgress = Number(getByHeader_(sheet, row, "JOB_LAST_PROGRESS") || "-1");
    var lastProgressAt = parseDateSafe_(String(getByHeader_(sheet, row, "JOB_LAST_PROGRESS_AT") || ""));

    if (nextProgress !== null) {
      if (nextProgress > prevProgress) {
        setByHeader_(sheet, row, "JOB_LAST_PROGRESS", String(nextProgress));
        setByHeader_(sheet, row, "JOB_LAST_PROGRESS_AT", nowIso);
      } else if (lastProgressAt && (new Date().getTime() - lastProgressAt.getTime()) > params.stallMinutes * 60 * 1000) {
        clearJobRuntimeColumns_(sheet, row);
        failRow_(sheet, row, "Progress stalled for over " + params.stallMinutes + " minutes at " + prevProgress + "%");
        return;
      }
      setByHeader_(sheet, row, "STATUS", "PROCESSING " + nextProgress + "%");
    } else {
      setByHeader_(sheet, row, "STATUS", "PROCESSING");
    }
    return;
  }

  clearJobRuntimeColumns_(sheet, row);
  failRow_(sheet, row, "Invalid poll response: " + pollResp.text);
}

function finalizeCompletedRow_(sheet, row, pollData, driveFolderId, publicShare, emailField) {
  var blob = Utilities.newBlob(
    Utilities.base64Decode(String(pollData.pdfBase64)),
    "application/pdf",
    String(pollData.fileName)
  );
  var folder = driveFolderId ? DriveApp.getFolderById(driveFolderId) : DriveApp.getRootFolder();
  var file = folder.createFile(blob);

  if (publicShare) {
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  }

  var url = file.getUrl();
  setByHeader_(sheet, row, "PDF_URL", url);
  setByHeader_(sheet, row, "STATUS", "DONE");
  setByHeader_(sheet, row, "ERROR", "");
  clearJobRuntimeColumns_(sheet, row);

  var email = String(getByHeader_(sheet, row, "JOB_EMAIL") || "");
  if (!email) {
    email = String(getByHeader_(sheet, row, emailField) || "");
  }
  var name = String(getByHeader_(sheet, row, "JOB_NAME") || "");
  if (email) {
    var subject = (name || "사주") + " PDF 리포트";
    var body = "PDF 링크: " + url + "\n\n(참고용 리포트입니다.)";
    MailApp.sendEmail(email, subject, body);
  }
}

function buildGenerateEndpoints_(endpoint) {
  var base = String(endpoint || "").replace(/\/+$/, "");
  base = base.replace(/\/(start|poll)$/, "");
  return {
    start: base + "/start",
    poll: base + "/poll"
  };
}

function mustGetProp_(props, key) {
  var v = props.getProperty(key);
  if (!v) throw new Error("Missing Script Property: " + key);
  return v;
}

function ensurePollerTrigger_() {
  var lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    var triggers = ScriptApp.getProjectTriggers();
    for (var i = 0; i < triggers.length; i++) {
      if (triggers[i].getHandlerFunction() === "pollPendingJobs") {
        return;
      }
    }
    ScriptApp.newTrigger("pollPendingJobs").timeBased().everyMinutes(1).create();
  } finally {
    lock.releaseLock();
  }
}

function removePollerTrigger_() {
  var lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    var triggers = ScriptApp.getProjectTriggers();
    for (var i = 0; i < triggers.length; i++) {
      if (triggers[i].getHandlerFunction() === "pollPendingJobs") {
        ScriptApp.deleteTrigger(triggers[i]);
      }
    }
  } finally {
    lock.releaseLock();
  }
}

function countPendingJobs_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheets = ss.getSheets();
  var count = 0;
  for (var s = 0; s < sheets.length; s++) {
    var sheet = sheets[s];
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) continue;
    for (var row = 2; row <= lastRow; row++) {
      var token = String(getByHeader_(sheet, row, "JOB_TOKEN") || "");
      var status = String(getByHeader_(sheet, row, "STATUS") || "");
      if (!token) continue;
      if (status === "DONE" || status === "FAILED") continue;
      count += 1;
    }
  }
  return count;
}

function postJson_(url, payloadObj, webhookSecret) {
  var resp = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payloadObj),
    headers: { "X-Webhook-Secret": webhookSecret },
    muteHttpExceptions: true
  });
  return {
    status: resp.getResponseCode(),
    text: resp.getContentText()
  };
}

function safeJsonParse_(text) {
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

function parseDateSafe_(iso) {
  if (!iso) return null;
  var d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d;
}

function pick_(namedValues, keys) {
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    if (namedValues[k] && namedValues[k].length) return String(namedValues[k][0]).trim();
  }
  return "";
}

function parseCalendar_(raw) {
  var v = (raw || "").toLowerCase();
  if (v.indexOf("음") !== -1 || v.indexOf("lunar") !== -1) return "lunar";
  return "solar";
}

function parseDate_(raw) {
  var s = String(raw || "").trim();
  // Google Form date answers can look like: "2026. 3. 6.", "2026/03/06", "20260306", etc.
  var digits = s.replace(/[^\d]/g, "");
  if (digits.length === 8) {
    return { year: Number(digits.slice(0, 4)), month: Number(digits.slice(4, 6)), day: Number(digits.slice(6, 8)) };
  }
  // Fallback: allow multiple separators and trailing dots/spaces.
  var m = s.match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  if (!m) throw new Error("Invalid birth date: " + s);
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

function parseTime_(raw) {
  var s = String(raw || "").trim();
  if (!s) return { hour: 0, minute: 0 };
  // Accept: "05:30", "5:30", "오전 5:30", "오후 2:10", "14:10", "5시 30분", "0530"
  var isPm = /오후|pm/i.test(s);
  var isAm = /오전|am/i.test(s);

  var digits = s.replace(/[^\d]/g, "");
  var hour = 0;
  var minute = 0;

  if (digits.length === 4) {
    hour = Number(digits.slice(0, 2));
    minute = Number(digits.slice(2, 4));
  } else if (digits.length === 3) {
    hour = Number(digits.slice(0, 1));
    minute = Number(digits.slice(1, 3));
  } else {
    // Fallback: pick first two numbers (hour/minute) from string
    var m = s.match(/(\d{1,2})\D+(\d{1,2})/);
    if (m) {
      hour = Number(m[1]);
      minute = Number(m[2]);
    } else {
      var h = s.match(/(\d{1,2})/);
      if (!h) throw new Error("Invalid birth time: " + s);
      hour = Number(h[1]);
      minute = 0;
    }
  }

  // Apply AM/PM normalization when present
  if (isPm && hour < 12) hour += 12;
  if (isAm && hour === 12) hour = 0;

  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error("Invalid birth time: " + s);
  }
  return { hour: hour, minute: minute };
}

function setByHeader_(sheet, row, headerName, value) {
  var headerRow = 1;
  var lastCol = sheet.getLastColumn();
  var headers = sheet.getRange(headerRow, 1, 1, Math.max(1, lastCol)).getValues()[0];

  var col = -1;
  for (var i = 0; i < headers.length; i++) {
    if (String(headers[i]).trim() === headerName) {
      col = i + 1;
      break;
    }
  }

  if (col === -1) {
    col = headers.length + 1;
    sheet.getRange(headerRow, col).setValue(headerName);
  }

  sheet.getRange(row, col).setValue(value);
}

function getByHeader_(sheet, row, headerName) {
  var headerRow = 1;
  var lastCol = sheet.getLastColumn();
  var headers = sheet.getRange(headerRow, 1, 1, Math.max(1, lastCol)).getValues()[0];

  for (var i = 0; i < headers.length; i++) {
    if (String(headers[i]).trim() === headerName) {
      return sheet.getRange(row, i + 1).getValue();
    }
  }
  return "";
}

function clearJobRuntimeColumns_(sheet, row) {
  setByHeader_(sheet, row, "JOB_TOKEN", "");
  setByHeader_(sheet, row, "JOB_LAST_PROGRESS_AT", "");
  setByHeader_(sheet, row, "JOB_LAST_PROGRESS", "");
  setByHeader_(sheet, row, "JOB_RETRY_ERRORS", "");
}

function failRow_(sheet, row, message) {
  setByHeader_(sheet, row, "STATUS", "FAILED");
  setByHeader_(sheet, row, "ERROR", String(message || "unknown_error"));
}

/**
 * Manual utility: run once from editor to ensure poll trigger exists.
 */
function installPollerTrigger() {
  ensurePollerTrigger_();
}

/**
 * Manual utility: run once from editor to delete poll trigger.
 */
function uninstallPollerTrigger() {
  removePollerTrigger_();
}
