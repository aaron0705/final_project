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

    // Đồng bộ video với khung hình mà AI đang xử lý (chỉ khi AI đọc từ file video)
    if (msg.video_time != null && el.video.readyState > 0 && !el.video.seeking) {
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
