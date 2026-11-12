# Build context = repo root (so shared/ts is reachable).
# Image mirrors repo layout, so relative imports work the same locally and in the container.
# Node 24 runs .ts directly (type stripping): no build step.
FROM node:24-alpine
WORKDIR /repo
COPY labs/01-scale-zero-to-millions/app/package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund
COPY shared ./shared
COPY labs/01-scale-zero-to-millions/app/src ./labs/01-scale-zero-to-millions/app/src
WORKDIR /repo/labs/01-scale-zero-to-millions/app
ENV NODE_ENV=production
CMD ["node", "src/api.ts"]
