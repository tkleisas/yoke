# syntax=docker/dockerfile:1

# ---- Build stage: compile the Yoke binary (glibc, matches the runtime) ----
# NOTE: the denoland/deno alpine images ship a glibc-linked deno, so a binary
# compiled there does not run on plain alpine/musl. Build and runtime both
# stay on Debian trixie to keep the glibc version in sync.
FROM denoland/deno:debian-2.9.4 AS build
WORKDIR /build
COPY deno.json deno.lock ./
COPY *.ts ./
# Triple-slash type stub referenced by hosts.ts (npm:ssh2 has no bundled types).
COPY types/ ./types/
RUN deno compile --allow-net --allow-env --allow-read --allow-write --allow-run --output yoke main.ts

# ---- Runtime: slim — just the compiled binary ----
FROM debian:trixie-slim AS slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /build/yoke /usr/local/bin/yoke
# The web UI is served from public/ at runtime.
COPY public/ ./public/
ENV PORT=8080 \
    WORKSPACE_DIR=/workspace \
    DATABASE_PATH=/data/yoke.db \
    TLS_CERT_PATH=/data/cert.pem \
    TLS_KEY_PATH=/data/key.pem
RUN mkdir -p /workspace /data
VOLUME ["/workspace", "/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/api/version >/dev/null || exit 1
ENTRYPOINT ["yoke"]

# ---- Runtime: full — build toolchains included ----
# git, build-essential (gcc/make), Node.js, Python, Deno, curl, ssh client:
# enough to build and test most projects inside the container.
FROM debian:trixie-slim AS full
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates git build-essential nodejs npm python3 python3-pip \
      bash curl openssh-client \
 && rm -rf /var/lib/apt/lists/*
# Deno is not packaged in Debian; reuse the toolchain from the build stage.
COPY --from=build /usr/bin/deno /usr/local/bin/deno
WORKDIR /app
COPY --from=build /build/yoke /usr/local/bin/yoke
COPY public/ ./public/
ENV PORT=8080 \
    WORKSPACE_DIR=/workspace \
    DATABASE_PATH=/data/yoke.db \
    TLS_CERT_PATH=/data/cert.pem \
    TLS_KEY_PATH=/data/key.pem
RUN mkdir -p /workspace /data
VOLUME ["/workspace", "/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/api/version >/dev/null || exit 1
ENTRYPOINT ["yoke"]
