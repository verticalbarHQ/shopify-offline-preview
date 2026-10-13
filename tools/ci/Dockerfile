FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@10.34.7
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build && pnpm benchmarks:fetch
CMD ["sh", "-c", "pnpm generate:check && pnpm typecheck && pnpm lint && pnpm test && pnpm benchmarks:check && pnpm benchmarks:render-check && pnpm oracle:offline-check && pnpm agent:contract-check && pnpm license-guard"]
