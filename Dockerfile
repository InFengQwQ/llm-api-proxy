# ============================================================
# Stage 1: build
# ============================================================
FROM node:22-alpine AS build
WORKDIR /app

RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build && npm prune --omit=dev

# ============================================================
# Stage 2: production
# ============================================================
FROM node:22-alpine
ARG PORT
ENV PORT=${PORT}
EXPOSE ${PORT}

RUN addgroup -S app && adduser -S app -G app
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./
RUN chown -R app:app /app && mkdir -p data logs && chown app:app data logs

USER app
CMD ["node", "dist/index.js"]