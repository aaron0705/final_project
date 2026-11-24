"""Dashboard giám sát tài xế - backend FastAPI + WebSocket.

Luồng dữ liệu thật:
  Webcam -> trình duyệt -> /ws/camera -> /stream.mjpg -> AI -> POST /api/pose -> /ws -> dashboard

Chạy:  uvicorn main:app --reload --port 8000   (trong thư mục backend/)
"""
import asyncio
import json
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

from alert import NO_FACE, AlertEngine, classify_direction

BASE_DIR = Path(__file__).resolve().parent.parent
FRONTEND_DIR = BASE_DIR / "frontend"
WARN_AFTER = float(os.getenv("WARN_AFTER", "2.0"))
AI_TIMEOUT = float(os.getenv("AI_TIMEOUT", os.getenv("LIVE_TIMEOUT", "2.0")))   # AI không gửi dữ liệu quá X giây -> NO_SIGNAL

VALID_DIRECTIONS = {"FORWARD", "LEFT", "RIGHT", "UP", "DOWN", "NO_FACE"}


class PoseIn(BaseModel):
    """Kết quả AI cho một khung hình.

    Object Detection: chỉ cần `direction` + `confidence` (+ `bbox`).
    Head pose: gửi `yaw/pitch/roll`, `direction` có thể bỏ trống để backend tự phân loại.
    """
    yaw: Optional[float] = None
    pitch: Optional[float] = None
    roll: Optional[float] = None
    direction: Optional[str] = Field(None, description="FORWARD|LEFT|RIGHT|UP|DOWN|NO_FACE; bỏ trống thì tự tính từ yaw/pitch")
    confidence: float = Field(1.0, ge=0.0, le=1.0)
    face_detected: bool = True
    label: Optional[str] = Field(None, description="tên lớp gốc của mô hình detection, để hiển thị")
    bbox: Optional[list[float]] = Field(None, min_length=4, max_length=4,
                                        description="[x1, y1, x2, y2] chuẩn hoá 0..1 theo kích thước khung hình")
    timestamp: Optional[float] = None

    @field_validator("direction")
    @classmethod
    def _check_direction(cls, v):
        if v is None:
            return v
        v = v.upper()
        if v not in VALID_DIRECTIONS:
            raise ValueError(f"direction phải thuộc {sorted(VALID_DIRECTIONS)}")
        return v


class Hub:
    def __init__(self) -> None:
        self.clients: set[WebSocket] = set()
        self.engine = AlertEngine(warn_after=WARN_AFTER)
        self.last_ai = 0.0                       # lần gần nhất AI gửi dữ liệu (monotonic)
        self.last_message: dict = self._empty_message()
        # khung hình webcam do trình duyệt gửi lên, để AI đọc qua /stream.mjpg
        self.frame: Optional[bytes] = None
        self.frame_seq = 0
        self.frame_time = 0.0

    def set_frame(self, jpeg: bytes) -> None:
        self.frame = jpeg
        self.frame_seq += 1
        self.frame_time = time.monotonic()

    def camera_online(self) -> bool:
        return self.frame is not None and time.monotonic() - self.frame_time < 3.0

    def ai_online(self) -> bool:
        return self.last_ai > 0 and time.monotonic() - self.last_ai < AI_TIMEOUT

    def _empty_message(self) -> dict:
        return {
            "type": "state",
            "timestamp": time.time(),
            "ai_online": False,
            "head_pose": {"direction": NO_FACE, "yaw": None, "pitch": None, "roll": None, "confidence": 0.0},
            "detection": {"label": None, "bbox": None},
            "face_detected": False,
            "driver_status": "NO_SIGNAL",
            "warning": {"active": False, "code": None, "message": "", "off_duration": 0.0, "threshold": WARN_AFTER},
        }

    def process(self, pose: PoseIn) -> dict:
        now = time.monotonic()
        self.last_ai = now
        if not pose.face_detected:
            direction = NO_FACE
        elif pose.direction:
            direction = pose.direction
        elif pose.yaw is not None and pose.pitch is not None:
            direction = classify_direction(pose.yaw, pose.pitch)
        else:
            direction = NO_FACE      # không có hướng cũng không có góc -> coi như không thấy mặt
        has_face = direction != NO_FACE
        warning = self.engine.update(direction, now, pose.confidence if has_face else 0.0)

        def r(v, n=1):
            return None if v is None else round(v, n)

        msg = {
            "type": "state",
            "timestamp": pose.timestamp or time.time(),
            "ai_online": True,
            "head_pose": {
                "direction": direction,
                "yaw": r(pose.yaw),        # None nếu mô hình không cho góc (Object Detection)
                "pitch": r(pose.pitch),
                "roll": r(pose.roll),
                "confidence": r(pose.confidence, 2),
            },
            "detection": {
                "label": pose.label,
                "bbox": [round(v, 4) for v in pose.bbox] if pose.bbox and has_face else None,
            },
            "face_detected": has_face,
            "driver_status": "WARNING" if warning["active"] else "NORMAL",
            "warning": warning,
        }
        self.last_message = msg
        return msg

    async def broadcast(self, msg: dict) -> None:
        if not self.clients:
            return
        text = json.dumps(msg)
        dead = []
        for ws in list(self.clients):
            try:
                await ws.send_text(text)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.clients.discard(ws)


hub = Hub()


async def watchdog_task() -> None:
    """Nếu AI ngừng gửi dữ liệu thì báo NO_SIGNAL (xử lý trường hợp kết nối bị gián đoạn)."""
    while True:
        await asyncio.sleep(0.5)
        if hub.last_message.get("driver_status") != "NO_SIGNAL" and not hub.ai_online():
            hub.engine.reset()
            hub.last_message = hub._empty_message()
            await hub.broadcast(hub.last_message)


@asynccontextmanager
async def lifespan(app: FastAPI):
    task = asyncio.create_task(watchdog_task())
    yield
    task.cancel()


app = FastAPI(title="Driver Monitoring Dashboard", lifespan=lifespan)


# ---------------------------------------------------------------- REST
@app.get("/api/health")
def health():
    return {"status": "ok", "clients": len(hub.clients), "camera_online": hub.camera_online(),
            "ai_online": hub.ai_online()}


@app.get("/api/config")
def config():
    return {"warn_after": WARN_AFTER}


@app.get("/api/state")
def state():
    return hub.last_message


@app.post("/api/pose")
async def ingest_pose(pose: PoseIn):
    """AI gửi kết quả cho một khung hình (HTTP)."""
    await hub.broadcast(hub.process(pose))
    return {"accepted": True}


# ---------------------------------------------------------------- WebSocket
@app.websocket("/ws")
async def ws_dashboard(ws: WebSocket):
    await ws.accept()
    hub.clients.add(ws)
    await ws.send_text(json.dumps(hub.last_message))
    try:
        while True:
            await ws.receive_text()     # giữ kết nối, bỏ qua tin nhắn từ trình duyệt
    except WebSocketDisconnect:
        pass
    finally:
        hub.clients.discard(ws)


@app.websocket("/ws/ingest")
async def ws_ingest(ws: WebSocket):
    """AI gửi kết quả qua WebSocket (mỗi tin nhắn là một JSON PoseIn)."""
    await ws.accept()
    try:
        while True:
            raw = await ws.receive_text()
            try:
                pose = PoseIn(**json.loads(raw))
            except Exception as e:
                await ws.send_text(json.dumps({"error": str(e)}))
                continue
            await hub.broadcast(hub.process(pose))
    except WebSocketDisconnect:
        pass


# ---------------------------------------------------------------- Webcam relay
MAX_FRAME_BYTES = 2_000_000


@app.websocket("/ws/camera")
async def ws_camera(ws: WebSocket):
    """Trình duyệt gửi từng khung hình webcam (JPEG nhị phân) lên đây."""
    await ws.accept()
    try:
        while True:
            data = await ws.receive_bytes()
            if 2 < len(data) <= MAX_FRAME_BYTES and data[:2] == b"\xff\xd8":     # chỉ nhận JPEG hợp lệ
                hub.set_frame(data)
    except (WebSocketDisconnect, RuntimeError):
        pass


@app.get("/api/frame.jpg")
def latest_frame():
    """Khung hình webcam mới nhất (một ảnh JPEG)."""
    if hub.frame is None:
        raise HTTPException(404, "chưa có khung hình webcam, hãy mở dashboard và cho phép dùng webcam")
    return Response(hub.frame, media_type="image/jpeg", headers={"Cache-Control": "no-store"})


@app.get("/stream.mjpg")
async def mjpeg_stream():
    """Luồng MJPEG của webcam. AI đọc bằng cv2.VideoCapture('http://localhost:8000/stream.mjpg')."""
    boundary = "frame"

    async def gen():
        seq = -1
        while True:
            if hub.frame is not None and hub.frame_seq != seq:
                seq = hub.frame_seq
                jpg = hub.frame
                yield (f"--{boundary}\r\nContent-Type: image/jpeg\r\nContent-Length: {len(jpg)}\r\n\r\n").encode() \
                    + jpg + b"\r\n"
            await asyncio.sleep(0.02)

    return StreamingResponse(gen(), media_type=f"multipart/x-mixed-replace; boundary={boundary}",
                             headers={"Cache-Control": "no-store"})


# ---------------------------------------------------------------- Static
@app.get("/")
def index():
    return FileResponse(FRONTEND_DIR / "index.html", headers={"Cache-Control": "no-store"})


class NoCacheStatic(StaticFiles):
    async def get_response(self, path, scope):
        resp = await super().get_response(path, scope)
        resp.headers["Cache-Control"] = "no-store"
        return resp


app.mount("/static", NoCacheStatic(directory=FRONTEND_DIR), name="static")
