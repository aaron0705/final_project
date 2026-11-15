# Webcam: hiển thị, ghi hình và đưa hình ảnh cho AI

## Luồng hoạt động

```
Webcam ──► Trình duyệt (Chrome/Edge trên Windows) ──┬─► hiển thị trên dashboard
                                                    ├─► ⏺ Ghi hình ► file .webm tải về máy (làm dữ liệu huấn luyện)
                                                    └─► WebSocket /ws/camera ► server ► http://localhost:8000/stream.mjpg ► AI
                                                                                   AI ► POST /api/pose ► dashboard (cảnh báo)
```

Trình duyệt giữ webcam. Server chạy trong WSL không cần thấy webcam, nên **không cần cấu hình usbipd**.
Cũng vì trình duyệt giữ webcam, các chương trình khác (OpenCV chạy trực tiếp với `--source 0`, Zoom, Teams, app Camera) không mở được cùng lúc. AI nên đọc hình qua `stream.mjpg`.

## Cách dùng

1. Chạy dashboard, mở <http://localhost:8000> (phải là `localhost` hoặc HTTPS, trình duyệt mới cho dùng webcam).
2. Ở góc phải trên, mục **Hình ảnh** chọn **Webcam**, bấm **Cho phép** khi trình duyệt hỏi quyền camera.
3. Thanh dưới video có: chọn webcam (nếu có nhiều), **⏺ Ghi hình**, và ô **Gửi khung hình cho AI**.
4. Bấm **⏺ Ghi hình** để bắt đầu, **⏹ Dừng và lưu** để kết thúc. File `recording_<ngày>_<giờ>.webm` tự tải vào thư mục Tải xuống.
5. Muốn quay lại video file: chọn **Video file**.

## Dùng video ghi hình làm dữ liệu

File `.webm` mở được trực tiếp bằng OpenCV, nên có thể trích khung hình ngay:
```bash
python ai/yolo/extract_frames.py /mnt/c/Users/Admin/Downloads/recording_20261022_183154.webm --every 0.5 --out ai/yolo/dataset/raw/images
```
Muốn có MP4 H.264 (để phát lại trên dashboard dạng "Video file"):
```bash
ffmpeg -i recording_xxx.webm -c:v libx264 -pix_fmt yuv420p -movflags +faststart data/sample.mp4
```
Lưu ý: file ghi hình có chất lượng gốc của webcam (ví dụ 1280×720), tốt hơn khung hình gửi cho AI ở dưới.

## Cho nhóm AI: lấy khung hình từ webcam

| Cách | Địa chỉ | Ghi chú |
|---|---|---|
| Luồng MJPEG | `http://localhost:8000/stream.mjpg` | `cv2.VideoCapture("http://localhost:8000/stream.mjpg")` |
| Một ảnh JPEG | `http://localhost:8000/api/frame.jpg` | Ảnh mới nhất, 404 nếu chưa bật webcam |
| Kiểm tra | `GET /api/health` | Trường `camera_online` = true khi đang nhận khung hình |

- Khung hình gửi cho AI: **rộng 640 px, khoảng 10 khung/giây, JPEG chất lượng 0,7** (đổi `RELAY_WIDTH`, `RELAY_FPS`, `RELAY_QUALITY` ở đầu phần Webcam trong `frontend/app.js` nếu cần hình lớn hơn).
- **Phải bật webcam trên dashboard trước** rồi mới chạy AI. Nếu luồng bị ngắt, hai script mẫu (`video_pose.py`, `yolo_infer.py`) tự thử nối lại mỗi 2 giây.
- Ví dụ: `python yolo_infer.py --weights weights/best.pt --source http://localhost:8000/stream.mjpg`
- Hình **không bị lật gương**, nên "trái/phải" khớp với quy ước trong `docs/API.md` (theo tài xế).
- AI vẫn gửi kết quả bằng `POST /api/pose` như cũ. Với nguồn webcam không có `video_time`, dashboard không đồng bộ vị trí video.

Khi triển khai lên thiết bị nhúng: camera nối thẳng vào thiết bị, AI đọc bằng `--source 0` (hoặc đường dẫn camera) trên thiết bị và gửi kết quả về dashboard. Phần "trình duyệt giữ webcam" chỉ dùng cho giai đoạn phát triển trên máy tính.

## Xử lý sự cố

| Hiện tượng | Cách xử lý |
|---|---|
| Không hỏi quyền camera / báo "chưa cho phép" | Bấm biểu tượng ổ khoá cạnh địa chỉ → Camera → Cho phép, rồi tải lại trang |
| "Webcam đang được chương trình khác sử dụng" | Tắt Zoom, Teams, app Camera, tab khác đang mở webcam, hoặc AI đang chạy `--source 0` |
| "Trình duyệt không cho dùng webcam" | Mở bằng `http://localhost:8000`. Địa chỉ IP kiểu `http://192.168.x.x:8000` bị chặn vì không phải HTTPS |
| AI không nhận được hình | Kiểm tra `http://localhost:8000/api/health` có `"camera_online": true`; ô "Gửi khung hình cho AI" đã tích; tab dashboard còn mở (đóng tab là hết hình) |
| Hình webcam hiện nhưng NORMAL/FORWARD vẫn chạy theo kịch bản | Nguồn dữ liệu đang là "Giả lập (mock)". Chạy AI để chuyển sang "AI thật" |
