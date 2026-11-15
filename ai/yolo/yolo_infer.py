"""Suy luận YOLO hướng đầu tài xế từ video/camera và gửi kết quả vào dashboard.

Ví dụ:
  python yolo_infer.py --weights weights/best.pt --source ../../data/sample.mp4 --loop
  python yolo_infer.py --weights weights/best.pt --source 0                    # webcam nối trực tiếp vào máy chạy AI
  python yolo_infer.py --weights weights/best.pt --source http://localhost:8000/stream.mjpg   # webcam bật trên dashboard
  python yolo_infer.py --weights weights/best.pt --source ../../data/sample.mp4 --roi 0.5,0,1,1

Tên lớp của mô hình được đổi sang hướng của dashboard theo từ khoá trong tên:
forward/front/straight -> FORWARD, left -> LEFT, right -> RIGHT, up -> UP, down -> DOWN.
Không phát hiện được lớp nào -> NO_FACE.
"""
import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.request
from collections import Counter, deque
from typing import Optional

import cv2
from ultralytics import YOLO

KEYWORDS = {
    "forward": "FORWARD", "front": "FORWARD", "straight": "FORWARD", "normal": "FORWARD",
    "left": "LEFT", "right": "RIGHT", "up": "UP", "down": "DOWN",
}


def to_direction(class_name: str) -> Optional[str]:
    """'head_left' -> LEFT, 'Forward' -> FORWARD, 'phone' -> None."""
    for tok in re.split(r"[^a-z]+", class_name.lower()):
        if tok in KEYWORDS:
            return KEYWORDS[tok]
    return None


def post_json(url: str, payload: dict, timeout: float = 2.0) -> dict:
    req = urllib.request.Request(url, data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def pick_detection(result, names, roi, min_conf):
    """Chọn khung có độ tin cậy cao nhất thuộc các lớp hướng đầu (và nằm trong vùng ROI nếu có)."""
    best = None
    if result.boxes is None:
        return None
    for box in result.boxes:
        conf = float(box.conf[0])
        if conf < min_conf:
            continue
        name = names[int(box.cls[0])]
        direction = to_direction(name)
        if direction is None:
            continue
        x1, y1, x2, y2 = (float(v) for v in box.xyxyn[0])
        if roi:
            cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
            if not (roi[0] <= cx <= roi[2] and roi[1] <= cy <= roi[3]):
                continue            # ví dụ bỏ qua hành khách ngồi ngoài vùng tài xế
        if best is None or conf > best["confidence"]:
            best = {"direction": direction, "label": name, "confidence": round(conf, 3),
                    "bbox": [round(x1, 4), round(y1, 4), round(x2, 4), round(y2, 4)]}
    return best


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--weights", default="weights/best.pt")
    ap.add_argument("--source", default="../../data/sample.mp4", help="đường dẫn video hoặc số thứ tự camera")
    ap.add_argument("--url", default="http://localhost:8000", help="địa chỉ dashboard")
    ap.add_argument("--conf", type=float, default=0.4, help="ngưỡng độ tin cậy tối thiểu")
    ap.add_argument("--imgsz", type=int, default=640)
    ap.add_argument("--device", default=None, help="0 = GPU, cpu = CPU")
    ap.add_argument("--roi", default=None, help="vùng tài xế x1,y1,x2,y2 chuẩn hoá 0..1, ví dụ 0.5,0,1,1")
    ap.add_argument("--vote", type=int, default=3, help="lấy hướng chiếm đa số trong N khung gần nhất (1 = tắt)")
    ap.add_argument("--max-hz", type=float, default=15.0, help="số lần gửi tối đa mỗi giây")
    ap.add_argument("--loop", action="store_true", help="lặp lại video khi hết")
    ap.add_argument("--no-set-live", action="store_true", help="không tự chuyển dashboard sang chế độ live")
    a = ap.parse_args()

    roi = [float(v) for v in a.roi.split(",")] if a.roi else None
    if roi and len(roi) != 4:
        sys.exit("--roi cần đúng 4 số: x1,y1,x2,y2")

    model = YOLO(a.weights)
    names = model.names
    mapped = {i: to_direction(n) for i, n in names.items()}
    print("Lớp của mô hình -> hướng dashboard:", {names[i]: mapped[i] for i in names})
    if not any(mapped.values()):
        sys.exit("Không lớp nào của mô hình khớp forward/left/right/up/down. Đổi tên lớp hoặc sửa KEYWORDS.")

    base = a.url.rstrip("/")
    for i in range(60):
        try:
            urllib.request.urlopen(base + "/api/health", timeout=2).read()
            break
        except Exception:
            if i == 0:
                print(f"Đang chờ dashboard tại {base} ...")
            time.sleep(1)
    else:
        sys.exit("Không kết nối được dashboard.")
    if not a.no_set_live:
        post_json(base + "/api/mode", {"mode": "live"})
        print("Đã chuyển dashboard sang chế độ live.")

    is_stream = a.source.startswith(("http://", "https://", "rtsp://"))   # ví dụ http://localhost:8000/stream.mjpg
    is_file = not (a.source.isdigit() or is_stream)
    history = deque(maxlen=max(1, a.vote))      # (direction hoặc None, detection)
    min_gap = 1.0 / a.max_hz
    last_send = last_live_try = 0.0
    frames = sent = 0
    infer_ms_total = 0.0
    t_report = time.monotonic()

    while True:
        cap = cv2.VideoCapture(int(a.source) if a.source.isdigit() else a.source)
        if not cap.isOpened():
            sys.exit(f"Không mở được nguồn video: {a.source}")
        fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
        if fps != fps or fps <= 1 or fps > 240:
            fps = 25.0
        history.clear()
        start = time.monotonic()
        idx = 0
        print(f"Bắt đầu đọc {a.source} ({fps:.1f} fps)")

        while True:
            ok, frame = cap.read()
            if not ok:
                break
            if is_file:
                due = start + idx / fps
                now = time.monotonic()
                if now < due:
                    time.sleep(due - now)
                elif now - due > 2.0 / fps:
                    idx += 1
                    continue                      # xử lý chậm hơn video -> bỏ khung để bắt kịp
            idx += 1
            frames += 1
            video_ms = cap.get(cv2.CAP_PROP_POS_MSEC) if is_file else None

            t0 = time.perf_counter()
            res = model.predict(frame, imgsz=a.imgsz, conf=a.conf, device=a.device, verbose=False)[0]
            infer_ms_total += (time.perf_counter() - t0) * 1000
            det = pick_detection(res, names, roi, a.conf)
            history.append((det["direction"] if det else None, det))

            # bỏ phiếu đa số để bớt nhấp nháy giữa hai lớp ở ranh giới
            votes = Counter(d for d, _ in history)
            voted = votes.most_common(1)[0][0]
            shown = next((dt for d, dt in reversed(history) if d == voted and dt), None) if voted else None

            payload = {"timestamp": time.time()}
            if is_file:
                payload["video_time"] = round(video_ms / 1000.0, 3)
            if shown:
                payload.update(shown, face_detected=True)
            else:
                payload.update(direction="NO_FACE", confidence=0.0, face_detected=False)

            now = time.monotonic()
            if now - last_send >= min_gap:
                last_send = now
                try:
                    r = post_json(base + "/api/pose", payload)
                    if r.get("accepted"):
                        sent += 1
                    elif not a.no_set_live and now - last_live_try > 5:
                        last_live_try = now
                        post_json(base + "/api/mode", {"mode": "live"})
                except (urllib.error.URLError, TimeoutError) as e:
                    print("Gửi dữ liệu lỗi:", e)

            if now - t_report >= 5:
                print(f"[{frames} khung] đã gửi {sent} | {payload['direction']} "
                      f"conf={payload['confidence']:.2f} | suy luận TB {infer_ms_total / max(frames, 1):.0f} ms/khung")
                t_report = now

        cap.release()
        if is_stream:
            print("Mất luồng video, thử nối lại sau 2 giây ...")
            time.sleep(2)
            continue
        if not (a.loop and is_file):
            break
    print("Kết thúc.")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nĐã dừng.")
