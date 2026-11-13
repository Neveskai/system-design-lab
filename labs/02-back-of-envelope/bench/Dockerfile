# Build context = this lab folder. Node 24 runs .ts directly (type stripping).
FROM node:24-alpine
RUN apk add --no-cache openssl
WORKDIR /bench
COPY bench/package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY bench/*.ts ./
CMD ["node", "server.ts"]
