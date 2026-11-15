# Hướng dẫn nhóm AI: Object Detection hướng đầu bằng YOLO

Thư mục `ai/yolo/` có đủ công cụ cho quy trình: **quay video → trích khung hình → gán nhãn → chia dataset → huấn luyện → suy luận → dashboard**.

## 1. Các lớp (class)

| ID | Tên | Ý nghĩa |
|---|---|---|
| 0 | `forward` | Tài xế nhìn thẳng về phía trước |
| 1 | `left` | Tài xế quay sang **bên trái của chính họ** |
| 2 | `right` | Tài xế quay sang **bên phải của chính họ** |
| 3 | `up` | Ngẩng đầu |
| 4 | `down` | Cúi đầu |

- **Khung bao (bbox) vẽ quanh đầu/mặt** tài xế.
- Camera đặt đối diện nên "trái của tài xế" nằm bên phải khung hình. Cả nhóm gán nhãn phải thống nhất đúng quy ước này, nếu không `left`/`right` sẽ bị ngược trên dashboard.
- Khi không thấy mặt (che khuất, ra khỏi khung): **không gán nhãn gì**. Dashboard hiểu là `NO_FACE`.
- Đổi tên hay thêm lớp: sửa `data.yaml`. `yolo_infer.py` nhận ra hướng theo từ khoá trong tên (`forward/front/straight`, `left`, `right`, `up`, `down`), nên `head_left` cũng dùng được. Lớp không có từ khoá (ví dụ `phone`) bị bỏ qua khi tính hướng.

## 2. Quy trình

```bash
cd ai/yolo
python3 -m venv ~/venv-yolo && source ~/venv-yolo/bin/activate
pip install -r requirements.txt        # máy không có GPU: cài torch bản CPU trước cho nhẹ
```

**Bước 1: trích khung hình** (0,5 giây một ảnh là hợp lý, khung liền nhau gần như giống hệt nhau)
```bash
python extract_frames.py ../../data/quay1.mp4 ../../data/quay2.mp4 --every 0.5 --out dataset/raw/images
```

**Bước 2: gán nhãn** bằng công cụ bất kỳ xuất được định dạng **YOLO** (CVAT, Label Studio, Roboflow, LabelImg).
Mỗi ảnh có một file `.txt` cùng tên trong `dataset/raw/labels/`, mỗi dòng `class cx cy w h` (chuẩn hoá 0..1).

**Bước 3: chia train/val**
```bash
python split_dataset.py --images dataset/raw/images --labels dataset/raw/labels --out dataset --include-unlabeled
```
Mặc định chia **theo thời gian trong từng video** (phần cuối video làm tập val). `--include-unlabeled` giữ ảnh không có nhãn làm ảnh nền, giúp mô hình biết "không có mặt thì không báo gì".

**Bước 4: huấn luyện**
```bash
python train.py --model yolov8n.pt --epochs 80 --imgsz 640 --device 0     # có GPU
python train.py --model yolov8n.pt --epochs 80 --imgsz 640 --device cpu   # không GPU (chậm)
```
Kết quả: `weights/best.pt` và bảng mAP theo từng lớp.

**Bước 5: chạy với dashboard**
```bash
# terminal 1: dashboard (cd backend && uvicorn main:app --port 8000)
python yolo_infer.py --weights weights/best.pt --source ../../data/sample.mp4 --loop
```
Webcam: `--source 0`. Có hành khách trong khung: `--roi 0.5,0,1,1` chỉ lấy khung có tâm nằm trong vùng tài xế.

## 3. Những lỗi dễ mắc (đã được xử lý hoặc cần chú ý)

1. **Không lật ngang ảnh khi tăng cường dữ liệu.** Lật ngang biến `left` thành `right` mà nhãn không đổi. `train.py` đã tắt `fliplr`, đừng bật lại.
2. **Không chia ngẫu nhiên các khung liền nhau** vào cả train và val: mAP sẽ cao giả tạo. `split_dataset.py` chia theo video/thời gian.
3. **Cân bằng số lượng giữa các lớp.** `forward` thường nhiều hơn hẳn các lớp còn lại. Nên quay thêm các đoạn `up/down/left/right` cho đủ.
4. **Đa dạng người, ánh sáng, kính, mũ, vị trí ngồi.** Nếu mô hình chỉ thấy một người, nó học thuộc người đó. Nên có ít nhất vài người khác nhau, và **tập val nên là người chưa xuất hiện trong tập train**.
5. **Cùng camera, cùng góc lắp** giữa lúc thu dữ liệu và lúc chạy thật.

Số lượng gợi ý để bắt đầu: vài trăm ảnh mỗi lớp, ít nhất 3–5 người khác nhau. Ít hơn vẫn chạy được nhưng kém ổn định.

## 4. Đánh giá cho báo cáo (Giai đoạn 8)

- mAP50, precision/recall theo từng lớp (do `train.py` in ra) và ma trận nhầm lẫn (`python train.py --plots`).
- Với bài toán cảnh báo, ngoài mAP cần **số cảnh báo đúng/sai trên video thật**: liếc dưới 2 giây không được báo, quay trên 2 giây phải báo, và độ trễ từ lúc quay đến lúc cảnh báo.
- Tốc độ: `yolo_infer.py` in thời gian suy luận trung bình mỗi khung (ms). Trên thiết bị nhúng cần đo lại ở Giai đoạn 5.

## 5. Chuyển sang thiết bị nhúng (gợi ý cho Giai đoạn 5)

- Dùng mô hình nhỏ: `yolov8n` (hoặc bản nano của phiên bản mới hơn), giảm `--imgsz` xuống 320–416 nếu chậm.
- Xuất mô hình: `yolo export model=weights/best.pt format=onnx` (hoặc `tflite`, `engine` cho TensorRT trên Jetson), tuỳ thiết bị.
- Dashboard không đổi: mô hình trên thiết bị chỉ cần gửi JSON như ở `docs/API.md` tới `POST /api/pose`.

## 6. Thử nhanh chuỗi công cụ khi chưa có dữ liệu thật

```bash
python make_demo_dataset.py --per-class 60 --video ../../data/demo_synth.mp4
python train.py --model yolov8n.pt --epochs 12 --imgsz 320 --device cpu --workers 0
python yolo_infer.py --weights weights/best.pt --source ../../data/demo_synth.mp4 --imgsz 320 --loop
```
Dữ liệu này là hình vẽ tổng hợp, chỉ để kiểm tra quy trình chạy thông. **Không dùng để đánh giá độ chính xác.**
Nhớ xoá thư mục `dataset/` tổng hợp trước khi làm dataset thật.
