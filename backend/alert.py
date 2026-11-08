"""Logic cảnh báo tài xế - module độc lập, có thể test không cần FastAPI.

Quy ước góc (cần thống nhất với nhóm AI, xem docs/API.md):
  yaw   > 0  : quay sang PHẢI,  yaw   < 0 : quay sang TRÁI   (độ)
  pitch > 0  : ngẩng LÊN,       pitch < 0 : cúi XUỐNG        (độ)
  roll       : nghiêng đầu (độ)
"""
from dataclasses import dataclass, field
from typing import Optional

FORWARD = "FORWARD"
NO_FACE = "NO_FACE"
OFF_DIRECTIONS = {"LEFT", "RIGHT", "UP", "DOWN"}

MESSAGES = {
    "LEFT": "Tài xế quay đầu sang TRÁI quá lâu",
    "RIGHT": "Tài xế quay đầu sang PHẢI quá lâu",
    "UP": "Tài xế ngẩng đầu quá lâu",
    "DOWN": "Tài xế cúi đầu quá lâu",
    NO_FACE: "Không phát hiện khuôn mặt tài xế",
}


def classify_direction(yaw: float, pitch: float,
                       yaw_th: float = 20.0, pitch_th: float = 15.0) -> str:
    """Phân loại hướng đầu từ Yaw/Pitch (dùng khi AI không gửi sẵn direction)."""
    yaw_ratio = abs(yaw) / yaw_th
    pitch_ratio = abs(pitch) / pitch_th
    if yaw_ratio > 1 and yaw_ratio >= pitch_ratio:
        return "RIGHT" if yaw > 0 else "LEFT"
    if pitch_ratio > 1:
        return "UP" if pitch > 0 else "DOWN"
    return FORWARD


@dataclass
class AlertEngine:
    warn_after: float = 2.0        # lệch hướng liên tục >= 2s thì cảnh báo
    recover_after: float = 0.5     # nhìn thẳng liên tục >= 0.5s thì tắt cảnh báo (chống nhiễu)
    face_lost_grace: float = 1.0   # mất mặt < 1s thì giữ nguyên trạng thái cũ
    min_confidence: float = 0.5    # độ tin cậy thấp hơn thì coi như không chắc chắn

    warning: bool = False
    reason: Optional[str] = None
    _off_since: Optional[float] = field(default=None, repr=False)
    _straight_since: Optional[float] = field(default=None, repr=False)
    _uncertain_since: Optional[float] = field(default=None, repr=False)

    def reset(self) -> None:
        self.warning = False
        self.reason = None
        self._off_since = self._straight_since = self._uncertain_since = None

    def update(self, direction: str, now: float, confidence: float = 1.0) -> dict:
        direction = (direction or NO_FACE).upper()
        uncertain = direction == NO_FACE or confidence < self.min_confidence

        if uncertain:
            if self._uncertain_since is None:
                self._uncertain_since = now
            if now - self._uncertain_since < self.face_lost_grace:
                return self.snapshot(now)          # giữ nguyên, bỏ qua khung nhiễu
            off, reason = True, NO_FACE
        else:
            self._uncertain_since = None
            off = direction != FORWARD
            reason = direction

        if off:
            self._straight_since = None
            if self._off_since is None:
                self._off_since = now
            self.reason = reason
            if not self.warning and now - self._off_since >= self.warn_after:
                self.warning = True
        else:
            if self._straight_since is None:
                self._straight_since = now
            if now - self._straight_since >= self.recover_after:
                self._off_since = None
                self.warning = False
                self.reason = None
        return self.snapshot(now)

    def snapshot(self, now: float) -> dict:
        off_duration = (now - self._off_since) if self._off_since is not None else 0.0
        return {
            "active": self.warning,
            "code": self.reason if self.warning else None,
            "message": MESSAGES.get(self.reason, "") if self.warning else "",
            "off_duration": round(off_duration, 2),
            "threshold": self.warn_after,
        }
