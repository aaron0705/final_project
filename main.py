
import asyncio
import time

from fastapi import FastAPI, WebSocket
from fastapi.staticfiles import StaticFiles
from starlette.websockets import WebSocketDisconnect

app = FastAPI()

# Temporary test settings
TURN_THRESHOLD_SECONDS = 2.0

# Mock head-pose sequence for testing
TEST_SEQUENCE = [
    ("CENTER", 0.0),
    ("CENTER", 0.0),
    ("LEFT", -30.0),
    ("LEFT", -30.0),
    ("LEFT", -30.0),
    ("CENTER", 0.0),
    ("RIGHT", 30.0),
    ("RIGHT", 30.0),
    ("RIGHT", 30.0),
]

@app.websocket("/ws/head-pose")
async def head_pose_websocket(websocket: WebSocket):
    await websocket.accept()

    direction_start = None
    previous_direction = None
    sequence_index = 0

    try:
        while True:
            # Mock input; replace with AI output later
            head_pose, yaw = TEST_SEQUENCE[
                sequence_index % len(TEST_SEQUENCE)
            ]
            sequence_index += 1

            now = time.monotonic()

            if head_pose == "CENTER":
                direction_start = None
                warning = False
                driver_status = "NORMAL"

            else:
                if head_pose != previous_direction:
                    direction_start = now

                elapsed = (
                    now - direction_start
                    if direction_start is not None
                    else 0.0
                )

                warning = elapsed >= TURN_THRESHOLD_SECONDS
                driver_status = (
                    "WARNING" if warning else "NORMAL"
                )

            previous_direction = head_pose

            await websocket.send_json({
                "head_pose": head_pose,
                "yaw": yaw,
                "pitch": 0.0,
                "roll": 0.0,
                "confidence": 0.95,
                "driver_state": driver_status,
                "warning": warning,
                "warning_message": (
                    "HEAD_TURN_TOO_LONG" if warning else "NONE"
                )
            })

            await asyncio.sleep(1)

    except WebSocketDisconnect:
        pass


# Serve video files
app.mount(
    "/videos",
    StaticFiles(directory="videos"),
    name="videos"
)

# Keep frontend mount last
app.mount(
    "/",
    StaticFiles(directory="frontend", html=True),
    name="frontend"
)
