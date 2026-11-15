# Dashboard giám sát trạng thái tài xế

Phần giao diện (Dashboard) của đề án *Hệ thống giám sát và cảnh báo trạng thái người lái xe bằng AI trên hệ thống nhúng*.

Dashboard phát video từ camera/MP4, hiển thị **Direction / Yaw / Pitch / Roll**, **Driver Status** (`NORMAL` / `WARNING`) và cảnh báo thời gian thực qua WebSocket.

```
dashboard/
├── backend/        FastAPI + WebSocket + logic cảnh báo (alert.py) + giả lập (simulator.py)
├── frontend/       index.html, style.css, app.js
├── ai/yolo/        AI Object Detection YOLO (train.py, yolo_infer.py, công cụ dataset)
├── ai/             AI MediaPipe cũ (pose.py, video_pose.py, Dockerfile)
├── data/           đặt sample.mp4 vào đây
├── samples/        JSON mẫu cho các thành viên khác
├── tools/fake_ai.py  giả lập nhóm AI gửi dữ liệu vào dashboard
├── docs/API.md     tài liệu API / WebSocket
├── Dockerfile, docker-compose.yml
```

## Chạy trên máy (không Docker)

```bash
cd backend
python -m venv .venv
# Windows: .venv\Scripts\activate      Linux/macOS: source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

Mở <http://localhost:8000>. Đặt video vào `data/sample.mp4` (nếu chưa có, trang sẽ báo thiếu video nhưng phần còn lại vẫn chạy).

## Chạy bằng Docker (D7)

```bash
# đặt data/sample.mp4 trước
docker compose up --build
```

Mở <http://localhost:8000>. Chạy chế độ AI thật: `DATA_SOURCE=live docker compose up`.

## Chạy trên WSL (Windows)

Nên đặt dự án trong ổ Linux (`~/dashboard`) thay vì `/mnt/c/...` cho nhanh và ổn định.

```bash
sudo apt update && sudo apt install -y python3 python3-venv python3-pip ffmpeg
cd ~/dashboard/backend && python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```
Mở <http://localhost:8000> bằng trình duyệt trên Windows. Video phải là MP4 H.264; nếu không, chuyển bằng:
`ffmpeg -i video_goc.mp4 -c:v libx264 -pix_fmt yuv420p -c:a aac -movflags +faststart data/sample.mp4`

## Webcam thật và ghi hình

Trên dashboard, mục **Hình ảnh → Webcam** bật webcam (qua trình duyệt, nên chạy được cả khi server ở WSL),
có nút **⏺ Ghi hình** lưu file `.webm` để làm dữ liệu huấn luyện, và tự chuyển tiếp hình cho AI tại
`http://localhost:8000/stream.mjpg`. Chi tiết và cách xử lý sự cố: [`docs/CAMERA.md`](docs/CAMERA.md).

```bash
# AI đọc hình từ webcam đang bật trên dashboard
python yolo_infer.py --weights weights/best.pt --source http://localhost:8000/stream.mjpg
```

## AI Object Detection bằng YOLO (hướng chính của nhóm)

Mô hình phát hiện đầu tài xế và phân loại theo lớp `forward / left / right / up / down`; dashboard
vẽ khung bao lên video và áp dụng logic cảnh báo 2 giây. Mô hình này không cho góc nên Yaw/Pitch/Roll hiện "—".
Hướng dẫn đầy đủ (gán nhãn, chia dataset, train, đánh giá, thiết bị nhúng): [`docs/AI_YOLO.md`](docs/AI_YOLO.md).

```bash
cd ai/yolo
python3 -m venv ~/venv-yolo && source ~/venv-yolo/bin/activate
pip install -r requirements.txt
python train.py --model yolov8n.pt --epochs 80 --device cpu      # sau khi đã có dataset/ (xem docs/AI_YOLO.md)
python yolo_infer.py --weights weights/best.pt --source ../../data/sample.mp4 --loop
```
Docker: đặt `ai/yolo/weights/best.pt` rồi `docker compose --profile ai up --build`.

## Bản cũ: ước lượng góc đầu bằng MediaPipe (D6)

AI nằm trong thư mục `ai/` (MediaPipe Face Landmarker + OpenCV solvePnP). Nó đọc video,
tính Yaw/Pitch/Roll rồi gửi vào dashboard; dashboard tự chuyển sang chế độ "live" và đồng bộ video.

```bash
# terminal 1: dashboard (như trên)
# terminal 2:
cd ai
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python video_pose.py --source ../data/sample.mp4 --loop        # video file
python video_pose.py --source 0                                # hoặc webcam
```
Lần chạy đầu cần Internet để tải model (~4 MB) vào `ai/models/`.

**Hiệu chỉnh gốc:** góc đo được so với trục camera, nên nếu camera đặt lệch thì "nhìn thẳng" không bằng 0.
Mặc định AI lấy `--calibrate 3` giây đầu làm "nhìn thẳng" (trong 3 giây này dashboard hiện 0). Khi xong nó in ra
`--yaw-offset ... --pitch-offset ...` để bạn dùng lại cố định. Tắt bằng `--calibrate 0`.

Các tuỳ chọn: `--flip-yaw` (đảo trái/phải nếu camera đặt khác hoặc bị lật gương),
`--smooth 0.5` (làm mượt; 1 = tắt), `--max-hz 15`, `--url http://...`.
Test phần toán: `cd ai && pytest -q`.

**Docker (dashboard + AI MediaPipe):**
```bash
docker compose --profile mediapipe up --build
```

## Kiểm tra theo mốc

| Mốc | Cách kiểm tra |
|---|---|
| D1 | Mở trang, video phát bình thường |
| D2 | Mở DevTools → Console thấy `WebSocket connected`, góc phải trên báo "Đã kết nối" |
| D3 | Direction/Yaw/Pitch/Roll và radar thay đổi theo JSON (giả lập mặc định) |
| D4 | `NORMAL` ⇄ `WARNING` đổi đúng theo kịch bản |
| D5 | Quay lệch > 2 s thì banner đỏ + âm cảnh báo; nhìn thẳng > 0,5 s thì tắt. Đổi ngưỡng bằng biến `WARN_AFTER` |
| D6 | Chạy `ai/video_pose.py` (xem mục AI thật): dashboard nhận kết quả AI thật, nguồn hiển thị "AI thật". Có thể thử riêng bằng `python tools/fake_ai.py` |
| D7 | `docker compose up --build` chạy được theo README này |

Chạy test logic cảnh báo: `cd backend && pytest -q`

## Cấu hình (biến môi trường)

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `DATA_SOURCE` | `mock` | `mock` = dữ liệu giả lập, `live` = nhận từ AI |
| `WARN_AFTER` | `2.0` | số giây lệch hướng liên tục trước khi cảnh báo |
| `LIVE_TIMEOUT` | `2.0` | quá số giây này không có dữ liệu AI thì hiện NO SIGNAL |
| `VIDEO_DIR` / `VIDEO_FILE` | `data` / `sample.mp4` | vị trí và tên file video |

## Quy ước cần thống nhất với nhóm AI

- `yaw > 0` = quay phải, `yaw < 0` = quay trái; `pitch > 0` = ngẩng lên, `pitch < 0` = cúi xuống. Nếu thư viện AI dùng chiều ngược lại, hãy đổi dấu ở phía AI, hoặc sửa `classify_direction` trong `backend/alert.py`.
- Ngưỡng hướng mặc định: |yaw| > 20° hoặc |pitch| > 15° coi là lệch hướng.
