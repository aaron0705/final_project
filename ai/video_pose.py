"""AI ước lượng hướng đầu tài xế từ video/camera và gửi vào dashboard.

Ví dụ:
  python video_pose.py --source ../data/sample.mp4 --loop        # video file, lặp vô hạn
  python video_pose.py --source 0                                # webcam số 0
  python video_pose.py --source ../data/sample.mp4 --url http://localhost:8000

Lần chạy đầu sẽ tự tải model face_landmarker.task (~4 MB) về thư mục models/.
Script tự chuyển dashboard sang chế độ "live" (tắt bằng --no-set-live).
"""
import argparse
import json
import statistics
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import cv2
import mediapipe as mp
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision

from pose import IDS, Smoother, estimate_head_pose

MODEL_URL = ("https://storage.googleapis.com/mediapipe-models/face_landmarker/"
             "face_landmarker/float16/1/face_landmarker.task")
DEFAULT_MODEL = Path(__file__).resolve().parent / "models" / "face_landmarker.task"


def ensure_model(path: Path) -> Path:
    if path.exists() and path.stat().st_size > 1_000_000:
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    print(f"Đang tải model về {path} ...")
    urllib.request.urlretrieve(MODEL_URL, path)
    return path


def post_json(url: str, payload: dict, timeout: float = 2.0) -> dict:
    req = urllib.request.Request(url, data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def make_landmarker(model_path: Path):
    opts = vision.FaceLandmarkerOptions(
        base_options=mp_python.BaseOptions(model_asset_path=str(model_path)),
        running_mode=vision.RunningMode.VIDEO,
        num_faces=1,
        min_face_detection_confidence=0.5,
        min_face_presence_confidence=0.5,
        min_tracking_confidence=0.5,
    )
    return vision.FaceLandmarker.create_from_options(opts)


def open_source(src: str):
    cap = cv2.VideoCapture(int(src) if src.isdigit() else src)
    if not cap.isOpened():
        sys.exit(f"Không mở được nguồn video: {src}")
    return cap


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--source", default="../data/sample.mp4", help="đường dẫn video hoặc số thứ tự camera")
    ap.add_argument("--url", default="http://localhost:8000", help="địa chỉ dashboard")
    ap.add_argument("--model", default=str(DEFAULT_MODEL))
    ap.add_argument("--loop", action="store_true", help="lặp lại video khi hết")
    ap.add_argument("--flip-yaw", action="store_true", help="đảo chiều trái/phải")
    ap.add_argument("--smooth", type=float, default=0.5, help="hệ số làm mượt 0..1 (1 = không làm mượt)")
    ap.add_argument("--max-hz", type=float, default=15.0, help="số lần gửi tối đa mỗi giây")
    ap.add_argument("--calibrate", type=float, default=3.0,
                    help="số giây đầu dùng để hiệu chỉnh 'nhìn thẳng' = 0 (0 = tắt)")
    ap.add_argument("--yaw-offset", type=float, default=None, help="trừ thủ công vào yaw (độ)")
    ap.add_argument("--pitch-offset", type=float, default=None, help="trừ thủ công vào pitch (độ)")
    ap.add_argument("--roll-offset", type=float, default=None, help="trừ thủ công vào roll (độ)")
    ap.add_argument("--no-set-live", action="store_true", help="không tự chuyển dashboard sang chế độ live")
    a = ap.parse_args()

    model = ensure_model(Path(a.model))
    is_stream = a.source.startswith(("http://", "https://", "rtsp://"))   # ví dụ http://localhost:8000/stream.mjpg
    is_file = not (a.source.isdigit() or is_stream)
    base = a.url.rstrip("/")

    # chờ dashboard sẵn sàng (hữu ích khi chạy bằng Docker)
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

    smooth = Smoother(a.smooth)
    # Hiệu chỉnh gốc: góc đo được so với trục camera, nên khi camera đặt lệch thì
    # "nhìn thẳng" không bằng 0. Nhập tay offset, hoặc để tự lấy trung vị trong --calibrate giây đầu.
    manual = [a.yaw_offset, a.pitch_offset, a.roll_offset]
    if any(v is not None for v in manual):
        offset = tuple(v or 0.0 for v in manual)
        print(f"Dùng offset thủ công: yaw={offset[0]} pitch={offset[1]} roll={offset[2]}")
    elif a.calibrate <= 0:
        offset = (0.0, 0.0, 0.0)
    else:
        offset = None
        print(f"Đang hiệu chỉnh {a.calibrate:.0f} giây đầu: hãy để tài xế nhìn thẳng phía trước.")
    cal_samples: list = []
    calib_until = None
    min_gap = 1.0 / a.max_hz
    ts_offset_ms = 0          # VIDEO mode cần timestamp tăng dần qua các vòng lặp
    frames = sent = 0
    last_send = 0.0
    last_live_try = 0.0
    t_report = time.monotonic()

    while True:
        cap = open_source(a.source)
        fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
        if fps != fps or fps <= 1 or fps > 240:
            fps = 25.0
        landmarker = make_landmarker(model)
        smooth.reset()
        start = time.monotonic()
        idx = 0
        last_ms = 0
        print(f"Bắt đầu đọc {a.source} ({fps:.1f} fps)")

        while True:
            ok, frame = cap.read()
            if not ok:
                break
            if is_file:
                # phát đúng tốc độ thật của video, bỏ khung nếu xử lý chậm
                due = start + idx / fps
                now = time.monotonic()
                if now < due:
                    time.sleep(due - now)
                elif now - due > 1.0 / fps * 2:
                    idx += 1
                    continue
            idx += 1
            frames += 1
            h, w = frame.shape[:2]
            video_ms = cap.get(cv2.CAP_PROP_POS_MSEC) if is_file else None
            ts = int(ts_offset_ms + (video_ms if is_file else (time.monotonic() - start) * 1000))
            ts = max(ts, last_ms + 1)
            last_ms = ts

            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            result = landmarker.detect_for_video(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb), ts)

            payload = {"timestamp": time.time()}
            if is_file:
                payload["video_time"] = round(video_ms / 1000.0, 3)
            if result.face_landmarks:
                lms = result.face_landmarks[0]
                pts = [(lms[i].x * w, lms[i].y * h) for i in IDS]
                est = estimate_head_pose(pts, w, h, flip_yaw=a.flip_yaw)
            else:
                est = None

            if est is None:
                smooth.reset()
                payload.update(yaw=0.0, pitch=0.0, roll=0.0, confidence=0.0, face_detected=False)
            else:
                cur = smooth(est)
                if offset is None:
                    # đang hiệu chỉnh: gom mẫu, tạm gửi 0 để không báo nhầm
                    if calib_until is None:
                        calib_until = time.monotonic() + a.calibrate
                    if time.monotonic() < calib_until:
                        cal_samples.append(cur)
                        cur = (0.0, 0.0, 0.0)
                    else:
                        offset = tuple(statistics.median(s[k] for s in cal_samples)
                                       for k in range(3)) if cal_samples else (0.0, 0.0, 0.0)
                        print(f"Đã hiệu chỉnh gốc (coi tư thế lúc đầu là nhìn thẳng): "
                              f"--yaw-offset {offset[0]:.1f} --pitch-offset {offset[1]:.1f} "
                              f"--roll-offset {offset[2]:.1f}")
                        cur = tuple(c - o for c, o in zip(cur, offset))
                else:
                    cur = tuple(c - o for c, o in zip(cur, offset))
                yaw, pitch, roll = cur
                payload.update(yaw=round(yaw, 1), pitch=round(pitch, 1), roll=round(roll, 1),
                               confidence=1.0, face_detected=True)

            now = time.monotonic()
            if now - last_send >= min_gap:
                last_send = now
                try:
                    res = post_json(base + "/api/pose", payload)
                    if res.get("accepted"):
                        sent += 1
                    elif not a.no_set_live and now - last_live_try > 5:
                        # dashboard vừa khởi động lại nên về chế độ mock -> bật lại live
                        last_live_try = now
                        post_json(base + "/api/mode", {"mode": "live"})
                except (urllib.error.URLError, TimeoutError) as e:
                    print("Gửi dữ liệu lỗi:", e)

            if now - t_report >= 5:
                print(f"[{frames} khung] đã gửi {sent} | yaw={payload['yaw']:+.1f} "
                      f"pitch={payload['pitch']:+.1f} roll={payload['roll']:+.1f} "
                      f"face={payload['face_detected']}")
                t_report = now

        cap.release()
        landmarker.close()
        ts_offset_ms = last_ms + 1000
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
