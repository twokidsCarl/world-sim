# 一个镜像，三个目标：hub、play、worker。同一份 idea-loom 代码，按角色带不同的工具。
# One image with three targets: hub, play, worker. The same idea-loom code, with a
# different set of tools for each role.
#
# 从仓库根目录构建 / Build from the repository root:
#   docker build -f deploy/Dockerfile --target hub -t world-sim-hub .

FROM python:3.13-slim AS base
ENV PYTHONUNBUFFERED=1 UV_LINK_MODE=copy UV_COMPILE_BYTECODE=1
RUN apt-get update && apt-get install -y --no-install-recommends git curl ca-certificates unzip \
    && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/
# 不用 root 跑任何东西。 / Nothing runs as root.
RUN useradd --create-home --uid 10001 loom
WORKDIR /app/idea-loom
COPY idea-loom/pyproject.toml idea-loom/uv.lock idea-loom/README.md ./
COPY idea-loom/src ./src
RUN uv sync --frozen --no-dev && chown -R loom:loom /app
ENV PATH="/app/idea-loom/.venv/bin:${PATH}" \
    IDEA_LOOM_REPO=/srv/repo \
    IDEA_LOOM_DATA=/srv/state/data \
    IDEA_LOOM_RUNS=/srv/state/runs

# ---- 构建 idea-loom 自己的界面 / build idea-loom's own UI ----
FROM oven/bun:1 AS ui
WORKDIR /ui
COPY idea-loom/web/package.json idea-loom/web/bun.lock ./
RUN bun install --frozen-lockfile
COPY idea-loom/web ./
RUN bunx vite build

# ---- hub：界面、接口、登录。不构建、不运行项目代码、不改代码。 ----
# ---- hub: UI, API, sign-in. It builds nothing, runs no project code and changes no code. ----
FROM base AS hub
COPY --from=ui --chown=loom:loom /ui/dist /app/idea-loom/web/dist
ENV IDEA_LOOM_ROLE=hub
USER loom
EXPOSE 8767
CMD ["uvicorn", "idea_loom.server:app", "--host", "0.0.0.0", "--port", "8767", "--proxy-headers", "--forwarded-allow-ips", "*"]

# ---- play：取 main 的快照、构建、运行各模拟的后端。没有任何密钥。 ----
# ---- play: snapshots main, builds, and runs the simulations' backends. It holds no secrets. ----
FROM base AS play
COPY --from=oven/bun:1 /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx
ENV IDEA_LOOM_ROLE=play
USER loom
EXPOSE 8768
CMD ["uvicorn", "idea_loom.server:app", "--host", "0.0.0.0", "--port", "8768", "--proxy-headers", "--forwarded-allow-ips", "*"]

# ---- worker：改代码的作业和定时维护。持有订阅令牌和仓库的推送凭证，不接受外来请求。 ----
# ---- worker: code-changing jobs and scheduled maintenance. It holds the subscription token
# ---- and the repository's push credential, and accepts no inbound requests.
FROM base AS worker
COPY --from=oven/bun:1 /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs gh \
    && npm install -g @anthropic-ai/claude-code \
    && rm -rf /var/lib/apt/lists/*
ENV IDEA_LOOM_ROLE=worker
USER loom
CMD ["idea-loom", "worker"]
