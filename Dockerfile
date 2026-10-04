# One image for both the API (which also serves the built dashboard) and the worker.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN npm ci --no-audit --no-fund
COPY . .
# `prisma generate` reads prisma.config.ts, which requires DATABASE_URL to be set (it doesn't connect).
ENV DATABASE_URL=postgresql://build:build@localhost:5432/build
RUN npm run build -w apps/api && npm run build -w apps/web

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app /app
WORKDIR /app/apps/api
EXPOSE 3000
CMD ["node", "dist/main.js"]
