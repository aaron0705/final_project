"""Bộ giả lập dữ liệu Head Pose (Giai đoạn 1 - chưa cần AI).

Kịch bản lặp vô hạn, ~10 khung hình/giây, có nhiễu nhỏ để giống dữ liệu thật.
"""
import asyncio
import random
from typing import AsyncIterator, Optional

# (thời lượng giây, yaw, pitch, face_detected)
SCENARIO = [
    (5.0, 0, 0, True),      # nhìn thẳng
    (3.5, -35, 0, True),    # quay TRÁI 3.5s  -> phải cảnh báo sau 2s
    (4.0, 0, 0, True),      # nhìn thẳng -> hết cảnh báo
    (1.0, 32, 0, True),     # liếc PHẢI 1s   -> KHÔNG cảnh báo
    (4.0, 0, 0, True),
    (3.5, 35, 0, True),     # quay PHẢI 3.5s -> cảnh báo
    (4.0, 0, 0, True),
    (3.5, 0, -28, True),    # cúi đầu 3.5s   -> cảnh báo
    (4.0, 0, 0, True),
    (1.5, 0, 0, False),     # mất mặt thoáng qua (< 1s grace + ...)
    (4.0, 0, 0, True),
]


async def pose_stream(hz: float = 10.0) -> AsyncIterator[dict]:
    yaw = pitch = roll = 0.0
    period = 1.0 / hz
    while True:
        for duration, t_yaw, t_pitch, face in SCENARIO:
            steps = int(duration * hz)
            for _ in range(steps):
                # làm mượt về mục tiêu + nhiễu
                yaw += (t_yaw - yaw) * 0.35 + random.uniform(-1.2, 1.2)
                pitch += (t_pitch - pitch) * 0.35 + random.uniform(-0.8, 0.8)
                roll += (0 - roll) * 0.2 + random.uniform(-0.8, 0.8)
                yield {
                    "yaw": round(yaw, 1),
                    "pitch": round(pitch, 1),
                    "roll": round(roll, 1),
                    "confidence": round(random.uniform(0.88, 0.99), 2) if face else 0.0,
                    "face_detected": face,
                }
                await asyncio.sleep(period)
