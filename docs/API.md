# Tài liệu API / WebSocket

Base URL mặc định: `http://localhost:8000`

## 1. Nhóm AI → Dashboard (đầu vào)

Chỉ được nhận khi dashboard ở chế độ `live` (script AI tự chuyển, hoặc chọn trên giao diện, hoặc `POST /api/mode`).

### `POST /api/pose` (hoặc WebSocket `/ws/ingest`, mỗi tin nhắn một JSON)

**Mô hình Object Detection (YOLO)**: chỉ cần hướng và độ tin cậy, khung bao nếu có.

```json
{
  "direction": "LEFT",
  "confidence": 0.93,
  "label": "left",
  "bbox": [0.41, 0.30, 0.59, 0.73],
  "face_detected": true,
  "video_time": 12.48
}
```

Không phát hiện được gì: gửi `{"face_detected": false}` (hoặc `"direction": "NO_FACE"`).

**Mô hình Head Pose (MediaPipe, bản cũ)**: gửi thêm góc, `direction` có thể bỏ trống.

```json
{"yaw": -34.2, "pitch": 3.1, "roll": -1.4, "confidence": 0.93, "face_detected": true}
```

| Trường | Kiểu | Bắt buộc | Mô tả |
|---|---|---|---|
| `direction` | string | một trong `direction` hoặc `yaw`+`pitch` | `FORWARD` `LEFT` `RIGHT` `UP` `DOWN` `NO_FACE` (không phân biệt hoa thường). Sai giá trị thì trả 422 |
| `yaw`, `pitch`, `roll` | float (độ) | không | Chỉ khi mô hình có góc. yaw>0 phải, pitch>0 ngẩng lên. Bỏ trống `direction` thì backend tự tính từ yaw/pitch |
| `confidence` | float 0..1 | không (mặc định 1) | < 0,5 thì coi là không chắc chắn |
| `face_detected` | bool | không (mặc định true) | `false` thì hướng = `NO_FACE` |
| `label` | string | không | Tên lớp gốc của mô hình, hiển thị trên khung bao |
| `bbox` | [x1,y1,x2,y2] | không | Chuẩn hoá 0..1 theo kích thước khung hình. Dashboard vẽ lên video |
| `timestamp` | float (epoch s) | không | |
| `video_time` | float (giây) | không | Vị trí khung hình trong file video. Có trường này, dashboard tự kéo video về đúng khung hình AI đang xử lý. Bỏ trống nếu nguồn là camera |

Nếu không có `direction` và cũng không có `yaw`+`pitch`, khung đó được coi là `NO_FACE`.
Phản hồi: `{"accepted": true}`. Gửi khoảng 10–15 khung/giây là đủ.

Quy ước hướng (theo TÀI XẾ): `LEFT` = tài xế quay sang bên trái của chính họ. Camera đặt đối diện nên
bên trái của tài xế nằm bên **phải** khung hình. Nhóm gán nhãn cần thống nhất đúng quy ước này.

## 2. Dashboard → trình duyệt (đầu ra)

### WebSocket `/ws`

Mỗi khi có dữ liệu mới, server đẩy một tin nhắn:

```json
{
  "type": "state",
  "timestamp": 1760544000.123,
  "source": "live",
  "ai_online": true,
  "head_pose": {"direction": "LEFT", "yaw": null, "pitch": null, "roll": null, "confidence": 0.93},
  "detection": {"label": "left", "bbox": [0.41, 0.30, 0.59, 0.73]},
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
| `head_pose.yaw/pitch/roll` | số độ, hoặc `null` nếu mô hình không cho góc |
| `detection.bbox` | khung bao chuẩn hoá, hoặc `null` |
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
| `GET /api/config` | `mode`, `video_url`, `video_path`, `warn_after` |
| `GET /api/state` | trạng thái mới nhất |
| `POST /api/mode` | body `{"mode": "mock"}` hoặc `{"mode": "live"}` |
| `GET /video/<file>.mp4` | phát video (hỗ trợ Range) |
| `GET /stream.mjpg` | luồng MJPEG của webcam bật trên dashboard (AI đọc bằng OpenCV) |
| `GET /api/frame.jpg` | khung hình webcam mới nhất (JPEG), 404 nếu chưa có |
| WebSocket `/ws/camera` | trình duyệt gửi khung hình JPEG nhị phân lên server. Xem `docs/CAMERA.md` |

`GET /api/health` có thêm trường `camera_online` (true khi 3 giây gần nhất có nhận khung hình).

## 5. Ví dụ phía AI (Python)

```python
import requests
requests.post("http://localhost:8000/api/pose", json={
    "direction": "LEFT", "confidence": 0.93, "label": "left", "bbox": [0.41, 0.30, 0.59, 0.73]})
```
