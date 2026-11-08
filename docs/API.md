# Tài liệu API / WebSocket

Base URL mặc định: `http://localhost:8000`

## 1. Nhóm AI → Dashboard (đầu vào)

Chỉ được nhận khi dashboard ở chế độ `live` (chọn trên giao diện, hoặc `POST /api/mode`).

### `POST /api/pose` (hoặc WebSocket `/ws/ingest`, mỗi tin nhắn một JSON)

```json
{
  "yaw": -34.2,
  "pitch": 3.1,
  "roll": -1.4,
  "direction": "LEFT",
  "confidence": 0.93,
  "face_detected": true,
  "timestamp": 1760544000.123
}
```

| Trường | Kiểu | Bắt buộc | Mô tả |
|---|---|---|---|
| `yaw`, `pitch`, `roll` | float (độ) | có | Góc đầu. yaw>0 phải, pitch>0 ngẩng lên |
| `direction` | string | không | `FORWARD` `LEFT` `RIGHT` `UP` `DOWN`. Bỏ trống thì backend tự tính từ yaw/pitch |
| `confidence` | float 0..1 | không (mặc định 1) | < 0,5 thì coi là không chắc chắn |
| `face_detected` | bool | không (mặc định true) | `false` thì hướng = `NO_FACE` |
| `timestamp` | float (epoch s) | không | |
| `video_time` | float (giây) | không | Vị trí khung hình trong file video. Có trường này, dashboard tự kéo video về đúng khung hình AI đang xử lý. Bỏ trống nếu nguồn là camera |

Phản hồi: `{"accepted": true}`. Gửi khoảng 10 khung/giây là đủ.

## 2. Dashboard → trình duyệt (đầu ra)

### WebSocket `/ws`

Mỗi khi có dữ liệu mới, server đẩy một tin nhắn:

```json
{
  "type": "state",
  "timestamp": 1760544000.123,
  "source": "live",
  "ai_online": true,
  "head_pose": {"direction": "LEFT", "yaw": -34.2, "pitch": 3.1, "roll": -1.4, "confidence": 0.93},
  "face_detected": true,
  "video_time": 12.48,
  "driver_status": "WARNING",
  "warning": {"active": true, "code": "LEFT", "message": "Tài xế quay đầu sang TRÁI quá lâu",
              "off_duration": 2.4, "threshold": 2.0}
}
```

| Trường | Giá trị |
|---|---|
| `driver_status` | `NORMAL`, `WARNING`, `NO_SIGNAL` (AI ngừng gửi dữ liệu) |
| `head_pose.direction` | `FORWARD`, `LEFT`, `RIGHT`, `UP`, `DOWN`, `NO_FACE` |
| `warning.code` | hướng gây cảnh báo hoặc `NO_FACE`; `null` nếu không cảnh báo |
| `warning.off_duration` | số giây đã lệch hướng liên tục |

## 3. Logic cảnh báo (`backend/alert.py`)

- Lệch hướng (khác `FORWARD`) liên tục ≥ `WARN_AFTER` (2 s) → `WARNING`.
- Nhìn thẳng liên tục ≥ 0,5 s → trở lại `NORMAL` (chống nhấp nháy do nhiễu; liếc thẳng < 0,5 s không reset đồng hồ).
- Mất mặt hoặc `confidence` thấp < 1 s → giữ nguyên trạng thái trước; ≥ 1 s → tính là lệch hướng (`NO_FACE`).

## 4. REST khác

| Endpoint | Mô tả |
|---|---|
| `GET /api/health` | kiểm tra sống |
| `GET /api/config` | `mode`, `video_url`, `warn_after` |
| `GET /api/state` | trạng thái mới nhất |
| `POST /api/mode` | body `{"mode": "mock"}` hoặc `{"mode": "live"}` |
| `GET /video/<file>.mp4` | phát video (hỗ trợ Range) |

## 5. Ví dụ phía AI (Python)

```python
import requests
requests.post("http://localhost:8000/api/pose", json={
    "yaw": -34.2, "pitch": 3.1, "roll": -1.4, "confidence": 0.93, "face_detected": True})
```
