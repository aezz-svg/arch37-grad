/**
 * خادم أرشيف البرمجة المعمارية - الدفعة 37
 * يقرأ جدول قاعدة البيانات ويحفظ مرفقات الطلاب في مجلد كل طالب.
 *
 * إعداد مطلوب قبل النشر:
 * أضف ADMIN_API_PASSWORD في خصائص النص البرمجي، واجعل قيمته كلمة مرور المدير الأولية admin37.
 * يغيّر إجراء changeAdminPassword الخاصية من داخل لوحة الإدارة بعد التحقق من كلمة المرور الحالية.
 * لا تضع كلمة المرور في رابط URL أو في هذا الملف.
 */

const TARGET_FOLDER_ID = "1nyAI18hoDjW_w2-S-Fw6G02_9I4gQ5Om";
const SPREADSHEET_ID = "1C6x-F5gRTbZd2pdmeA_rcEivRg2Pzb_K-NmvNgDyGJo";
const ADMIN_EMAIL = Session.getEffectiveUser().getEmail();

const SHEET_NAMES = [
  "Projects",
  "PendingApprovals",
  "Visits",
  "ResetRequests",
  "Feedbacks"
];

function doGet() {
  try {
    const ss = getDatabase_();
    return jsonResponse(getData_(ss, false));
  } catch (err) {
    return jsonResponse({ status: "error", message: safeError_(err) });
  }
}

function doPost(e) {
  let data;
  try {
    data = parseRequest_(e);
  } catch (err) {
    return jsonResponse({ status: "error", message: "تعذر قراءة الطلب." });
  }

  // قراءة بيانات المدير والرموز محمية بكلمة مرور محفوظة في Script Properties.
  if (data.action === "getAdminData") {
    try {
      if (!isValidAdminPassword_(data.adminPassword)) {
        return jsonResponse({ status: "error", message: "غير مصرح." });
      }
      return jsonResponse(getData_(getDatabase_(), true));
    } catch (err) {
      return jsonResponse({ status: "error", message: safeError_(err) });
    }
  }

  // تغيير كلمة مرور المدير يتم عبر الخادم، ولا يحفظ التغيير في متصفح واحد فقط.
  if (data.action === "changeAdminPassword") {
    try {
      if (!isValidAdminPassword_(data.currentPassword)) {
        return jsonResponse({ status: "error", message: "كلمة مرور المدير الحالية غير صحيحة." });
      }
      const nextPassword = String(data.newPassword || "");
      if (nextPassword.length < 8) {
        return jsonResponse({ status: "error", message: "كلمة المرور الجديدة يجب ألا تقل عن 8 أحرف." });
      }
      PropertiesService.getScriptProperties().setProperty("ADMIN_API_PASSWORD", nextPassword);
      return jsonResponse({ status: "success" });
    } catch (err) {
      return jsonResponse({ status: "error", message: safeError_(err) });
    }
  }

  // يتحقق من رمز الطالب على الخادم من دون إرسال الرموز في استجابة القراءة العامة.
  if (data.action === "verifyStudent") {
    try {
      const ss = getDatabase_();
      const sid = normalizeId_(data.studentId);
      const pin = normalizePin_(data.pin);
      const project = find(ss.getSheetByName("Projects"), "id", sid);
      const pending = project ? null : find(ss.getSheetByName("PendingApprovals"), "id", sid);
      const record = project || pending;
      const verified = !!record && pin !== "" && normalizePin_(record.pin) === pin;
      return jsonResponse({
        status: "success",
        verified: verified,
        approved: verified && !!project,
        student: verified ? publicRecord_(record) : null
      });
    } catch (err) {
      return jsonResponse({ status: "error", message: safeError_(err) });
    }
  }

  const lock = LockService.getScriptLock();
  let locked = false;
  try {
    locked = lock.tryLock(30000);
    if (!locked) {
      return jsonResponse({ status: "error", message: "الخادم مشغول؛ أعد المحاولة." });
    }

    const ss = getDatabase_();
    const action = data.action;

    // يغيّر الطالب كلمة مروره بعد التحقق من الرمز الحالي على الخادم.
    if (action === "changeStudentPin") {
      requireFields_(data, ["studentId", "currentPin", "newPin"]);
      const sid = normalizeId_(data.studentId);
      const currentPin = normalizePin_(data.currentPin);
      const newPin = normalizePin_(data.newPin);
      if (newPin.length < 4 || newPin.length > 64) {
        return jsonResponse({ status: "error", message: "كلمة مرور الطالب يجب أن تكون بين 4 و64 حرفاً أو رقماً." });
      }
      const projectsSheet = ss.getSheetByName("Projects");
      const pendingSheet = ss.getSheetByName("PendingApprovals");
      const project = find(projectsSheet, "id", sid);
      const pending = project ? null : find(pendingSheet, "id", sid);
      const record = project || pending;
      if (!record || currentPin === "" || normalizePin_(record.pin) !== currentPin) {
        return jsonResponse({ status: "error", message: "كلمة المرور الحالية غير صحيحة." });
      }
      upsert(project ? projectsSheet : pendingSheet, "id", sid, { id: sid, pin: newPin });
      return jsonResponse({ status: "success" });
    }

    // تسجيل مشروع جديد وإيداعه بانتظار الاعتماد.
    if (action === "registerStudent") {
      requireFields_(data, ["studentId", "studentName"]);
      let fileUrl = "";
      let coverUrl = "";

      if (data.base64File && data.fileName) {
        fileUrl = uploadFileToStudentFolder(data.studentId, data.studentName, data.fileName, data.mimeType, data.base64File, "مشروع");
      }
      if (data.base64Cover && data.coverFileName) {
        coverUrl = uploadFileToStudentFolder(data.studentId, data.studentName, data.coverFileName, data.coverMimeType, data.base64Cover, "غلاف");
      }

      upsert(ss.getSheetByName("PendingApprovals"), "id", normalizeId_(data.studentId), {
        id: normalizeId_(data.studentId),
        name: data.studentName,
        system: data.system || "عام",
        title: data.title || "",
        desc: data.desc || "",
        pin: normalizePin_(data.pin),
        allowShare: data.allowShare ? "true" : "false",
        contacts: serializeContacts_(data.contacts),
        fileName: data.fileName || "",
        fileUrl: fileUrl,
        coverUrl: coverUrl,
        submittedAt: new Date().toISOString()
      });

      notifyAdmin("📥 [أرشيف 37] مشروع جديد قيد الاعتماد",
        `المهندس: ${data.studentName} (${data.studentId})\nالمشروع: "${data.title || ""}"\nتم إيداع الطلب للمراجعة.`);
      return jsonResponse({ status: "success", fileUrl: fileUrl, coverUrl: coverUrl });
    }

    // اعتماد أو رفض مشروع معلّق.
    if (action === "decideApproval") {
      const sid = normalizeId_(data.studentId);
      const pendingSheet = ss.getSheetByName("PendingApprovals");
      const projectsSheet = ss.getSheetByName("Projects");
      const row = find(pendingSheet, "id", sid);
      if (!row) return jsonResponse({ status: "error", message: "الطلب غير موجود." });

      if (data.decision === "approve") {
        upsert(projectsSheet, "id", sid, {
          id: sid, name: row.name, system: row.system, title: row.title,
          desc: row.desc, pin: String(row.pin), allowShare: row.allowShare,
          contacts: row.contacts, fileName: row.fileName, fileUrl: row.fileUrl,
          coverUrl: row.coverUrl || "", avatarUrl: row.avatarUrl || "", approved: "true",
          approvedAt: new Date().toISOString()
        });
        removeRow(pendingSheet, "id", sid);
      } else if (data.decision === "reject") {
        removeRow(pendingSheet, "id", sid);
      } else {
        return jsonResponse({ status: "error", message: "قرار الاعتماد غير صالح." });
      }
      return jsonResponse({ status: "success" });
    }

    // حذف صورة الملف الشخصي بعد التحقق من كلمة مرور الطالب.
    if (action === "removeProfilePhoto") {
      requireFields_(data, ["studentId", "pin"]);
      const sid = normalizeId_(data.studentId);
      const projectsSheet = ss.getSheetByName("Projects");
      const row = find(projectsSheet, "id", sid);
      if (!row || normalizePin_(row.pin) !== normalizePin_(data.pin)) {
        return jsonResponse({ status: "error", message: "كلمة السر غير صحيحة." });
      }
      const fileId = extractDriveFileId_(row.avatarUrl);
      if (fileId) DriveApp.getFileById(fileId).setTrashed(true);
      ensureHeader_(projectsSheet, "avatarUrl");
      upsert(projectsSheet, "id", sid, { id: sid, avatarUrl: "", updatedAt: new Date().toISOString() });
      return jsonResponse({ status: "success" });
    }
    // تحديث بيانات مشروع معتمد أو مرفقاته.
    if (action === "updateProject") {
      requireFields_(data, ["studentId"]);
      let fileUrl = data.fileUrl || "";
      let coverUrl = data.coverUrl || "";
      if (data.base64File && data.fileName) {
        fileUrl = uploadFileToStudentFolder(data.studentId, data.studentName || "طالب", data.fileName, data.mimeType, data.base64File, "مشروع_محدث");
      }
      if (data.base64Cover && data.coverFileName) {
        coverUrl = uploadFileToStudentFolder(data.studentId, data.studentName || "طالب", data.coverFileName, data.coverMimeType, data.base64Cover, "غلاف_محدث");
      }

      const projectsSheet = ss.getSheetByName("Projects");
      const sid = normalizeId_(data.studentId);
      if (data.base64Avatar && data.avatarFileName) ensureHeader_(projectsSheet, "avatarUrl");
      const row = find(projectsSheet, "id", sid) || {};
      let avatarUrl = String(row.avatarUrl || "");
      if (data.base64Avatar && data.avatarFileName) {
        avatarUrl = uploadFileToStudentFolder(data.studentId, data.studentName || row.name || "طالب", data.avatarFileName, data.avatarMimeType || "image/jpeg", data.base64Avatar, "صورة_الملف_الشخصي");
      }
      upsert(projectsSheet, "id", sid, {
        id: sid,
        name: data.studentName || row.name || "",
        system: data.system || row.system || "عام",
        title: data.title || row.title || "",
        desc: data.desc !== undefined ? data.desc : (row.desc || ""),
        pin: data.pin ? normalizePin_(data.pin) : normalizePin_(row.pin || "2026"),
        allowShare: data.allowShare !== undefined ? (data.allowShare ? "true" : "false") : (row.allowShare || "true"),
        contacts: data.contacts ? serializeContacts_(data.contacts) : (row.contacts || "[]"),
        fileName: data.fileName || row.fileName || "",
        fileUrl: fileUrl || row.fileUrl || "",
        coverUrl: coverUrl || row.coverUrl || "",
        avatarUrl: avatarUrl,
        approved: "true",
        updatedAt: new Date().toISOString()
      });
      return jsonResponse({ status: "success", fileUrl: fileUrl, coverUrl: coverUrl, avatarUrl: avatarUrl });
    }

    // تسجيل زيارة.
    if (action === "recordVisit") {
      requireFields_(data, ["studentId"]);
      const visitsSheet = ss.getSheetByName("Visits");
      const sid = normalizeId_(data.studentId);
      const row = find(visitsSheet, "id", sid);
      const count = row ? (parseInt(row.count, 10) || 0) + 1 : 1;
      upsert(visitsSheet, "id", sid, {
        id: sid, name: data.studentName || (row ? row.name : ""),
        count: count, lastSeen: new Date().toISOString(), lastTimestamp: Date.now()
      });
      return jsonResponse({ status: "success" });
    }

    // تصفير الحساب بناءً على طلب صريح من الواجهة الإدارية.
    if (action === "resetStudent") {
      const sid = normalizeId_(data.studentId);
      removeRow(ss.getSheetByName("Projects"), "id", sid);
      removeRow(ss.getSheetByName("PendingApprovals"), "id", sid);
      removeRow(ss.getSheetByName("ResetRequests"), "id", sid);
      return jsonResponse({ status: "success" });
    }

    // طلب استعادة الرمز السري.
    if (action === "requestPinReset") {
      requireFields_(data, ["studentId"]);
      const sid = normalizeId_(data.studentId);
      upsert(ss.getSheetByName("ResetRequests"), "id", sid, {
        id: sid, name: data.studentName || "", system: data.system || "عام",
        projectTitle: data.projectTitle || "", token: data.token || "",
        note: data.note || "", approvedNewPin: "", status: "pending",
        date: new Date().toISOString()
      });
      notifyAdmin("🔑 [أرشيف 37] طلب استعادة رمز سري",
        `المهندس: ${data.studentName || ""} (${data.studentId})\nرمز التتبع: ${data.token || ""}`);
      return jsonResponse({ status: "success" });
    }

    // اعتماد رمز سري جديد.
    if (action === "approvePinReset") {
      requireFields_(data, ["studentId", "newPin"]);
      const sid = normalizeId_(data.studentId);
      upsert(ss.getSheetByName("ResetRequests"), "id", sid, {
        id: sid, approvedNewPin: String(data.newPin), status: "approved"
      });
      const proj = find(ss.getSheetByName("Projects"), "id", sid);
      if (proj) upsert(ss.getSheetByName("Projects"), "id", sid, { id: sid, pin: String(data.newPin) });
      const pending = find(ss.getSheetByName("PendingApprovals"), "id", sid);
      if (pending) upsert(ss.getSheetByName("PendingApprovals"), "id", sid, { id: sid, pin: String(data.newPin) });
      return jsonResponse({ status: "success" });
    }

    // تسجيل اقتراح أو ملاحظة.
    if (action === "sendFeedback") {
      ss.getSheetByName("Feedbacks").appendRow([data.sender || "", data.text || "", new Date().toISOString()]);
      return jsonResponse({ status: "success" });
    }

    return jsonResponse({ status: "error", message: "الإجراء غير معروف." });
  } catch (err) {
    return jsonResponse({ status: "error", message: safeError_(err) });
  } finally {
    if (locked) lock.releaseLock();
  }
}

function getDatabase_() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const missing = SHEET_NAMES.filter(name => !ss.getSheetByName(name));
  if (missing.length) throw new Error("أوراق مطلوبة غير موجودة: " + missing.join(", "));
  return ss;
}

function getData_(ss, includePins) {
  const projects = readSheet(ss.getSheetByName("Projects"));
  const pending = readSheet(ss.getSheetByName("PendingApprovals"));
  return {
    status: "success",
    projects: toMap(projects, "id", includePins),
    pending: toMap(pending, "id", includePins),
    visits: toMap(readSheet(ss.getSheetByName("Visits")), "id", includePins),
    resetReqs: toMap(readSheet(ss.getSheetByName("ResetRequests")), "id", includePins),
    feedbacks: readSheet(ss.getSheetByName("Feedbacks"))
  };
}

function isValidAdminPassword_(provided) {
  const expected = PropertiesService.getScriptProperties().getProperty("ADMIN_API_PASSWORD");
  return !!expected && String(provided || "") === expected;
}

function parseRequest_(e) {
  if (e && e.postData && e.postData.contents) {
    const parsed = JSON.parse(e.postData.contents);
    if (!parsed || typeof parsed !== "object") throw new Error("Invalid request");
    return parsed;
  }
  return (e && e.parameter) ? e.parameter : {};
}

function authorizeDriveAccess() {
  return DriveApp.getFolderById(TARGET_FOLDER_ID).getName();
}
function extractDriveFileId_(value) {
  const url = String(value || "");
  const match = url.match(/\/d\/([^/?#]+)/) || url.match(/[?&]id=([^&#]+)/);
  return match ? decodeURIComponent(match[1]) : "";
}
function uploadFileToStudentFolder(studentId, studentName, fileName, mimeType, base64, tag) {
  const rootFolder = DriveApp.getFolderById(TARGET_FOLDER_ID);
  const sid = normalizeId_(studentId);
  let studentFolder = null;
  const subFolders = rootFolder.getFolders();
  while (subFolders.hasNext()) {
    const folder = subFolders.next();
    if (folder.getName().indexOf(sid) !== -1) {
      studentFolder = folder;
      break;
    }
  }
  if (!studentFolder) {
    studentFolder = rootFolder.createFolder(`[${sid}] ${studentName} مشاريع التخرج`);
    studentFolder.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  }
  const cleanFileName = `[${sid}] ${tag} - ${fileName}`;
  const blob = Utilities.newBlob(Utilities.base64Decode(base64), mimeType || "application/octet-stream", cleanFileName);
  const file = studentFolder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return file.getUrl();
}

function notifyAdmin(subject, message) {
  try {
    if (ADMIN_EMAIL) MailApp.sendEmail(ADMIN_EMAIL, subject, message);
  } catch (err) {
    console.error("تعذر إرسال إشعار المدير: " + err);
  }
}

function readSheet(sheet) {
  const rows = sheet.getDataRange().getValues();
  if (rows.length <= 1) return [];
  const headers = rows[0].map(h => String(h).trim());
  return rows.slice(1).filter(row => row.some(value => value !== "" && value !== null)).map(row => {
    const obj = {};
    headers.forEach((header, index) => { if (header) obj[header] = row[index]; });
    return obj;
  });
}

function find(sheet, key, val) {
  const records = readSheet(sheet);
  return records.find(record => normalizeId_(record[key]) === normalizeId_(val)) || null;
}

function upsert(sheet, key, val, obj) {
  const rows = sheet.getDataRange().getValues();
  if (!rows.length) throw new Error("ورقة البيانات بلا صف عناوين: " + sheet.getName());
  const headers = rows[0].map(h => String(h).trim());
  const keyIndex = headers.indexOf(key);
  if (keyIndex < 0) throw new Error("عمود " + key + " غير موجود في " + sheet.getName());
  let targetRow = -1;
  for (let i = 1; i < rows.length; i++) {
    if (normalizeId_(rows[i][keyIndex]) === normalizeId_(val)) {
      targetRow = i + 1;
      break;
    }
  }
  if (targetRow > 0) {
    headers.forEach((header, index) => {
      if (obj[header] !== undefined) sheet.getRange(targetRow, index + 1).setValue(obj[header]);
    });
  } else {
    sheet.appendRow(headers.map(header => obj[header] !== undefined ? obj[header] : ""));
  }
}

function ensureHeader_(sheet, header) {
  const lastColumn = Math.max(sheet.getLastColumn(), 1);
  const headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0].map(value => String(value).trim());
  if (headers.includes(header)) return;
  sheet.getRange(1, lastColumn + 1).setValue(header);
}

function removeRow(sheet, key, val) {
  const rows = sheet.getDataRange().getValues();
  if (!rows.length) return;
  const keyIndex = rows[0].map(h => String(h).trim()).indexOf(key);
  if (keyIndex < 0) throw new Error("عمود " + key + " غير موجود في " + sheet.getName());
  for (let i = rows.length - 1; i >= 1; i--) {
    if (normalizeId_(rows[i][keyIndex]) === normalizeId_(val)) sheet.deleteRow(i + 1);
  }
}

function toMap(records, key, includePins) {
  const map = {};
  records.forEach(record => {
    const id = normalizeId_(record[key]);
    if (!id) return;
    const output = Object.assign({}, record);
    if (!includePins) delete output.pin;
    if (typeof output.contacts === "string") {
      try { output.contacts = JSON.parse(output.contacts); } catch (err) { output.contacts = []; }
    }
    if (output.allowShare !== undefined) output.allowShare = String(output.allowShare) === "true";
    if (output.approved !== undefined) output.approved = String(output.approved) === "true";
    map[id] = output;
  });
  return map;
}

function publicRecord_(record) {
  const output = Object.assign({}, record);
  delete output.pin;
  if (typeof output.contacts === "string") {
    try { output.contacts = JSON.parse(output.contacts); } catch (err) { output.contacts = []; }
  }
  output.approved = String(output.approved) === "true";
  return output;
}

function serializeContacts_(contacts) {
  if (typeof contacts === "string") return contacts;
  return JSON.stringify(contacts || []);
}

function normalizeId_(value) {
  return String(value == null ? "" : value).trim();
}

function normalizePin_(value) {
  return String(value == null ? "" : value).normalize("NFKC").trim().replace(/[٠-٩۰-۹]/g, digit => {
    const code = digit.charCodeAt(0);
    return String(code >= 0x06F0 ? code - 0x06F0 : code - 0x0660);
  });
}

function requireFields_(data, fields) {
  const missing = fields.filter(field => data[field] === undefined || data[field] === null || String(data[field]).trim() === "");
  if (missing.length) throw new Error("حقول مطلوبة مفقودة: " + missing.join(", "));
}

function safeError_(err) {
  return err && err.message ? err.message : String(err);
}

function jsonResponse(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// شغّل هذه الدالة يدويًا للفحص؛ تقرأ فقط ولا تنشئ أوراقًا أو تعدّل بيانات.
function checkDatabaseConnection() {
  const ss = getDatabase_();
  Logger.log("قاعدة البيانات: " + ss.getName());
  SHEET_NAMES.forEach(name => {
    const sheet = ss.getSheetByName(name);
    Logger.log(name + " — عدد الصفوف بما فيها العناوين: " + sheet.getLastRow());
  });
}
