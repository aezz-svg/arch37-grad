const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbzDz56Z9TMVMPRYfr2DDOIHfBevQGGzwKvdpCNC-H2JYafMhb07C9Xf8YujzMi54aYikg/exec";
const ALLOWED_ACTIONS = new Set([
  "getAdminData", "verifyStudent", "registerStudent", "decideApproval",
  "changeAdminPassword", "changeStudentPin",
  "updateProject", "removeProfilePhoto", "recordVisit", "resetStudent", "requestPinReset",
  "approvePinReset", "sendFeedback", "saveLiveCode",
  "beginFileUpload", "uploadFileChunk", "getFileUploadStatus", "cancelFileUpload"
]);

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    return res.status(405).json({ status: "error", message: "طريقة الطلب غير مدعومة." });
  }

  let data = req.body;
  try {
    if (typeof data === "string") data = JSON.parse(data);
  } catch (_) {
    return res.status(400).json({ status: "error", message: "تعذر قراءة بيانات الطلب." });
  }
  if (!data || typeof data !== "object" || Array.isArray(data) || !ALLOWED_ACTIONS.has(data.action)) {
    return res.status(400).json({ status: "error", message: "نوع الطلب غير معروف." });
  }

  const body = JSON.stringify(data);
  if (Buffer.byteLength(body, "utf8") > 3500000) {
    return res.status(413).json({ status: "error", message: "حجم الطلب يتجاوز الحد الآمن لبوابة الموقع." });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 230000);
  try {
    const upstream = await fetch(APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body,
      redirect: "follow",
      signal: controller.signal
    });
    const text = await upstream.text();
    let result;
    try {
      result = JSON.parse(text);
    } catch (_) {
      return res.status(502).json({ status: "error", message: "أعاد Google ردًا غير قابل للقراءة؛ لم يتم تأكيد الطلب." });
    }
    return res.status(upstream.ok ? 200 : 502).json(result);
  } catch (error) {
    const timedOut = error && error.name === "AbortError";
    return res.status(timedOut ? 504 : 502).json({
      status: "error",
      message: timedOut ? "انتهت مهلة انتظار رد Google؛ لم يتم تأكيد الطلب." : "تعذر الوصول إلى Google Apps Script؛ لم يتم تأكيد الطلب."
    });
  } finally {
    clearTimeout(timer);
  }
};

module.exports.config = { maxDuration: 240 };
