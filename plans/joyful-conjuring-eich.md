# Docker-only 重构计划

## Context

LLM API Proxy 当前是"双轨"运行模式：Docker（`build.ps1` + `docker compose`）和主机 Node（`npm run dev`、`node dist/index.js`）。这次清理 `data/gateway.db*` 时，PID 21016 长期持有 NTFS 句柄就是双轨带来的实际问题——容器停了，主机 Node 还在跑，build 脚本对 host 进程完全无感。后续所有坑（`Stop-Process` 杀不死、SHMOPEN、build.ps1 加杀进程、`/tmp` DB hack）都源自双轨。

用户选择 **方案 A：纯 Docker**。目标：项目运行时一律 Docker，host Node 仅用于 `tsc` 类型检查和 `vitest` 测试（这两个不依赖运行时文件系统）。

**禁止 fallback**。所有"以防万一"的双轨代码路径全部清除：build.ps1 的 host-node-kill 步骤删、start 脚本删、`/tmp` DB hack 删。不留回 host Node 的路。

## 关键收益

- **DB 路径回到可控**：`db/index.ts` 的 `/tmp/gateway.db` hack 移除，路径从 config 走；prod 用 named volume（支持 mmap），dev 用容器 writable layer
- **Windows bind mount 坑彻底消失**：源码 bind mount 用 tsx watch 跑没事；DB 走 named volume（overlay2）支持 mmap
- **build.ps1 变薄**：host-node-kill 步骤删除（纯 Docker 没有需要杀的目标）
- **package.json 干净**：去掉 `dev`（host tsx watch）和 `start`（host node）

---

## 架构

### 双容器布局

```
开发期                                生产期
───────────                          ───────────
docker-compose.dev.yml               docker-compose.yml
  ↓ extends                          ↓ standalone
target: dev (Dockerfile)             target: production (Dockerfile)
CMD: tsx watch src/index.ts          CMD: node dist/index.js
./src bind mount → /app/src          无源码挂载（dist/ 在 image 内）
DB 在 /app/data (容器层, 重启丢)     DB 在 named volume (持久化)
logs 在容器 (docker logs -f)         logs 在容器
```

### 流程

```
开发迭代：
  npm run dev                 # = docker compose -f dev.yml up
  ↳ 编辑 src/foo.ts
  ↳ 容器内 tsx watch 拾取变化 → 自动重启 gateway
  ↳ npm run dev:logs          # 跟随容器日志
  ↳ npm run dev:down          # 停容器

生产部署：
  npm run docker              # = build.ps1
  ↳ build.ps1 读 config.yaml port
  ↳ docker compose down
  ↳ docker compose build
  ↳ docker compose up -d
  ↳ health check
```

---

## Implementation Steps

### Step 1: `Dockerfile` — 加 `dev` stage

在 `build` 和 `production` 之间插入 `dev` stage。dev stage 包含 tsx + 全部 devDeps，CMD 是 `tsx watch`：

```dockerfile
# Stage 1: build (existing)
FROM node:22-alpine AS build
... (keep as-is)

# Stage 2: dev (NEW)
FROM node:22-alpine AS dev
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN mkdir -p data logs && chown -R node:node /app
CMD ["npx", "tsx", "watch", "src/index.ts"]

# Stage 3: production (existing)
FROM node:22-alpine AS production
... (keep as-is)
```

dev stage 用 alpine 自带 `node` 用户。

### Step 2: `docker-compose.dev.yml` — 新建

dev compose 文件覆盖 prod compose，挂载源码但 **不** 挂 data/：

```yaml
services:
  llm-api-proxy:
    build:
      context: .
      dockerfile: Dockerfile
      target: dev
    volumes:
      - ./src:/app/src
      - ./config.yaml:/app/config.yaml:ro
    environment:
      - NODE_ENV=development
    # No data/ or logs/ bind mounts — they live in container
```

**关键点**：
- src/ 用 rw 挂载（tsx watch 正常 import，rw 更直观）
- 不挂 data/：dev 期 DB 丢了无所谓，重启即重置
- 不挂 logs/：用 `docker logs -f` 看
- config.yaml 仍然挂进去（dev 配置和 prod 配置通常不同）

### Step 3: `docker-compose.yml` — prod 用 named volume

把 `./data:/app/data` bind mount 改为 named volume（解决 Windows 上 SHMOPEN），`./logs:/app/logs` 直接删除：

```yaml
services:
  llm-api-proxy:
    container_name: llm-api-proxy
    image: llm-api-proxy:latest
    build:
      context: .
      dockerfile: Dockerfile
      args:
        PORT: ${PORT}
    ports:
      - "${PORT}:${PORT}"
    volumes:
      - llm-data:/app/data              # ← 改：named volume
      - ./config.yaml:/app/config.yaml:ro
    restart: unless-stopped
    healthcheck:
      ... (keep)

volumes:                                  # ← 新增
  llm-data:
    driver: local
```

**为什么不挂 ./logs**：body dump 是调试用；权威日志在 SQLite `request_logs` 表，访问 `/admin/logs` 端点或 `docker logs` 即可。生产不需要持久化 body dump。

### Step 4: `src/db/index.ts` — 移除 `/tmp` hack

把 `DB_PATH = '/tmp/gateway.db'` 改为从 config 直接读：

```typescript
// before
const DB_PATH = '/tmp/gateway.db';

export function initDatabase(path: string): Database.Database {
  if (db) return db;
  mkdirSync(dirname(DB_PATH), { recursive: true });
  if (path !== DB_PATH && !existsSync(DB_PATH) && existsSync(path)) {
    try { copyFileSync(path, DB_PATH); ... } catch { ... }
  }
  db = buildDatabase();
  return db;
}

function buildDatabase(): Database.Database {
  const conn = new Database(DB_PATH);
  ...
}

// after
export function initDatabase(path: string): Database.Database {
  if (db) return db;
  mkdirSync(dirname(path), { recursive: true });
  db = buildDatabase(path);
  return db;
}

function buildDatabase(path: string): Database.Database {
  const conn = new Database(path);
  conn.exec('PRAGMA journal_mode=DELETE');
  conn.exec('PRAGMA synchronous=NORMAL');
  conn.exec(CREATE_TABLE_SQL);
  // ... (migrations, indexes, return conn)
}
```

**删除**：
- `import { copyFileSync } from 'fs'`（不再使用）
- 整个迁移 copy 逻辑块（`if (path !== DB_PATH ...)`）
- `DB_PATH` 常量
- 文件顶部的 10 行长注释（讲 tmpfs 故事的）

### Step 5: `package.json` — 移除 host Node 入口

```json
{
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "tsc --noEmit",
    "docker": "powershell -File build.ps1",
    "dev": "docker compose -f docker-compose.yml -f docker-compose.dev.yml up",
    "dev:down": "docker compose -f docker-compose.yml -f docker-compose.dev.yml down",
    "dev:rebuild": "docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build",
    "dev:logs": "docker compose -f docker-compose.yml -f docker-compose.dev.yml logs -f"
  }
}
```

**删除**：`dev: tsx watch src/index.ts`、`start: node dist/index.js`
**保留**：`build`、`test`、`test:watch`、`lint`（不依赖运行时）
**新增**：`dev*` 四个 Docker 脚本

**`tsx` 仍在 `devDependencies`**：image 的 `dev` stage 跑 `npx tsx watch` 需要它。production stage 用 `node dist/index.js`，不依赖 tsx。

### Step 6: `CLAUDE.md` — Docker-only 文档

替换"常用命令"段：

```bash
npm run dev          # Docker 开发（tsx watch + 源码热重载）
npm run dev:down     # 停 dev 容器
npm run dev:logs     # 跟随 dev 容器日志
npm run dev:rebuild  # 重建 dev 镜像（依赖变了才需要）
npm run build        # TS 编译（仅本地类型校验 / CI）
npm test             # 单测（vitest，主机跑）
npm run lint         # 类型检查（tsc --noEmit）
npm run docker       # 生产部署（build.ps1 → docker compose up -d）
```

加警示（替换现有"常用命令"上方的任意 host Node 描述）：

> **运行时一律 Docker**。不要在主机上 `node dist/index.js` 或 `npm run dev`（host tsx watch 已废弃）。

### Step 7: `build.ps1` — 删除 host-node-kill 步骤

Step 2 整个块删除（`Get-CimInstance` + `taskkill` 循环 + 临时的 `ErrorActionPreference` 切换）。纯 Docker 模式下 host 上跑 `node dist/index.js` 不再是合法用法，build.ps1 没有需要杀的目标进程。脚本其余部分保持不变。

### Step 8: 清理

- 删除 `scripts/find_node.ps1`（一次性诊断脚本，build.ps1 里的相同 `Get-CimInstance` 逻辑也已经在 Step 7 删了）
- `tsx` 保留在 `devDependencies`（Step 5 解释过）
- `.gitignore` 仍包含 `dist/`、`node_modules/`（构建产物不入库）

---

## 关键文件变更清单

| 文件 | 操作 |
|------|------|
| `Dockerfile` | **修改** — 加 `dev` stage |
| `docker-compose.yml` | **修改** — `./data` 改 named volume，删 `./logs` 挂载，加 volumes 段 |
| `docker-compose.dev.yml` | **新建** — dev override |
| `src/db/index.ts` | **修改** — 移除 `/tmp` hack 和迁移 copy 逻辑 |
| `package.json` | **修改** — 删 `dev`/`start`，加 `dev*` Docker 脚本 |
| `CLAUDE.md` | **修改** — Docker-only 文档 + 警示 |
| `build.ps1` | **修改** — 删除 host-node-kill 步骤 |
| `scripts/find_node.ps1` | **删除** — 一次性诊断 |

---

## 验证计划

### 1. 镜像构建（两个 target）
```bash
docker compose build                                                    # production
docker compose -f docker-compose.yml -f docker-compose.dev.yml build    # dev
```

### 2. Dev 流程
```bash
npm run dev
# 容器启动 → http://localhost:3000/health 返回 200
# 编辑 src/index.ts 加一行 console.log
# 容器日志显示 tsx "Restarting..." → health 检查仍 OK
npm run dev:logs      # 跟随日志
npm run dev:down      # 干净停掉
```

### 3. Prod 流程
```bash
npm run docker
# 镜像重建 → 容器启动
docker volume ls | grep llm-data        # 验证 named volume 存在
docker exec llm-api-proxy ls /app/data/  # 验证 DB 文件在 volume 里
# 发送请求 → 验证 SQLite 写入
docker restart llm-api-proxy            # 验证 volume 持久化（DB 还在）
```

### 4. 类型 / 单测（host）
```bash
npm run build         # 0 errors
npm test              # 全 pass
npm run lint          # 0 errors
```

### 5. 验证 host Node 入口已删
```bash
npm start             # 删除后 → npm ERR! missing script
npm run dev:ts        # 不存在（host tsx watch 已删）
```

### 6. 跨平台
- Windows 主机 + WSL2 + Docker：named volume 走 overlay2，SHMOPEN 不复发
- Linux 主机 + Docker：直连运行，无问题
