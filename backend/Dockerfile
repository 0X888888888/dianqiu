# ─────────────────────────────────────────────────────────────
# Penalty Shootout Vault — Keeper Bot Backend
# Production Dockerfile (Railway / Render / Fly.io / 任意支持 Docker 的平台)
# ─────────────────────────────────────────────────────────────
FROM python:3.11-slim

# 系统依赖（cffi/cryptography/web3 等需要 build-essential）
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential \
      curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先单独 COPY requirements 以利用 Docker 层缓存
COPY requirements.txt .
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -r requirements.txt

# 复制源码
COPY . .

# 暴露端口（Railway/Render 会通过 $PORT 注入；默认 8001）
ENV PORT=8001
EXPOSE 8001

# 健康检查（可选，Railway 会自动探测）
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/api/health" || exit 1

# 启动：用 $PORT（云平台会注入）
CMD ["sh", "-c", "uvicorn server:app --host 0.0.0.0 --port ${PORT:-8001} --workers 1"]
