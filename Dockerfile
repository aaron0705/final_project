# syntax=docker/dockerfile:1
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /final_project

COPY requirements.txt .
RUN --mount=type=cache,target=/root/.cache/pip \
    pip3 install --default-timeout=300 --retries=10 -r requirements.txt

COPY . .

ENTRYPOINT ["/bin/bash"]
