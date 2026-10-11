# Build docker images
docker build -t onnx-python .

# Run docker images
docker run --rm onnx-python
