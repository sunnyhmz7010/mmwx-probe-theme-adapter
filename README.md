<div align="center">
  <h1>MMWX Probe Theme Adapter</h1>
  <p>将妙妙屋 X 探针数据接入 Komari 和极简探针主题</p>
</div>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-22-5FA04E?style=flat-square&amp;logo=nodedotjs&amp;logoColor=white" alt="Node.js 22" />
  <img src="https://img.shields.io/badge/TypeScript-5-3178C6?style=flat-square&amp;logo=typescript&amp;logoColor=white" alt="TypeScript 5" />
  <img src="https://img.shields.io/badge/Docker-2496ED?style=flat-square&amp;logo=docker&amp;logoColor=white" alt="Docker" />
</p>

<p align="center">
  <a href="https://github.com/sunnyhmz7010/mmwx-probe-theme-adapter/releases"><img src="https://img.shields.io/github/v/release/sunnyhmz7010/mmwx-probe-theme-adapter?label=Release&amp;color=3b82f6" alt="Release" /></a>
  <a href="https://github.com/sunnyhmz7010/mmwx-probe-theme-adapter/blob/main/LICENSE"><img src="https://img.shields.io/github/license/sunnyhmz7010/mmwx-probe-theme-adapter?color=10b981" alt="License" /></a>
</p>

---

## ✨ 为什么做这个项目

已经使用妙妙屋 X 管理服务器，希望复用 Komari 或极简探针的主题时，需要转换两种生态的接口与数据格式。本项目将主题页面、只读兼容 API 和实时数据流放在同一个服务中，直接使用现有主控数据。

- 在 VPS 或 NAS 上通过 Docker 部署公开探针页面。
- 保留妙妙屋 X 的节点与监控数据，按需切换第三方主题。

## 🚀 核心能力

- 双协议兼容：为 Komari 和极简探针主题提供节点、状态、历史图表及实时推送接口。
- 运行时主题加载：从指定 GitHub 仓库拉取主题，自动识别静态页面或前端构建项目。
- 主题配置：通过 `/admin` 保存主题设置，也兼容部分主题自带的前端配置页。
- 实时与历史数据：转发妙妙屋 X 探针数据，持续采样并为兼容接口提供最近 24 小时历史。
- 主控降载：每个实例共享一条上游 WebSocket 连接，并复用近期快照供多个访客访问。
- 固定代理范围：仅代理已配置主控的探针接口，`PROBE_TOKEN` 留在服务端。

## ⚡ 快速开始

### 📋 前置要求

- 妙妙屋 X 主控：已启用独立探针访问，并在“系统设置 → 探针”生成访问密钥。
- 主控地址：容器可访问的 HTTPS 地址。
- 容器环境：已安装 Docker；使用 Compose 方式时还需 Docker Compose。
- 主题仓库：一个可信、可公开拉取的 Komari 或极简探针 GitHub 主题仓库。

### 📦 安装与运行

#### 🐳 Docker 部署

```bash
docker run -d \
  --name mmwx-probe-theme-adapter \
  --restart unless-stopped \
  -p 8080:8080 \
  -e MMWX_ORIGIN="https://panel.example.com" \
  -e PROBE_TOKEN="replace-with-probe-token" \
  -e THEME_REPO="https://github.com/example/komari-theme" \
  -e THEME_REF="main" \
  -e THEME_GIT_PROXY="" \
  -e ADMIN_TOKEN="replace-with-random-admin-token" \
  ghcr.io/sunnyhmz7010/mmwx-probe-theme-adapter:latest
```

也可以使用 Docker Compose：根目录已提供 `compose.yaml`，执行以下命令即可启动：

```bash
docker compose up -d
```

执行前，将 `https://panel.example.com` 换为主控地址，`replace-with-probe-token` 换为探针访问密钥，`https://github.com/example/komari-theme` 换为主题仓库地址，`replace-with-random-admin-token` 换为自行生成的随机管理密钥。`THEME_REF` 按主题仓库的实际分支、标签或提交填写。

使用 Compose 时，先下载根目录的 [compose.yaml](./compose.yaml)，按相同规则修改其中的 `environment`，再执行启动命令。首次启动会拉取并构建主题，完成后访问 [http://localhost:8080](http://localhost:8080)。远程部署时将 `localhost` 替换为服务器地址。

容器内端口固定为 `8080`，修改对外端口时只调整映射左侧。默认不挂载数据卷，删除或重建容器会丢失主题配置和本地历史缓冲。

## 📖 使用说明

### 📋 环境变量

| 变量 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `MMWX_ORIGIN` | 是 | — | 妙妙屋 X 主控地址；生产环境使用 HTTPS，仅 `localhost` 和 `127.0.0.1` 允许 HTTP。 |
| `PROBE_TOKEN` | 是 | — | 独立探针访问密钥，以 `X-MMwx-Probe-Token` 请求头发送给主控。 |
| `THEME_REPO` | 是 | — | 公开的 GitHub HTTPS 主题仓库地址，不能填写分支页面或压缩包地址。 |
| `THEME_REF` | 否 | `main` | 主题分支、标签或提交；建议固定到标签或提交，避免主题更新影响兼容性。 |
| `THEME_GIT_PROXY` | 否 | 空，直连 | GitHub 克隆代理前缀，最终地址形如 `<代理>/https://github.com/owner/repo.git`；生产环境须用 HTTPS，不支持凭据、查询参数或片段。 |
| `ADMIN_TOKEN` | 否 | — | `/admin` 管理密钥；未设置时禁用管理员验证和主题配置写入。 |

### 🎨 配置与切换主题

1. 部署时设置 `ADMIN_TOKEN`，打开 [http://localhost:8080/admin](http://localhost:8080/admin)，输入密钥并点击“验证”。
2. 托管配置主题可直接修改表单，点击“保存主题配置”。
3. Lumina、LuminaPlus、Junimo 等使用前端配置页的主题，在验证成功后按页面提示进入 `/?view=theme-manage`。
4. 完成后点击“退出登录”清除当前浏览器的管理会话。

没有声明配置项、也没有前端配置页的主题，会显示“当前主题未声明可配置项”。每个实例只加载一个主题；修改 `THEME_REPO` 和 `THEME_REF` 后重新创建容器即可切换。

### 🧪 主题兼容记录

以下保留项目已有的实测记录，主题后续更新可能影响兼容性。选择主题时同时核对仓库分支与配置支持情况。

Komari 主题：

| 主题仓库 | 分支 | 页面显示 | 数据兼容性 | 主题配置 |
| --- | --- | --- | --- | --- |
| [sanrokamlan-prog/komari-theme-Glassmorphism](https://github.com/sanrokamlan-prog/komari-theme-Glassmorphism) | `main` | 正常 | 兼容 | 兼容 |
| [Tokinx/komari-theme-emerald](https://github.com/Tokinx/komari-theme-emerald) | `master` | 正常 | 兼容 | 兼容 |
| [stqfdyr/komari-theme-adhesive-note](https://github.com/stqfdyr/komari-theme-adhesive-note) | `main` | 正常 | 兼容 | 主题无配置项 |
| [vaspike/junimo](https://github.com/vaspike/junimo) | `main` | 正常 | 兼容 | 兼容 |
| [stqfdyr/komari-theme-Lumina](https://github.com/stqfdyr/komari-theme-Lumina) | `main` | 正常 | 兼容 | 兼容 |
| [shanyang242/Komari-Theme-LuminaPlus](https://github.com/shanyang242/Komari-Theme-LuminaPlus) | `main` | 正常 | 兼容 | 兼容 |
| [lyimoexiao/komari-theme-naive](https://github.com/lyimoexiao/komari-theme-naive) | `master` | 安装依赖占用较多资源 | 兼容 | 兼容 |
| [tonyliuzj/komari-next](https://github.com/tonyliuzj/komari-next) | `main` | 正常 | 兼容 | 兼容 |
| [TonyStarkJr2021/komari-theme-Gloria-Universe](https://github.com/TonyStarkJr2021/komari-theme-Gloria-Universe) | `main` | 正常 | 兼容 | 兼容 |
| [123nhh/Komari-Home-Plus](https://github.com/123nhh/Komari-Home-Plus) | `main` | 正常 | 兼容 | 兼容 |
| [mogumc/Komari-Home](https://github.com/mogumc/Komari-Home) | `main` | 正常 | 兼容 | 兼容 |
| [imengying/Komari-Glass](https://github.com/imengying/Komari-Glass) | `main` | 正常 | 兼容 | 兼容 |
| [jacob-bytes/komari-theme-ink](https://github.com/jacob-bytes/komari-theme-ink) | `main` | 正常 | 兼容 | 兼容 |
| [cazi-cc/komari-theme-emerald](https://github.com/cazi-cc/komari-theme-emerald) | `master` | 正常 | 仅基础信息 | 未兼容 |
| [VoyagerProbe/Glassmorphism-Plus](https://github.com/VoyagerProbe/Glassmorphism-Plus) | `master` | 正常 | 兼容 | 兼容 |
| [r11234567/komari-theme-adhesive-note](https://github.com/r11234567/komari-theme-adhesive-note) | `main` | 正常 | 不兼容 | 主题无配置项 |
| [qwer-xyz/komari-theme-zen](https://github.com/qwer-xyz/komari-theme-zen) | `main` | 正常 | 兼容 | 兼容 |
| [nuomiiiii/nezha](https://github.com/nuomiiiii/nezha) | `main` | 正常 | 兼容 | 兼容 |

极简探针主题：

| 主题仓库 | 分支 | 页面显示 | 数据兼容性 | 主题配置 |
| --- | --- | --- | --- | --- |
| [dongbo501/minimalist-probe-doraemon-theme](https://github.com/dongbo501/minimalist-probe-doraemon-theme) | `main` | 正常 | 兼容 | 兼容 |
| [dongbo501/gloria-universe-monitor-theme](https://github.com/dongbo501/gloria-universe-monitor-theme) | `main` | 正常 | 兼容 | 兼容 |

## 🧠 功能细节

### 🔌 接口兼容

| 接口 | 用途 |
| --- | --- |
| `/api/probe` | 获取主控 `/api/public/probe-servers` 探针快照，保留上游提供的计费周期、每日流量、续费与回程路由信息。 |
| `/api/series` | 转发主控 `/api/public/probe-series` 历史查询；`metric=system` 查询系统指标。 |
| `/api/stream` | 通过共享连接转发主控 `/api/public/probe-ws` 实时数据。 |
| Komari 兼容接口 | `/api/public`、`/api/nodes`、`/api/me`、`/api/records/ping`、`/api/records/load`、HTTP/WebSocket `/api/rpc2` 及 WebSocket `/api/clients`。 |
| 极简探针兼容接口 | `/api/me`、`/api/nodes`、WebSocket `/api/ws`、`/api/nodes/{id}/metrics` 及 `/api/themes/{short}/config`。 |

`/api/nodes` 和 `/api/me` 的响应格式随主题协议切换。RPC2 仅支持适配器实现的公开查询与主题配置会话相关方法，不提供完整的 Komari 或极简探针后台。

### 📊 数据口径与限制

- 历史范围：兼容接口最多返回最近 24 小时实际数据；主题中的 7 天或 90 天选项不会增加覆盖范围。极简探针的 `points` 限制为 60–1440，超出时抽取真实样本，不插值补点。
- 丢包率：Komari 的 `ping.loss` 使用 0–1 比例，极简探针使用百分比；极简探针窗口汇总是可用样本平均值，不等同于原生后端按探测次数加权的统计。
- 流量：Komari 节点的 `totalUp/totalDown` 优先表示主控调整后的计费周期用量，缺失时回退开机累计值。`public:queryMetrics` 的 `traffic.up/traffic.down` 为桶内增量，`net.total.up/net.total.down` 为开机累计值。极简探针的 `month_rx/month_tx` 表示当前计费周期，可能不是自然月；`total_rx/total_tx` 是上游累计计数，可能在重启后重置。
- 缺失指标：通常省略或显示 `unknown`。极简探针为满足主题数字校验，仅在上游缺失时将 `metrics.swap_used`、`metrics.swap_total`、`metrics.procs` 置为 `0`，这些占位值不代表测量结果；离线节点的 `metrics` 为 `null`。
- 节点身份：极简探针 ID 依次基于主控 `id`、`host`、`name` 生成，均缺失时使用列表位置；无 ID 节点改名可能改变身份，重复身份会报错，隐藏节点不进入该协议的列表与历史接口。
- 连接数：TCP/UDP 连接数字段直接映射主控统计，缺失时省略；数据口径是整机连接数。

### 🛰️ 实时采样与历史缓冲

- 常驻采样：服务启动即连接主控，不依赖访客在线；断线自动重连，快照过期时由看门狗发起 HTTP 采样。
- 快照复用：`/api/probe` 优先返回 12 秒内的最近快照；`/api/series` 向主控查询历史。
- 历史缓冲：保留最近 1 小时逐帧数据，更早数据按分钟降采样，总计覆盖 25 小时；每 5 分钟写入 `/data/history-buffer.json`，启动时恢复，缓冲缺失时用主控聚合序列填补历史窗口。
- 主控恢复：运行期间主控不可达会记录警告并持续重试，主题静态页面仍可访问；主控恢复后继续采样。

### 🧩 主题加载与配置存储

- 协议识别：优先读取 `komari-theme.json`，其次识别含 `short` 标识与 `config` 数组的极简探针 `theme.json`；无清单时使用 Komari 模式。
- 主题构建：优先按 `packageManager` 选择包管理器，否则按 pnpm、Bun、npm 锁文件顺序识别；没有构建脚本时可使用根目录静态 `index.html`。镜像内置主题构建所需的 Bun 与 pnpm 支持。
- 产物检查：发布前校验 `index.html`、路径范围和符号链接；主题未提供国旗或系统图标时，回退到镜像内置资源。
- 配置存储：主题产物与设置均位于容器 `/data`；极简探针设置按主题 `short` 隔离，保存时校验字段类型、范围与选项。

### 🔒 访问与构建边界

- 上游访问：仅访问已配置主控的固定探针路径，访客不能指定上游地址；探针密钥不会发送给浏览器或主题构建进程。
- 管理范围：`ADMIN_TOKEN` 验证成功后签发管理员会话，仅用于本项目主题配置，不提供节点管理、远程命令或主控写入能力。
- 主题来源：安装和构建会执行主题仓库脚本，应使用可信仓库并固定版本。

## 🧱 技术栈

- TypeScript：使用 ESM 模块与 `tsc` 编译，组织接口和数据映射代码。
- Node.js 22：通过原生 HTTP 服务提供 API 与主题静态资源。
- ws：实现上游 WebSocket 连接和主题实时推送。
- npm / pnpm / Bun：安装项目或主题依赖并执行前端构建。
- Docker：多阶段构建运行镜像，以非 root 用户运行服务。

## 🗂️ 项目结构

```text
mmwx-probe-theme-adapter/
├── src/
│   ├── main.ts              # 启动入口与生命周期
│   ├── config.ts            # 环境变量与运行目录配置
│   ├── http/                # HTTP、WebSocket 与静态资源路由
│   ├── komari/              # Komari 数据映射与查询
│   ├── monitor/             # 极简探针协议兼容
│   ├── mmwx/                # 主控客户端、流中继与历史缓冲
│   └── theme/               # 主题加载、构建与配置存储
├── static-assets/          # 内置国旗与系统图标
├── test/                   # node:test 单元与兼容性测试
├── compose.yaml            # 镜像部署示例
├── Dockerfile              # 多阶段镜像构建
├── package.json            # npm 脚本与依赖
└── tsconfig.json           # TypeScript 编译配置
```

## 👨‍💻 本地开发

### 🧰 环境

- Node.js：22 或以上版本。
- npm：安装项目依赖并运行构建与测试命令。

### 🔨 编译与测试

```bash
git clone https://github.com/sunnyhmz7010/mmwx-probe-theme-adapter.git
cd mmwx-probe-theme-adapter
npm ci
npm test
```

仅编译时运行 `npm run build`，产物位于 `dist/`。

### 🐳 构建镜像

```bash
docker build -t mmwx-probe-theme-adapter .
```

## 🔐 安全报告

如果发现安全问题，请不要公开披露细节。请优先参考仓库中的 [SECURITY.md](./SECURITY.md) 提交安全报告。

## 📄 许可证

本项目基于 [GPL-3.0](./LICENSE) 开源。

<div align="center">
  <sub>Built with ❤️ by Sunny</sub>
</div>
