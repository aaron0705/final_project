/* Dashboard giám sát tài xế - client */
(() => {
  const $ = (id) => document.getElementById(id);
  const el = {
    video: $("video"), overlay: $("overlay"), videoEmpty: $("videoEmpty"), videoBadge: $("videoBadge"), videoDir: $("videoDir"),
    alarmBanner: $("alarmBanner"), alarmText: $("alarmText"),
    connPill: $("connPill"), connText: $("connText"), aiPill: $("aiPill"), aiText: $("aiText"),
    modeSelect: $("modeSelect"), soundBtn: $("soundBtn"),
    statusBig: $("statusBig"), statusSub: $("statusSub"),
    timerText: $("timerText"), timerFill: $("timerFill"),
    warnBox: $("warnBox"), warnMsg: $("warnMsg"),
    headDot: $("headDot"),
    mDirection: $("mDirection"), mYaw: $("mYaw"), mPitch: $("mPitch"), mRoll: $("mRoll"), mConf: $("mConf"),
    bYaw: $("bYaw"), bPitch: $("bPitch"), bRoll: $("bRoll"),
    log: $("log"), clearLog: $("clearLog"),
    srcSelect: $("srcSelect"), camBar: $("camBar"), camDevice: $("camDevice"), recBtn: $("recBtn"),
    recTimer: $("recTimer"), relayChk: $("relayChk"), camInfo: $("camInfo"), videoWrap: $("videoWrap"),
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
  const RANGE = { yaw: 60, pitch: 40, roll: 40 };   // biên hiển thị thanh đo (độ)

  let ws = null, retry = 0, soundOn = false, audioCtx = null;
  let prevStatus = null, prevDir = null, config = { warn_after: 2.0 };

  /* ---------------- helpers ---------------- */
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const fmt = (v) => (v == null ? "—" : `${Number(v).toFixed(1)}°`);

  // Khi mô hình chỉ cho hướng (Object Detection) không có góc, đặt chấm radar theo hướng
  const DIR_POS = { FORWARD: [0, 0], LEFT: [-0.6, 0], RIGHT: [0.6, 0], UP: [0, 0.6], DOWN: [0, -0.6] };
  let lastDet = null;   // khung bao gần nhất, để vẽ lại khi đổi kích thước

  /* Vẽ khung bao lên video (video dùng object-fit: contain nên phải tính phần ảnh thật) */
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
    el.videoEmpty.innerHTML = html;
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

    // Đồng bộ video với khung hình mà AI đang xử lý (chỉ khi AI đọc từ file video, không áp dụng cho webcam)
    if (msg.video_time != null && !el.video.srcObject && el.video.readyState > 0 && !el.video.seeking) {
      const drift = Math.abs(el.video.currentTime - msg.video_time);
      const dur = el.video.duration || 0;
      const wrapDrift = dur ? Math.min(drift, dur - drift) : drift;   // chênh lệch khi video lặp vòng
      if (wrapDrift > 0.4) {
        el.video.currentTime = msg.video_time;
        el.video.play().catch(() => {});
      }
    }

    // Head pose
    const dir = hp.direction || "--";
    el.mDirection.textContent = DIR_TEXT[dir] ? `${dir}` : dir;
    el.mDirection.title = DIR_TEXT[dir] || "";
    el.mYaw.textContent = fmt(hp.yaw);
    el.mPitch.textContent = fmt(hp.pitch);
    el.mRoll.textContent = fmt(hp.roll);
    el.mConf.textContent = msg.face_detected ? `${Math.round((hp.confidence ?? 0) * 100)}%` : "—";
    setBar(el.bYaw, hp.yaw ?? 0, RANGE.yaw);
    setBar(el.bPitch, hp.pitch ?? 0, RANGE.pitch);
    setBar(el.bRoll, hp.roll ?? 0, RANGE.roll);

    // Radar: yaw -> ngang, pitch -> dọc, roll -> xoay
    const R = 100;
    let fx, fy;
    if (hp.yaw != null && hp.pitch != null) {
      fx = clamp(hp.yaw / RANGE.yaw, -1, 1);
      fy = clamp(hp.pitch / RANGE.pitch, -1, 1);
    } else {
      [fx, fy] = DIR_POS[dir] || [0, 0];
    }
    const x = fx * R;
    const y = -fy * R;
    el.headDot.style.transform = `translate(${x}px, ${y}px) rotate(${hp.roll ?? 0}deg)`;
    el.headDot.style.opacity = msg.face_detected ? 1 : 0.35;

    // Khung bao từ Object Detection
    const det = msg.detection || {};
    lastDet = det.bbox ? { bbox: det.bbox, label: det.label, direction: dir,
                           confidence: hp.confidence, warning: status === "WARNING" } : null;
    drawBox();

    // Status
    el.statusBig.textContent = status === "NO_SIGNAL" ? "NO SIGNAL" : status;
    el.statusSub.textContent = status === "WARNING" && w.message ? w.message : STATUS_SUB[status] || "";
    el.videoBadge.textContent = status === "NO_SIGNAL" ? "NO SIGNAL" : status;
    el.videoBadge.style.color = status === "WARNING" ? "#fca5a5" : status === "NORMAL" ? "#86efac" : "#cbd5e1";
    el.videoDir.textContent = DIR_TEXT[dir] ? `${dir} · ${DIR_TEXT[dir]}` : dir;

    // Timer
    const dur = w.off_duration || 0;
    el.timerText.textContent = `${dur.toFixed(1)} / ${threshold.toFixed(1)} s`;
    el.timerFill.style.width = `${clamp(dur / threshold, 0, 1) * 100}%`;
    el.timerFill.classList.toggle("hot", status === "WARNING");

    // Warning
    const active = !!w.active;
    el.alarmBanner.hidden = !active;
    el.alarmText.textContent = active ? `CẢNH BÁO: ${w.message || "mất tập trung"}` : "";
    el.warnBox.classList.toggle("active", active);
    el.warnMsg.textContent = active ? w.message || "Mất tập trung" : "Không có cảnh báo";

    // AI badge
    el.aiPill.className = "pill " + (msg.ai_online ? "ok" : "bad");
    el.aiText.textContent = msg.ai_online
      ? `Nguồn: ${msg.source === "mock" ? "giả lập" : "AI thật"}`
      : "AI: mất tín hiệu";
    if (el.modeSelect.value !== msg.source && msg.source) el.modeSelect.value = msg.source;

    // Log + âm thanh khi đổi trạng thái
    if (status !== prevStatus) {
      if (status === "WARNING") { addLog(`WARNING — ${w.message || "mất tập trung"}`, "warn"); beep(); }
      else if (status === "NORMAL" && prevStatus === "WARNING") addLog("Trở lại NORMAL — tài xế nhìn thẳng", "ok");
      else if (status === "NO_SIGNAL") addLog("Mất tín hiệu từ AI", "warn");
      else if (prevStatus === null || prevStatus === "NO_SIGNAL") addLog("Bắt đầu nhận dữ liệu", "info");
      prevStatus = status;
    }
    if (dir !== prevDir && status !== "NO_SIGNAL") {
      if (prevDir !== null) addLog(`Hướng đầu: ${DIR_TEXT[dir] || dir}`, "info");
      prevDir = dir;
    }
  }

  /* ---------------- WebSocket ---------------- */
  function setConn(ok, text) {
    el.connPill.className = "pill " + (ok ? "ok" : "bad");
    el.connText.textContent = text;
  }

  function connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => {
      retry = 0;
      console.log("WebSocket connected");
      setConn(true, "Đã kết nối");
      addLog("WebSocket đã kết nối", "ok");
    };
    ws.onmessage = (ev) => {
      try { render(JSON.parse(ev.data)); }
      catch (e) { console.error("JSON lỗi:", e, ev.data); }
    };
    ws.onclose = () => {
      console.warn("WebSocket disconnected");
      setConn(false, "Mất kết nối — đang thử lại…");
      document.body.dataset.status = "NO_SIGNAL";
      el.statusBig.textContent = "NO SIGNAL";
      el.alarmBanner.hidden = true;
      prevStatus = "NO_SIGNAL";
      const delay = Math.min(1000 * 2 ** retry++, 8000);
      setTimeout(connect, delay);
    };
    ws.onerror = () => ws.close();
  }

  /* ---------------- Webcam: hiển thị, ghi hình, gửi khung hình cho AI ---------------- */
  const cam = { stream: null, recorder: null, chunks: [], recStart: 0, recTimerId: null,
                relayWs: null, relayId: null, canvas: document.createElement("canvas"), sentFrames: 0 };
  const RELAY_FPS = 10, RELAY_WIDTH = 640, RELAY_QUALITY = 0.7;

  const pad2 = (n) => String(n).padStart(2, "0");
  const stamp = () => { const d = new Date();
    return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}_${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`; };

  async function listCameras(selectId) {
    try {
      const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
      el.camDevice.innerHTML = "";
      devs.forEach((d, i) => {
        const o = document.createElement("option");
        o.value = d.deviceId; o.textContent = d.label || `Camera ${i + 1}`;
        el.camDevice.append(o);
      });
      if (selectId) el.camDevice.value = selectId;
    } catch (e) { console.warn("Không liệt kê được camera", e); }
  }

  async function startWebcam(deviceId) {
    stopWebcam(false);
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showVideoMsg("Trình duyệt không cho dùng webcam. Hãy mở trang bằng <code>http://localhost:8000</code> (hoặc HTTPS).");
      return false;
    }
    try {
      cam.stream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: deviceId ? { exact: deviceId } : undefined, width: { ideal: 1280 }, height: { ideal: 720 },
                 frameRate: { ideal: 30 } },
        audio: false,
      });
    } catch (e) {
      console.error("getUserMedia lỗi", e);
      const why = e.name === "NotAllowedError" ? "Bạn chưa cho phép trình duyệt dùng camera (bấm biểu tượng ổ khoá cạnh địa chỉ → Camera → Cho phép)."
        : e.name === "NotFoundError" ? "Không tìm thấy webcam nào."
        : e.name === "NotReadableError" ? "Webcam đang được chương trình khác sử dụng (Zoom, Camera, Teams...). Hãy tắt chúng rồi thử lại."
        : `Không mở được webcam (${e.name}).`;
      showVideoMsg(why);
      return false;
    }
    el.videoEmpty.hidden = true;
    el.video.removeAttribute("loop");
    el.video.removeAttribute("controls");
    el.video.removeAttribute("src");
    el.video.srcObject = cam.stream;
    el.video.play().catch(() => {});
    el.videoWrap.classList.add("webcam");
    const track = cam.stream.getVideoTracks()[0];
    const s = track.getSettings();
    await listCameras(s.deviceId);
    el.camInfo.textContent = `${s.width}×${s.height} @ ${Math.round(s.frameRate || 0)} fps`;
    addLog(`Đã bật webcam: ${track.label || "camera"} (${s.width}×${s.height})`, "ok");
    track.addEventListener("ended", () => { addLog("Webcam bị ngắt", "warn"); stopWebcam(true); });
    startRelay();
    return true;
  }

  function stopWebcam(backToFile) {
    stopRecording();
    stopRelay();
    if (cam.stream) { cam.stream.getTracks().forEach((t) => t.stop()); cam.stream = null; }
    el.video.srcObject = null;
    el.videoWrap.classList.remove("webcam");
    if (backToFile) {
      el.srcSelect.value = "file";
      showFile();
    }
  }

  function showFile() {
    el.camBar.hidden = true;
    el.video.setAttribute("loop", "");
    el.video.setAttribute("controls", "");
    if (config.video_url) {
      el.video.src = `${config.video_url}?v=${Date.now()}`;
      el.video.play().catch(() => {});
    } else {
      showVideoMsg(`Server không tìm thấy file video.<br>Đường dẫn server đang tìm:<br><code>${config.video_path}</code>`);
    }
  }

  /* --- Ghi hình: lưu thành file .webm tải về máy (dùng để làm dữ liệu huấn luyện) --- */
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
          try { if (b && sock.readyState === 1) { sock.send(await b.arrayBuffer()); cam.sentFrames++; } }
          finally { busy = false; }
        }, "image/jpeg", RELAY_QUALITY);
      }, 1000 / RELAY_FPS);
    };
    sock.onclose = () => {
      clearInterval(cam.relayId);
      if (cam.relayWs === sock && cam.stream && el.relayChk.checked) setTimeout(startRelay, 2000);   // tự nối lại
    };
    sock.onerror = () => sock.close();
  }

  function stopRelay() {
    clearInterval(cam.relayId);
    const s = cam.relayWs; cam.relayWs = null;
    if (s) { s.onclose = null; try { s.close(); } catch (e) { /* bỏ qua */ } }
  }

  el.srcSelect.addEventListener("change", async () => {
    if (el.srcSelect.value === "webcam") {
      el.camBar.hidden = false;
      const ok = await startWebcam(null);
      if (!ok) { el.srcSelect.value = "file"; el.camBar.hidden = true; showFile(); }
    } else {
      stopWebcam(false);
      showFile();
    }
  });
  el.camDevice.addEventListener("change", () => startWebcam(el.camDevice.value));
  el.recBtn.addEventListener("click", () => (cam.recorder ? stopRecording() : startRecording()));
  el.relayChk.addEventListener("change", () => (el.relayChk.checked ? startRelay() : stopRelay()));
  window.addEventListener("beforeunload", () => { if (cam.recorder && cam.recorder.state !== "inactive") cam.recorder.stop(); });

  /* ---------------- init ---------------- */
  async function init() {
    try {
      config = await (await fetch("/api/config")).json();
      el.modeSelect.value = config.mode;
      if (config.video_url) {
        el.video.src = `${config.video_url}?v=${Date.now()}`;   // tránh trình duyệt dùng video cũ trong cache
        el.video.play().catch(() => {});
      } else {
        showVideoMsg(`Server không tìm thấy file video.<br>Đường dẫn server đang tìm:<br><code>${config.video_path}</code>`);
      }
    } catch (e) {
      console.error("Không đọc được /api/config", e);
      showVideoMsg("Không kết nối được tới server (/api/config).");
    }
    el.video.addEventListener("loadeddata", () => { el.videoEmpty.hidden = true; drawBox(); });
    window.addEventListener("resize", drawBox);
    el.video.addEventListener("error", () => {
      const err = el.video.error || {};
      console.error("Video error", err.code, err.message);
      const reason = {
        1: "Tải video bị huỷ.",
        2: "Lỗi mạng khi tải video.",
        3: "File video bị lỗi khi giải mã.",
        4: "Trình duyệt không hỗ trợ định dạng/codec của video này (cần MP4 H.264). Hãy chuyển đổi bằng ffmpeg.",
      }[err.code] || "Không phát được video.";
      showVideoMsg(`${reason}<br><small>Mã lỗi: ${err.code ?? "?"} — xem thêm trong Console (F12)</small>`);
    });
    connect();
  }

  el.modeSelect.addEventListener("change", async () => {
    try {
      await fetch("/api/mode", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: el.modeSelect.value }),
      });
      addLog(`Chuyển nguồn dữ liệu: ${el.modeSelect.value}`, "info");
      prevStatus = null;
    } catch (e) { addLog("Không đổi được nguồn dữ liệu", "warn"); }
  });

  el.soundBtn.addEventListener("click", () => {
    soundOn = !soundOn;
    el.soundBtn.textContent = soundOn ? "🔊 Âm thanh: bật" : "🔇 Âm thanh: tắt";
    if (soundOn) beep();
  });
  el.clearLog.addEventListener("click", () => { el.log.innerHTML = ""; });

  init();
})();
