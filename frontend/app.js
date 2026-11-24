/* Dashboard giám sát tài xế - client
 * Nguồn hình ảnh: webcam (trình duyệt giữ webcam).  Nguồn dữ liệu: AI (live) qua WebSocket. */
(() => {
  const $ = (id) => document.getElementById(id);
  const el = {
    video: $("video"), overlay: $("overlay"), videoEmpty: $("videoEmpty"), videoBadge: $("videoBadge"), videoDir: $("videoDir"),
    alarmBanner: $("alarmBanner"), alarmText: $("alarmText"),
    connPill: $("connPill"), connText: $("connText"), aiPill: $("aiPill"), aiState: $("aiState"),
    soundBtn: $("soundBtn"),
    statusBig: $("statusBig"), statusSub: $("statusSub"),
    timerText: $("timerText"), timerFill: $("timerFill"),
    warnBox: $("warnBox"), warnMsg: $("warnMsg"),
    headDot: $("headDot"),
    mDirection: $("mDirection"), mYaw: $("mYaw"), mPitch: $("mPitch"), mRoll: $("mRoll"), mConf: $("mConf"),
    bYaw: $("bYaw"), bPitch: $("bPitch"), bRoll: $("bRoll"),
    log: $("log"), clearLog: $("clearLog"),
    srcSelect: $("srcSelect"), camBar: $("camBar"), camDevice: $("camDevice"), recBtn: $("recBtn"),
    recTimer: $("recTimer"), relayChk: $("relayChk"), camInfo: $("camInfo"),
  };

  const DIR_TEXT = {
    FORWARD: "Nhìn thẳng", LEFT: "Quay trái", RIGHT: "Quay phải",
    UP: "Ngẩng lên", DOWN: "Cúi xuống", NO_FACE: "Không thấy mặt",
  };
  const STATUS_SUB = {
    NORMAL: "Tài xế tập trung",
    WARNING: "Có dấu hiệu mất tập trung",
    NO_SIGNAL: "Chưa nhận được dữ liệu từ AI",
  };
  const RANGE = { yaw: 60, pitch: 40, roll: 40 };

  let ws = null, retry = 0, soundOn = false, audioCtx = null;
  let prevStatus = null, prevDir = null, config = { warn_after: 2.0 };

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const fmt = (v) => (v == null ? "—" : `${Number(v).toFixed(1)}°`);

  const DIR_POS = { FORWARD: [0, 0], LEFT: [-0.6, 0], RIGHT: [0.6, 0], UP: [0, 0.6], DOWN: [0, -0.6] };
  let lastDet = null;

  function drawBox() {
    const cv = el.overlay;
    if (!cv) return;
    const rect = el.video.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(rect.width * dpr);
    cv.height = Math.round(rect.height * dpr);
    const ctx = cv.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    if (!lastDet || !lastDet.bbox) return;
    const vw = el.video.videoWidth, vh = el.video.videoHeight;
    if (!vw || !vh) return;
    const scale = Math.min(rect.width / vw, rect.height / vh);
    const dw = vw * scale, dh = vh * scale;
    const ox = (rect.width - dw) / 2, oy = (rect.height - dh) / 2;
    const [x1, y1, x2, y2] = lastDet.bbox;
    const bx = ox + x1 * dw, by = oy + y1 * dh, bw = (x2 - x1) * dw, bh = (y2 - y1) * dh;
    const color = lastDet.warning ? "#ef4444" : "#22c55e";
    ctx.lineWidth = 3; ctx.strokeStyle = color;
    ctx.strokeRect(bx, by, bw, bh);
    const text = `${lastDet.label || lastDet.direction} ${Math.round((lastDet.confidence || 0) * 100)}%`;
    ctx.font = "600 14px Segoe UI, sans-serif";
    const tw = ctx.measureText(text).width + 12;
    const ty = by - 24 < 0 ? by + 2 : by - 24;
    ctx.fillStyle = color; ctx.fillRect(bx - 1.5, ty, tw, 22);
    ctx.fillStyle = "#fff"; ctx.fillText(text, bx + 4, ty + 16);
  }

  function addLog(text, kind = "info") {
    const li = document.createElement("li");
    li.className = kind;
    const t = document.createElement("time");
    t.textContent = new Date().toLocaleTimeString("vi-VN");
    const s = document.createElement("span");
    s.textContent = text;
    li.append(t, s);
    el.log.prepend(li);
    while (el.log.children.length > 100) el.log.lastChild.remove();
  }

  function showVideoMsg(html) {
    el.videoEmpty.innerHTML = `<div class="msg">${html}</div>`;
    el.videoEmpty.hidden = false;
  }

  function beep() {
    if (!soundOn) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = "square"; o.frequency.value = 880;
      g.gain.value = 0.08;
      o.connect(g); g.connect(audioCtx.destination);
      o.start(); o.stop(audioCtx.currentTime + 0.35);
    } catch (e) { /* trình duyệt chặn âm thanh */ }
  }

  function setBar(node, value, range) {
    const pct = clamp(value / range, -1, 1) * 50;
    if (pct >= 0) { node.style.left = "50%"; node.style.width = pct + "%"; }
    else { node.style.left = 50 + pct + "%"; node.style.width = -pct + "%"; }
  }

  /* ---------------- render ---------------- */
  function render(msg) {
    if (!msg || msg.type !== "state") return;
    const hp = msg.head_pose || {};
    const status = msg.driver_status || "NO_SIGNAL";
    const w = msg.warning || {};
    const threshold = w.threshold || config.warn_after || 2;

    document.body.dataset.status = status;

    const dir = hp.direction || "--";
    el.mDirection.textContent = dir === "NO_FACE" ? "" : dir;
    el.mDirection.title = dir === "NO_FACE" ? "" : DIR_TEXT[dir] || "";
    el.mYaw.textContent = fmt(hp.yaw);
    el.mPitch.textContent = fmt(hp.pitch);
    el.mRoll.textContent = fmt(hp.roll);
    el.mConf.textContent = msg.face_detected ? `${Math.round((hp.confidence ?? 0) * 100)}%` : "—";
    setBar(el.bYaw, hp.yaw ?? 0, RANGE.yaw);
    setBar(el.bPitch, hp.pitch ?? 0, RANGE.pitch);
    setBar(el.bRoll, hp.roll ?? 0, RANGE.roll);

    const R = 100;
    let fx, fy;
    if (hp.yaw != null && hp.pitch != null) {
      fx = clamp(hp.yaw / RANGE.yaw, -1, 1);
      fy = clamp(hp.pitch / RANGE.pitch, -1, 1);
    } else {
      [fx, fy] = DIR_POS[dir] || [0, 0];
    }
    el.headDot.style.transform = `translate(${fx * R}px, ${-fy * R}px) rotate(${hp.roll ?? 0}deg)`;
    el.headDot.style.opacity = msg.face_detected ? 1 : 0.35;

    const det = msg.detection || {};
    lastDet = det.bbox ? { bbox: det.bbox, label: det.label, direction: dir,
                           confidence: hp.confidence, warning: status === "WARNING" } : null;
    drawBox();

  el.statusBig.textContent = status === "NO_SIGNAL" ? "" : status;
el.statusSub.textContent = status === "NO_SIGNAL"
  ? ""
  : status === "WARNING" && w.message
    ? w.message
    : STATUS_SUB[status] || "";

el.videoBadge.textContent = status === "NO_SIGNAL" ? "" : status;
el.videoBadge.style.color =
  status === "WARNING" ? "#fca5a5" :
  status === "NORMAL" ? "#86efac" :
  "#cbd5e1";

el.videoDir.textContent = dir === "NO_FACE"
  ? ""
  : DIR_TEXT[dir]
    ? `${dir} · ${DIR_TEXT[dir]}`
    : dir;

    const dur = w.off_duration || 0;
    el.timerText.textContent = `${dur.toFixed(1)} / ${threshold.toFixed(1)} s`;
    el.timerFill.style.width = `${clamp(dur / threshold, 0, 1) * 100}%`;
    el.timerFill.classList.toggle("hot", status === "WARNING");

    const active = !!w.active;
    el.alarmBanner.hidden = !active;
    el.alarmText.textContent = active ? `CẢNH BÁO: ${w.message || "mất tập trung"}` : "";
    el.warnBox.classList.toggle("active", active);
    el.warnMsg.textContent = active ? w.message || "Mất tập trung" : "Không có cảnh báo";

    el.aiPill.className = "pill " + (msg.ai_online ? "ok" : "bad");
    el.aiState.textContent = msg.ai_online ? "đang nhận dữ liệu" : "chưa có dữ liệu";

    if (status !== prevStatus) {
      if (status === "WARNING") { addLog(`WARNING — ${w.message || "mất tập trung"}`, "warn"); beep(); }
      else if (status === "NORMAL" && prevStatus === "WARNING") addLog("Trở lại NORMAL — tài xế nhìn thẳng", "ok");
      else if (status === "NO_SIGNAL") { if (prevStatus !== null) addLog("Mất tín hiệu từ AI", "warn"); }
      else if (prevStatus === null || prevStatus === "NO_SIGNAL") addLog("Bắt đầu nhận dữ liệu từ AI", "info");
      prevStatus = status;
    }
    if (dir !== prevDir && status !== "NO_SIGNAL") {
      if (prevDir !== null) addLog(`Hướng đầu: ${DIR_TEXT[dir] || dir}`, "info");
      prevDir = dir;
    }
  }

  /* ---------------- WebSocket (nhận kết quả AI) ---------------- */
  function setConn(ok, text) {
    el.connPill.className = "pill " + (ok ? "ok" : "bad");
    el.connText.textContent = text;
  }

  function connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => {
      retry = 0;
      setConn(true, "Đã kết nối");
      addLog("WebSocket đã kết nối", "ok");
    };
    ws.onmessage = (ev) => {
      try { render(JSON.parse(ev.data)); }
      catch (e) { console.error("JSON lỗi:", e, ev.data); }
    };
    ws.onclose = () => {
      setConn(false, "Mất kết nối — đang thử lại…");
      document.body.dataset.status = "NO_SIGNAL";
      el.statusBig.textContent = "";
      el.statusSub.textContent = "";
      el.videoBadge.textContent = "";
      el.videoDir.textContent = "";
      el.alarmBanner.hidden = true;
      el.aiPill.className = "pill bad";
      el.aiState.textContent = "chưa có dữ liệu";
      prevStatus = "NO_SIGNAL";
      const delay = Math.min(1000 * 2 ** retry++, 8000);
      setTimeout(connect, delay);
    };
    ws.onerror = () => ws.close();
  }

  /* ---------------- Webcam: dò, hiển thị, ghi hình, gửi khung hình cho AI ---------------- */
  const cam = { stream: null, recorder: null, chunks: [], recStart: 0, recTimerId: null,
                relayWs: null, relayId: null, canvas: document.createElement("canvas"),
                starting: false, autoFailed: false, noCamLogged: false, changeTimer: null };
  const RELAY_FPS = 10, RELAY_WIDTH = 640, RELAY_QUALITY = 0.7;

  const pad2 = (n) => String(n).padStart(2, "0");
  const stamp = () => { const d = new Date();
    return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}_${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`; };

  /* Ô "Nguồn hình ảnh": "Webcam" khi có webcam, "Không tìm thấy webcam" khi không có */
  function setSource(state) {
    const text = { checking: "Đang dò webcam…", webcam: "Webcam", none: "Không tìm thấy webcam" }[state];
    el.srcSelect.textContent = text;
    $("srcPill").className = "pill " + (state === "webcam" ? "ok" : state === "none" ? "bad" : "");
    el.srcSelect.dataset.state = state;
  }

  const MSG_NO_CAM = "<b>Không tìm thấy webcam.</b><br><small>Hãy cắm webcam vào máy. Trang tự nhận khi bạn cắm.</small>";
  const MSG_INSECURE = "<b>Không tìm thấy webcam.</b><br><small>Trình duyệt chỉ cho dùng webcam khi mở bằng " +
    "<code>http://localhost:8000</code> (hoặc HTTPS), không mở bằng địa chỉ IP.</small>";

  function showNoCam(html) {
    setSource("none");
    el.camBar.hidden = true;
    showVideoMsg(html || MSG_NO_CAM);
    if (!cam.noCamLogged) { addLog("Không tìm thấy webcam", "warn"); cam.noCamLogged = true; }
  }

  async function listCameras(selectedId) {
    try {
      const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
      el.camDevice.innerHTML = "";
      devs.forEach((d, i) => {
        const o = document.createElement("option");
        o.value = d.deviceId; o.textContent = d.label || `Webcam ${i + 1}`;
        el.camDevice.append(o);
      });
      if (selectedId) el.camDevice.value = selectedId;
      el.camDevice.hidden = devs.length <= 1;
    } catch (e) { console.warn("Không liệt kê được webcam", e); }
  }

  function camErrorText(e) {
    return e.name === "NotAllowedError" ? "Bạn chưa cho phép trình duyệt dùng webcam.<br><small>Bấm biểu tượng ổ khoá cạnh địa chỉ → Camera → Cho phép, rồi bấm Thử lại.</small>"
      : e.name === "NotReadableError" ? "Webcam đang được chương trình khác sử dụng.<br><small>Tắt Zoom, Teams, app Camera hoặc tab khác đang mở webcam rồi bấm Thử lại.</small>"
      : `Không mở được webcam (${e.name}).`;
  }

  async function startWebcam(deviceId) {
    if (cam.starting) return false;
    cam.starting = true;
    try {
      stopWebcam();
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { showNoCam(MSG_INSECURE); return false; }
      const want = (id) => ({ video: { deviceId: id ? { exact: id } : undefined, width: { ideal: 1280 },
                                       height: { ideal: 720 }, frameRate: { ideal: 30 } }, audio: false });
      let stream;
      try {
        try { stream = await navigator.mediaDevices.getUserMedia(want(deviceId)); }
        catch (e) {
          if (deviceId && e.name === "OverconstrainedError") stream = await navigator.mediaDevices.getUserMedia(want(null));
          else throw e;
        }
      } catch (e) {
        console.error("getUserMedia lỗi", e);
        if (e.name === "NotFoundError" || e.name === "OverconstrainedError") { showNoCam(); return false; }
        cam.autoFailed = true;
        setSource("webcam");
        showVideoMsg(`${camErrorText(e)}<br><button id="retryCam" class="btn" type="button">Thử lại</button>`);
        addLog(`Không mở được webcam (${e.name})`, "warn");
        return false;
      }
      cam.autoFailed = false;
      cam.noCamLogged = false;
      cam.stream = stream;
      el.videoEmpty.hidden = true;
      el.video.srcObject = stream;
      el.video.play().catch(() => {});
      setSource("webcam");
      const track = stream.getVideoTracks()[0];
      const s = track.getSettings();
      await listCameras(s.deviceId);
      el.camBar.hidden = false;
      el.camInfo.textContent = `${s.width}×${s.height} @ ${Math.round(s.frameRate || 0)} fps`;
      addLog(`Đã bật webcam: ${track.label || "webcam"} (${s.width}×${s.height})`, "ok");
      track.addEventListener("ended", () => {
        addLog("Webcam bị ngắt", "warn");
        stopWebcam();
        setTimeout(() => detectWebcam(false), 500);
      });
      startRelay();
      return true;
    } finally {
      cam.starting = false;
    }
  }

  function stopWebcam() {
    stopRecording();
    stopRelay();
    if (cam.stream) { cam.stream.getTracks().forEach((t) => t.stop()); cam.stream = null; }
    el.video.srcObject = null;
    el.camBar.hidden = true;
  }

  async function detectWebcam(first) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) { showNoCam(MSG_INSECURE); return; }
    let n = 0;
    try { n = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput").length; }
    catch (e) { console.warn("enumerateDevices lỗi", e); }
    if (n > 0) {
      setSource("webcam");
      if (!cam.stream && !cam.starting && !cam.autoFailed) await startWebcam(null);
      else if (cam.stream) await listCameras(el.camDevice.value);
      return;
    }
    if (first && !cam.stream) { await startWebcam(null); return; }
    if (cam.stream) stopWebcam();
    showNoCam();
  }

  /* --- Ghi hình: lưu file .webm về máy --- */
  function pickMime() {
    const list = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm", "video/mp4"];
    return list.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || "";
  }

  function startRecording() {
    if (!cam.stream || !window.MediaRecorder) { addLog("Trình duyệt không hỗ trợ ghi hình", "warn"); return; }
    cam.chunks = [];
    const mime = pickMime();
    cam.recorder = new MediaRecorder(cam.stream, mime ? { mimeType: mime, videoBitsPerSecond: 4_000_000 } : undefined);
    cam.recorder.ondataavailable = (e) => { if (e.data && e.data.size) cam.chunks.push(e.data); };
    cam.recorder.onstop = () => {
      const type = cam.recorder.mimeType || "video/webm";
      const ext = type.includes("mp4") ? "mp4" : "webm";
      const blob = new Blob(cam.chunks, { type });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `recording_${stamp()}.${ext}`;
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      addLog(`Đã lưu ${a.download} (${(blob.size / 1048576).toFixed(1)} MB) vào thư mục Tải xuống`, "ok");
      cam.recorder = null; cam.chunks = [];
    };
    cam.recorder.start(1000);
    cam.recStart = Date.now();
    el.recBtn.classList.add("on");
    el.recBtn.textContent = "⏹ Dừng và lưu";
    el.recTimer.hidden = false;
    cam.recTimerId = setInterval(() => {
      const s = Math.floor((Date.now() - cam.recStart) / 1000);
      el.recTimer.textContent = `${pad2(Math.floor(s / 60))}:${pad2(s % 60)}`;
    }, 250);
    addLog("Bắt đầu ghi hình", "info");
  }

  function stopRecording() {
    clearInterval(cam.recTimerId);
    el.recBtn.classList.remove("on");
    el.recBtn.textContent = "⏺ Ghi hình";
    el.recTimer.hidden = true;
    if (cam.recorder && cam.recorder.state !== "inactive") cam.recorder.stop();
  }

  /* --- Chuyển tiếp khung hình tới server (AI đọc qua /stream.mjpg) --- */
  function startRelay() {
    stopRelay();
    if (!el.relayChk.checked || !cam.stream) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const sock = new WebSocket(`${proto}://${location.host}/ws/camera`);
    sock.binaryType = "arraybuffer";
    cam.relayWs = sock;
    let busy = false;
    sock.onopen = () => {
      cam.relayId = setInterval(() => {
        const v = el.video;
        if (busy || sock.readyState !== 1 || !v.videoWidth || sock.bufferedAmount > 1_000_000) return;
        const scale = Math.min(1, RELAY_WIDTH / v.videoWidth);
        cam.canvas.width = Math.round(v.videoWidth * scale);
        cam.canvas.height = Math.round(v.videoHeight * scale);
        cam.canvas.getContext("2d").drawImage(v, 0, 0, cam.canvas.width, cam.canvas.height);
        busy = true;
        cam.canvas.toBlob(async (b) => {
          try { if (b && sock.readyState === 1) sock.send(await b.arrayBuffer()); }
          finally { busy = false; }
        }, "image/jpeg", RELAY_QUALITY);
      }, 1000 / RELAY_FPS);
    };
    sock.onclose = () => {
      clearInterval(cam.relayId);
      if (cam.relayWs === sock && cam.stream && el.relayChk.checked) setTimeout(startRelay, 2000);
    };
    sock.onerror = () => sock.close();el.statusBig.textContent = status === "NO_SIGNAL" ? "NO SIGNAL" : status;
  }

  function stopRelay() {
    clearInterval(cam.relayId);
    const s = cam.relayWs; cam.relayWs = null;
    if (s) { s.onclose = null; try { s.close(); } catch (e) { /* bỏ qua */ } }
  }

  el.camDevice.addEventListener("change", () => startWebcam(el.camDevice.value));
  el.recBtn.addEventListener("click", () => (cam.recorder ? stopRecording() : startRecording()));
  el.relayChk.addEventListener("change", () => (el.relayChk.checked ? startRelay() : stopRelay()));
  el.videoEmpty.addEventListener("click", (e) => {
    if (e.target && e.target.id === "retryCam") { cam.autoFailed = false; detectWebcam(true); }
  });
  window.addEventListener("beforeunload", () => { if (cam.recorder && cam.recorder.state !== "inactive") cam.recorder.stop(); });

  /* ---------------- init ---------------- */
  async function init() {
    el.video.addEventListener("loadeddata", drawBox);
    window.addEventListener("resize", drawBox);
    try { config = await (await fetch("/api/config")).json(); }
    catch (e) { console.error("Không đọc được /api/config", e); }
    connect();
    setSource("checking");
    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
      navigator.mediaDevices.addEventListener("devicechange", () => {
        clearTimeout(cam.changeTimer);
        cam.changeTimer = setTimeout(() => detectWebcam(false), 500);
      });
    }
    await detectWebcam(true);
  }

  el.clearLog.addEventListener("click", () => { el.log.innerHTML = ""; });

  init();
})();
