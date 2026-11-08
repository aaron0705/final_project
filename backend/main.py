"""Dashboard giám sát tài xế - backend FastAPI + WebSocket.

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
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

from alert import FORWARD, NO_FACE, AlertEngine, classify_direction
from simulator import pose_stream

BASE_DIR = Path(__file__).resolve().parent.parent
FRONTEND_DIR = BASE_DIR / "frontend"
DATA_DIR = Path(os.getenv("VIDEO_DIR", BASE_DIR / "data"))
VIDEO_FILE = os.getenv("VIDEO_FILE", "sample.mp4")
DATA_SOURCE = os.getenv("DATA_SOURCE", "mock").lower()      # mock | live
WARN_AFTER = float(os.getenv("WARN_AFTER", "2.0"))
LIVE_TIMEOUT = float(os.getenv("LIVE_TIMEOUT", "2.0"))      # không có dữ liệu AI quá X giây -> NO_SIGNAL


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
    video_time: Optional[float] = Field(None, description="vị trí (giây) của khung hình trong file video, để dashboard đồng bộ video")

    @field_validator("direction")
    @classmethod
    def _check_direction(cls, v):
        if v is None:
            return v
        v = v.upper()
        if v not in VALID_DIRECTIONS:
            raise ValueError(f"direction phải thuộc {sorted(VALID_DIRECTIONS)}")
        return v


class ModeIn(BaseModel):
    mode: str


class Hub:
    def __init__(self) -> None:
        self.clients: set[WebSocket] = set()
        self.engine = AlertEngine(warn_after=WARN_AFTER)
        self.mode = DATA_SOURCE if DATA_SOURCE in ("mock", "live") else "mock"
        self.last_live = 0.0
        self.last_message: dict = self._empty_message()

    def _empty_message(self, status: str = "NO_SIGNAL") -> dict:
        return {
            "type": "state",
            "timestamp": time.time(),
            "source": getattr(self, "mode", "mock"),
            "ai_online": False,
            "head_pose": {"direction": NO_FACE, "yaw": None, "pitch": None, "roll": None, "confidence": 0.0},
            "detection": {"label": None, "bbox": None},
            "face_detected": False,
            "driver_status": status,
            "warning": {"active": False, "code": None, "message": "", "off_duration": 0.0, "threshold": WARN_AFTER},
        }

    def process(self, pose: PoseIn) -> dict:
        now = time.monotonic()
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
            "source": self.mode,
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
            "video_time": pose.video_time,
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

    def set_mode(self, mode: str) -> None:
        self.mode = mode
        self.engine.reset()
        self.last_live = 0.0
        self.last_message = self._empty_message("NORMAL" if mode == "mock" else "NO_SIGNAL")


hub = Hub()


async def simulator_task() -> None:
    async for data in pose_stream():
        if hub.mode == "mock":
            await hub.broadcast(hub.process(PoseIn(**data)))


async def watchdog_task() -> None:
    """Chế độ live: nếu AI ngừng gửi dữ liệu thì báo NO_SIGNAL (kiểm tra kết nối gián đoạn)."""
    while True:
        await asyncio.sleep(0.5)
        if hub.mode == "live" and time.monotonic() - hub.last_live > LIVE_TIMEOUT:
            if hub.last_message.get("driver_status") != "NO_SIGNAL":
                hub.engine.reset()
                hub.last_message = hub._empty_message()
                await hub.broadcast(hub.last_message)


@asynccontextmanager
async def lifespan(app: FastAPI):
    tasks = [asyncio.create_task(simulator_task()), asyncio.create_task(watchdog_task())]
    yield
    for t in tasks:
        t.cancel()


app = FastAPI(title="Driver Monitoring Dashboard", lifespan=lifespan)


# ---------------------------------------------------------------- REST
@app.get("/api/health")
def health():
    return {"status": "ok", "mode": hub.mode, "clients": len(hub.clients)}


@app.get("/api/config")
def config():
    video_exists = (DATA_DIR / VIDEO_FILE).exists()
    return {
        "mode": hub.mode,
        "video_url": f"/video/{VIDEO_FILE}" if video_exists else None,
        "video_path": str((DATA_DIR / VIDEO_FILE).resolve()),
        "warn_after": WARN_AFTER,
    }


@app.get("/api/state")
def state():
    return hub.last_message


@app.post("/api/mode")
async def set_mode(body: ModeIn):
    mode = body.mode.lower()
    if mode not in ("mock", "live"):
        raise HTTPException(400, "mode phải là 'mock' hoặc 'live'")
    hub.set_mode(mode)
    await hub.broadcast(hub.last_message)
    return {"mode": hub.mode}


@app.post("/api/pose")
async def ingest_pose(pose: PoseIn):
    """AI gửi kết quả head pose (HTTP). Chỉ được nhận khi mode = live."""
    if hub.mode != "live":
        return {"accepted": False, "reason": "dashboard đang ở chế độ mock"}
    hub.last_live = time.monotonic()
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
    """AI gửi head pose qua WebSocket (mỗi tin nhắn là một JSON PoseIn)."""
    await ws.accept()
    try:
        while True:
            raw = await ws.receive_text()
            if hub.mode != "live":
                continue
            try:
                pose = PoseIn(**json.loads(raw))
            except Exception as e:
                await ws.send_text(json.dumps({"error": str(e)}))
                continue
            hub.last_live = time.monotonic()
            await hub.broadcast(hub.process(pose))
    except WebSocketDisconnect:
        pass


# ---------------------------------------------------------------- Static
DATA_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/video", StaticFiles(directory=DATA_DIR), name="video")   # hỗ trợ Range cho MP4


@app.get("/")
def index():
    return FileResponse(FRONTEND_DIR / "index.html")


app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")
