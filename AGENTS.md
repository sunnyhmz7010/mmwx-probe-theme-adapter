# MMWX Probe Theme Adapter 项目 AGENTS.md

## 项目说明

将 MMWX independent-probe 数据适配为 Komari 或 Monitor 公开只读 API，并在运行时根据主题清单加载指定主题，对外提供可直接访问的主题页面。MMWX 始终是唯一数据源。

## 技术栈

- Node.js 22+（ESM）
- TypeScript
- ws：WebSocket 兼容层
- Docker（`node:22-bookworm-slim` 多阶段构建）
- 运行镜像内置 Bun，并通过 Corepack 启用 pnpm，用于构建声明 `packageManager: pnpm@...` 或使用 `catalog:` 依赖的主题
- 无数据库，运行数据固定写入容器内部运行目录，不通过 Compose 映射到宿主机

## 本地命令

```bash
npm install                 # 安装依赖
npm run build               # 编译 TypeScript
npm test                    # 编译并运行全部 node:test 测试
docker build -t mmwx-probe-theme-adapter .  # 构建本地镜像
```

## 发布惯例

- 版本号遵循 semver（`major.minor.patch`）
- 发版步骤：同步 `package.json` 与 `package-lock.json` 版本 → `npm test` → 提交并推送 `main` → 创建并推送 `vX.Y.Z` 标签 → `gh release create --verify-tag` 写中英双语发布说明
- 镜像自动构建并推送到 `ghcr.io/sunnyhmz7010/mmwx-probe-theme-adapter`
- Docker workflow 只在 `v*` 标签推送时发布镜像，生成 semver、major/minor、major 和 `latest` 标签；`main` 分支推送不发布镜像
- 发布历史维护在 GitHub Releases，不提交 `CHANGELOG.md`
- 首次发布 GHCR 镜像后，若公开拉取失败，在 GitHub Package settings 中确认容器包可见性为 Public，并确保仓库 Actions 对该 package 有写权限

## 项目约定

- 环境变量命名统一大写蛇形（`MMWX_ORIGIN`、`PROBE_TOKEN`、`THEME_REPO`）
- 配置解析集中在 `src/config.ts`，校验失败抛出 `ConfigError`
- `PROBE_TOKEN` 只能用于 MMWX 上游请求和日志脱敏，不得暴露给主题构建、静态资源或 API 响应
- 生产环境 `MMWX_ORIGIN` 必须使用 HTTPS；仅 localhost 和 127.0.0.1 允许 HTTP
- Komari 兼容层默认只读，拒绝完整后台管理和节点修改类接口；仅允许通过 `/admin` 使用正确 `ADMIN_TOKEN` 验证后签发管理员会话 Cookie，再写入本项目自己的主题配置文件（位于容器内部运行目录）
- 管理员验证接口为 `POST /api/admin/auth/verify`，退出登录接口为 `POST /api/admin/auth/logout`；错误 Token 即使伴随已有会话也不得通过验证
- `/api/me`、HTTP RPC2 和 WebSocket RPC 会向已建立管理员会话的浏览器返回已登录状态，用于兼容 Lumina、LuminaPlus、Junimo 等通过 `/?view=theme-manage` 提供配置页的主题
- `/admin` 与 `/admin/` 展示适配器设置页；`/admin/dashboard` 与 `/admin/dashboard/` 重定向到 `/admin`；其他 `/admin/*` 子路径仍返回 404
- 主题构建产物必须经过路径包含性、符号链接逃逸和 `index.html` 校验后再发布到运行目录；构建命令失败时仅采用本次新生成的产物，拒绝误用构建前残留的旧产物
- 主题构建按 `packageManager` 字段和锁文件选择包管理器；Naive 主题依赖 pnpm/catalog，运行镜像必须保持 `corepack enable pnpm`
- 新增接口兼容能力时，必须同步补测试和 README 的兼容边界说明
- 数据映射约定：地区字段优先取 `region_country`（ISO 代码）；续费货币把 ISO 代码转为 Komari 官方 12 种货币符号（`CNY`→`¥`、`USD`→`$`、`CAD`→`CA$` 等）；`ping.loss` 指标输出 0~1 比例；上游缺失字段按「省略 > `unknown` > 0」兜底，改动映射时同步补测试

## 架构分层

```
src/main.ts          ← 入口：加载配置、构建主题、组装服务、生命周期处理
src/config.ts        ← 环境变量解析与安全校验
src/log.ts           ← 结构化日志与脱敏
src/mmwx/client.ts   ← MMWX independent-probe HTTP/WebSocket 客户端
src/mmwx/stream-relay.ts ← 常驻采样与主控降载：常驻单条上游 WS、断线重连与帧龄看门狗、快照帧复用与广播
src/mmwx/types.ts    ← MMWX 探针数据类型
src/komari/mapper.ts ← MMWX 数据到 Komari 形态的映射
src/komari/service.ts← 查询和历史数据服务
src/komari/types.ts  ← Komari 兼容层数据类型
src/monitor/mapper.ts ← MMWX 到 Monitor 公开节点快照的映射
src/monitor/service.ts ← Monitor 历史查询、节点身份与下标缓存隔离
src/mmwx/identity.ts ← 节点身份识别，供 Monitor ID 和历史缓冲共用
src/http/api.ts      ← Komari 兼容 API 与 RPC2 路由
src/http/server.ts   ← HTTP server 与 WebSocket 路由
src/http/static.ts   ← 静态主题资源、SPA fallback 与内置资源兜底
src/theme/loader.ts  ← 主题仓库克隆、构建、校验和发布
src/theme/builder.ts ← 主题依赖安装与构建计划、产物校验
src/theme/repository.ts ← 主题仓库地址校验与克隆
src/theme/settings-store.ts ← 主题配置 JSON 文件读写与校验
src/theme/types.ts   ← 主题加载与构建类型
static-assets/       ← 内置国旗与 OS 图标资源（来源 junimo，Apache-2.0），随镜像打包
```

## 环境变量完整列表

| 变量 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `MMWX_ORIGIN` | 是 | - | MMWX 控制端地址 |
| `PROBE_TOKEN` | 是 | - | MMWX independent-probe Token |
| `THEME_REPO` | 是 | - | Komari 或 Monitor 主题 GitHub HTTPS 仓库地址，按清单自动识别 |
| `THEME_REF` | 否 | `main` | 主题分支、标签或 commit |
| `THEME_GIT_PROXY` | 否 | 空（直连） | GitHub 克隆代理前缀，如 `https://gh-proxy.com`，克隆地址拼为 `<代理>/https://github.com/owner/repo.git` |
| `ADMIN_TOKEN` | 否 | - | `/admin` 管理员验证 Token；未设置时禁用验证和主题配置写入 |

> HTTP 监听端口固定为 `8080`（`src/config.ts` 中常量 `HTTP_PORT`），不读取 `PORT` 环境变量；对外端口通过容器端口映射调整。
