# devin-proxy —— Devin Desktop 模型 → OpenAI/Anthropic 反代（bun，零运行时依赖）
FROM oven/bun:1-alpine
WORKDIR /app
COPY package.json tsconfig.json ./
COPY src ./src
ENV PORT=3001 \
    HOST=0.0.0.0 \
    DEVIN_PROXY_CONFIG_DIR=/config
EXPOSE 3001
USER bun
ENTRYPOINT ["bun", "run", "src/index.ts", "serve"]
