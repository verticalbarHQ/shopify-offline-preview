FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates chromium && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@10.34.7 agent-browser@0.31.1
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV AGENT_BROWSER_ARGS="--no-sandbox,--disable-dev-shm-usage"
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build && pnpm benchmarks:fetch
CMD ["sh", "-c", "pnpm browser:playground-check && pnpm exec tsx tools/check-playground-interactions.ts && pnpm browser:inspector-check && pnpm exec tsx tools/check-inspector-interactions.ts"]
