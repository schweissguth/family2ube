FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY server.mjs /app/server.mjs
EXPOSE 8080
CMD ["node","/app/server.mjs"]
