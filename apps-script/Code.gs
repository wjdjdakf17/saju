/**
 * Google Form -> Sheets on submit trigger.
 *
 * Flow:
 * - Read form values from e.namedValues
 * - POST to Vercel API (/api/generate)
 * - Receive { pdfBase64, fileName }
 * - Upload to Google Drive
 * - Write PDF URL back to the same response row
 * - Optional: send email
 */

function onFormSubmit(e) {
  var props = PropertiesService.getScriptProperties();
  var VERCEL_ENDPOINT = mustGetProp_(props, "VERCEL_ENDPOINT"); // e.g. https://your-app.vercel.app/api/generate
  var WEBHOOK_SECRET = mustGetProp_(props, "WEBHOOK_SECRET");
  var DRIVE_FOLDER_ID = props.getProperty("DRIVE_FOLDER_ID"); // optional
  var PUBLIC_SHARE = (props.getProperty("PUBLIC_SHARE") || "true").toLowerCase() === "true";

  var named = e && e.namedValues ? e.namedValues : {};
  var sheet = e && e.range ? e.range.getSheet() : SpreadsheetApp.getActiveSheet();
  var row = e && e.range ? e.range.getRow() : sheet.getLastRow();

  var name = pick_(named, ["이름", "name", "Name"]);
  var gender = pick_(named, ["성별", "gender", "Gender"]);
  var calendarRaw = pick_(named, ["양력/음력", "양/음력", "달력", "calendar", "Calendar"]);
  var birthDateRaw = pick_(named, ["생년월일", "birthdate", "Birthdate", "Birthday"]);
  var birthTimeRaw = pick_(named, ["출생시간", "birthtime", "Birthtime"]);

  var calendar = parseCalendar_(calendarRaw);
  var birthDate = parseDate_(birthDateRaw);
  var birthTime = parseTime_(birthTimeRaw);

  var requestBody = {
    name: name,
    gender: gender,
    calendar: calendar, // "solar" | "lunar"
    birth: {
      year: birthDate.year,
      month: birthDate.month,
      day: birthDate.day,
      hour: birthTime.hour,
      minute: birthTime.minute
    },
    isLeapMonth: false
  };

  // Mark processing
  setByHeader_(sheet, row, "STATUS", "PROCESSING");
  setByHeader_(sheet, row, "ERROR", "");

  var resp = UrlFetchApp.fetch(VERCEL_ENDPOINT, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(requestBody),
    headers: { "X-Webhook-Secret": WEBHOOK_SECRET },
    muteHttpExceptions: true
  });

  if (resp.getResponseCode() < 200 || resp.getResponseCode() >= 300) {
    setByHeader_(sheet, row, "STATUS", "FAILED");
    setByHeader_(sheet, row, "ERROR", "Vercel API error: " + resp.getResponseCode() + " " + resp.getContentText());
    return;
  }

  var data = JSON.parse(resp.getContentText());
  if (!data || !data.pdfBase64 || !data.fileName) {
    setByHeader_(sheet, row, "STATUS", "FAILED");
    setByHeader_(sheet, row, "ERROR", "Invalid response: " + resp.getContentText());
    return;
  }

  var blob = Utilities.newBlob(Utilities.base64Decode(data.pdfBase64), "application/pdf", data.fileName);
  var folder = DRIVE_FOLDER_ID ? DriveApp.getFolderById(DRIVE_FOLDER_ID) : DriveApp.getRootFolder();
  var file = folder.createFile(blob);

  if (PUBLIC_SHARE) {
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  }

  var url = file.getUrl();
  setByHeader_(sheet, row, "PDF_URL", url);
  setByHeader_(sheet, row, "STATUS", "DONE");

  // Optional email sending: if your form collects email, name the field as "이메일" (or set EMAIL_FIELD in script properties)
  var emailField = props.getProperty("EMAIL_FIELD") || "이메일";
  var email = pick_(named, [emailField, "email", "Email"]);
  if (email) {
    var subject = (name || "사주") + " PDF 리포트";
    var body = "PDF 링크: " + url + "\n\n(참고용 리포트입니다.)";
    MailApp.sendEmail(email, subject, body);
  }
}

function mustGetProp_(props, key) {
  var v = props.getProperty(key);
  if (!v) throw new Error("Missing Script Property: " + key);
  return v;
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

