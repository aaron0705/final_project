"""Giả lập nhóm AI: gửi dữ liệu head pose vào dashboard (dùng để test D6 / Giai đoạn 2).

Ví dụ:
  python tools/fake_ai.py                       # kịch bản mặc định, qua HTTP
  python tools/fake_ai.py --url http://localhost:8000 --scenario left --seconds 5
Trước khi chạy hãy chuyển dashboard sang chế độ "AI thật (live)".
"""
import argparse
import json
import time
import urllib.request

SCENARIOS = {
    "straight": (0, 0),
    "left": (-35, 0),
    "right": (35, 0),
    "down": (0, -28),
    "up": (0, 25),
}


def post(url, payload):
    req = urllib.request.Request(
        url + "/api/pose", data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=3) as r:
        return json.loads(r.read())


def send_phase(url, name, seconds, hz=10, face=True):
    yaw, pitch = SCENARIOS[name]
    for _ in range(int(seconds * hz)):
        res = post(url, {"yaw": yaw, "pitch": pitch, "roll": 0, "confidence": 0.95 if face else 0.0,
                         "face_detected": face})
        if not res.get("accepted"):
            print("Dashboard từ chối:", res.get("reason"))
            return False
        time.sleep(1 / hz)
    print(f"đã gửi {name} {seconds}s")
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://localhost:8000")
    ap.add_argument("--scenario", choices=list(SCENARIOS), help="gửi một hướng duy nhất")
    ap.add_argument("--seconds", type=float, default=5)
    a = ap.parse_args()

    if a.scenario:
        send_phase(a.url, a.scenario, a.seconds)
        return
    plan = [("straight", 3), ("left", 4), ("straight", 3), ("right", 1), ("straight", 3), ("down", 4), ("straight", 3)]
    for name, sec in plan:
        if not send_phase(a.url, name, sec):
            return


if __name__ == "__main__":
    main()
