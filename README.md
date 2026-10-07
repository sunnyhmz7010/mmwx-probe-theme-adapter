<div align="center">
  <h1>MMWX Probe Theme Adapter</h1>
  <p>以妙妙屋 X 为数据源的多主题探针适配器，支持 Komari 和极简探针主题</p>
</div>

<p align="center">
  <a href="https://github.com/sunnyhmz7010/mmwx-probe-theme-adapter/releases"><img src="https://img.shields.io/github/v/release/sunnyhmz7010/mmwx-probe-theme-adapter?label=Release&color=3b82f6" alt="Release" /></a>
  <a href="https://github.com/sunnyhmz7010/mmwx-probe-theme-adapter/blob/main/LICENSE"><img src="https://img.shields.io/github/license/sunnyhmz7010/mmwx-probe-theme-adapter?color=10b981" alt="License" /></a>
</p>

---

## ✨ 为什么做这个项目

MMWX Probe 以 Cloudflare Worker 的形式提供 React 静态页面、只读 API 代理和 WebSocket 代理，但内置主题有限。本项目通过 Komari 和 Monitor 兼容转换层，让妙妙屋 X 探针数据可以驱动两个生态中的丰富主题，并把固定的探针代理、WebSocket 实时流和主题页面整合到同一个对外地址下，访客只接触探针域名，无需直接访问主控域名。

它适合已经部署独立探针的主控，又希望用 Docker 快速部署公开探针页面、复用 Komari 或 Monitor 主题展示效果的场景。

⚠️ **免责声明**：

- 本项目与 Komari 官方项目无关
- 本项目与妙妙屋 X 官方项目无关
- 这里的“Komari 兼容”只表示 API 形状兼容，不表示上游项目关系或授权关系
- 本项目若使用或兼容 Komari 生态中的第三方主题，相关主题的版权、商标和知识产权均归其原作者所有；本项目与这些第三方主题作者无隶属、合作或背书关系，展示/兼容不代表作者认可本项目

## 🚀 核心能力

- 固定探针代理：仅代理 `/api/probe`、`/api/series`、`/api/stream` 到妙妙屋 X 主控对应路径，不接受访客指定上游地址
- Komari 公开只读兼容层：基于标准探针数据做结构转换，生成常见 Komari 主题需要的 `/api/public`、`/api/nodes`、`/api/records/*` 和部分 `/api/rpc2` 只读方法
- Monitor 公开只读兼容层：支持 monitor-probe 主题的节点快照、实时推送、历史图表和主题配置；数据仍全部来自 mmwx，无需部署 Monitor 后端
- 运行时主题加载：启动时从指定 Git 仓库拉取主题，自动识别静态主题或前端构建型主题，并发布校验后的构建产物
- 主题配置管理：保留 `/admin` 原有入口；支持 `komari-theme.json` 和 Monitor `theme.json` 托管配置主题，也兼容通过 `/?view=theme-manage` 提供前端配置页的主题
- 历史与实时数据：`/api/series` 提供延迟、丢包率和系统指标历史，`/api/stream` 代理主控实时探针 WebSocket
- 主控降载：通过共享流中继维护一条常驻的到主控探针 WebSocket（7x24 常驻采样，不依赖访客在线），广播给所有访客并复用最近快照帧，访客数增加不再按比例增加主控连接与实时查询
- 探针数据保留：`/api/probe` 保留服务器状态、系统指标、流量周期、每日流量、续费信息和回程路由等主控字段
- 只读安全边界：`PROBE_TOKEN` 仅用于容器访问已配置主控，不暴露给浏览器，不提供登录、管理、写入或节点修改能力

## ⚡ 快速开始

### 📋 前置要求

- 已部署支持独立探针访问密钥的妙妙屋 X 主控
- 主控具有可由容器访问的 HTTPS 地址
- 一台能访问妙妙屋 X 主控和 GitHub 的 VPS、NAS 或本地 Docker 环境
- Docker 与 Docker Compose
- 一个可公开拉取的 Komari 或 Monitor 主题 GitHub 仓库
- 常驻 CPU 低于单核 5%，内存 100~200MB，磁盘为镜像本体数百 MB 加约 6MB 历史缓冲（每 5 分钟覆盖写、不随时间累积，日均覆盖写入约 1.7GB）
- 构建主题时内存与磁盘瞬时需求更高，建议预留 1GB 内存和 1GB 可用磁盘

### 📦 Docker Compose（推荐）

新建 `compose.yaml`：

```yaml
services:
  mmwx-probe-theme-adapter:
    image: ghcr.io/sunnyhmz7010/mmwx-probe-theme-adapter:latest
    container_name: mmwx-probe-theme-adapter
    restart: unless-stopped
    ports:
      - "8080:8080"
    environment:
      - MMWX_ORIGIN=https://panel.example.com
      - PROBE_TOKEN=replace-with-probe-token
      - THEME_REPO=https://github.com/example/komari-theme
      - THEME_REF=main
      - THEME_GIT_PROXY=
      - ADMIN_TOKEN=replace-with-random-admin-token
```

容器会在内部运行目录保存主题构建产物和主题设置，不映射到宿主机；删除容器后这些运行时数据会随容器一并删除。

启动服务：

```bash
docker compose up -d
docker compose logs -f
```

打开 `http://localhost:8080` 查看主题页面。标准探针接口同时位于同一地址下，例如 `http://localhost:8080/api/probe`。

### 🖥️ 命令行方式

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

### 🛠️ 自行构建镜像

```bash
git clone https://github.com/sunnyhmz7010/mmwx-probe-theme-adapter.git
cd mmwx-probe-theme-adapter
docker build -t mmwx-probe-theme-adapter .
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
  mmwx-probe-theme-adapter
```

如果使用 Docker Compose 本地构建，把 `compose.yaml` 中的 `image: ghcr.io/...` 换成 `build: .`，然后执行 `docker compose up -d --build`。

## 📖 使用说明

### 📡 妙妙屋 X 主控代理

```text
浏览器 ──HTTP/WS──> Docker 容器 ──携带 PROBE_TOKEN──> 妙妙屋 X 主控
```

容器只把固定路径代理到主控，不接受访客传入任意上游地址，因此不会形成开放代理。

| 对外路径 | 主控路径 | 用途 |
| --- | --- | --- |
| `/api/probe` | `/api/public/probe-servers` | 服务器状态（服务器列表中的每个 `servers[]` 对象还会返回当前计费周期的 `daily_traffic`，元素包含 `date`、`uplink`、`downlink` 和 `total`（字节）。周期汇总字段包括 `traffic_used_up`、`traffic_used_down`、`traffic_used_total`，周期边界为 `period_start`（含）和 `period_end`（不含）。兼容字段 `traffic_used` 仍表示按主控服务器统计模式计算的计费用量。） |
| `/api/series` | `/api/public/probe-series` | 24 小时延迟、丢包率及系统指标历史；追加 `metric=system` 获取 CPU、内存、网速和累计流量序列 |
| `/api/stream` | `/api/public/probe-ws` | 实时 WebSocket，由容器共享单条上游连接并广播给所有访客 |

### 🔌 主控降载

容器通过共享流中继（`ProbeStreamRelay`）维护一条常驻的到主控共享探针 WebSocket（服务启动即连接、断线自动重连，与访客无关），把实时快照帧广播给所有访客；`/api/probe` 优先复用最近一帧（12 秒内），历史序列 `/api/series` 实时直连主控。这样访客数增加时不再按访客数增加主控 WebSocket 与实时数据查询。

### 🧩 Komari 兼容接口

除标准探针接口外，容器还为常见 Komari 主题提供只读兼容接口：

- `GET /api/nodes`
- `GET /api/public`
- `GET /api/me`（建立适配器主题配置会话后返回已登录状态）
- `GET /api/records/ping`
- `GET /api/records/load`
- `POST /api/rpc2`
- `GET /api/rpc2` WebSocket
- `GET /api/clients` WebSocket

已支持的只读 RPC2 方法：

- `rpc.ping`
- `rpc.getMethods`
- `rpc.getHelp`
- `rpc.getVersion`
- `common:getBackendVersion`
- `common:getMe`
- `common:getPublicInfo`
- `public:getNodesInformation`
- `public:getPublicSettings`
- `common:getNodes`
- `common:getRecords`
- `common:getNodesLatestStatus`
- `public:getClientRecentRecords`
- `public:getRecordsByUUID`
- `public:getPingRecords`
- `public:queryMetrics`
- `public:getPingMetricStats`
- `public:getPublicPingTasks`
- `nodes.list`
- `public.nodes`
- `records.ping`
- `records.load`

### 🛰️ Monitor 主题

使用 Monitor 主题时，在 Compose 中将 `THEME_REPO` 改成下面任一仓库，`THEME_REF` 使用 `main`：

```yaml
      - THEME_REPO=https://github.com/dongbo501/gloria-universe-monitor-theme
```

```yaml
      - THEME_REPO=https://github.com/dongbo501/minimalist-probe-doraemon-theme
```

修改后重新创建容器：

```bash
docker compose up -d --force-recreate
```

适配器优先识别 `komari-theme.json`，否则识别包含 `short` 和 `config` 数组的 Monitor `theme.json`；没有这两种清单时沿用 Komari 模式。每个实例加载一个主题，`/api/nodes` 和 `/api/me` 的响应格式随当前主题协议切换。

| Monitor 接口 | 支持内容 |
| --- | --- |
| `GET /api/me` | mmwx 站点名称、适配器管理员会话状态 |
| `GET /api/nodes` | `{ nodes: [...] }` 格式的公开节点快照 |
| `WS /api/ws` | 连接即发送快照，随后随 mmwx 采样帧推送；复用单条上游连接 |
| `GET /api/nodes/{id}/metrics` | CPU、内存、磁盘、网速及 Ping 历史；支持 `hours`、`points`、`series=metrics\|ping` |
| `GET /api/themes/{short}/config` | 当前主题默认设置与已保存配置合并后的对象 |

兼容边界：

- 历史最多返回最近 **24 小时**实际数据；主题内置的 7 天或 90 天选项不会扩大 mmwx 的历史覆盖范围。`points` 限制为 60–1440，超出时抽取真实样本，不插值补点，也不伪造峰值或延迟区间。
- Ping 的 `loss` 使用百分比；窗口汇总由可用样本平均估算，不等同于 Monitor 原生后端按原始探测次数加权的精确丢包率。
- 节点 ID 从 mmwx 的 `id`、其次 `host`、其次 `name` 稳定生成。三者均缺失时才退回列表位置；无 ID 的节点改名可能改变身份，重复身份会报错。隐藏节点不进入 Monitor 列表或历史接口。
- `month_rx/month_tx` 表示 mmwx **当前计费周期**用量，可能不是自然月；`total_rx/total_tx` 是上游提供的累计计数，可能在重启后重置，并非 Monitor 自安装以来的累计值。
- 缺失指标省略，离线节点 `metrics` 为 `null`；不提供 Monitor 的节点管理、远程命令或 GitHub 登录能力。第三方主题可能自行把缺失值显示为零。
- Monitor 配置通过现有 `/admin` 保存，按主题 `short` 隔离；写入验证字段类型、数字范围及选项值。容器重建仍遵循本项目运行目录数据随容器删除的约定。

### 🎨 主题配置

需要修改主题设置时，打开适配器的管理页：

```text
http://localhost:8080/admin
```

使用步骤：

1. 先在部署环境里设置 `ADMIN_TOKEN`。
2. 访问 `/admin`，输入 `ADMIN_TOKEN`，点击“验证”。
3. 如果当前主题有配置项，直接在 `/admin` 修改并点击“保存主题配置”。
4. 如果当前主题提示使用前端配置页，例如 Lumina、LuminaPlus、Junimo，先在 `/admin` 验证成功，再点击提示里的 `/?view=theme-manage` 入口去设置。
5. 设置完成后可以点击“退出登录”清除当前浏览器的管理会话。

适配器不会修改主题源码。没有配置项、也没有前端配置页的主题，只会显示“当前主题未声明可配置项”。

### 🧪 已实测主题仓库

理论上 `https://raw.githubusercontent.com/komari-monitor/
theme-market/main/v1.json` 显示的主题均可正常安装。

下表展示了一些开发者实测的主题：

| 仓库地址 | 仓库分支 | 页面显示 | 数据兼容性 | 主题配置 |
| --- | :---: | :---: | --- | --- |
| `https://github.com/sanrokamlan-prog/komari-theme-Glassmorphism` | main | ✅ | ✅ 全部支持 | 有配置项，已兼容 |
| `https://github.com/Tokinx/komari-theme-emerald` | master | ✅ | ✅ 全部支持 | 有配置项，已兼容 |
| `https://github.com/stqfdyr/komari-theme-adhesive-note` | main | ✅ | ✅ 全部支持 | 主题本身无配置项 |
| `https://github.com/vaspike/junimo` | main | ✅ | ✅ 全部支持 | 有配置项，已兼容 |
| `https://github.com/stqfdyr/komari-theme-Lumina` | main | ✅ | ✅ 全部支持 | 有配置项，已兼容 |
| `https://github.com/shanyang242/Komari-Theme-LuminaPlus` | main | ✅ | ✅ 全部支持 | 有配置项，已兼容 |
| `https://github.com/lyimoexiao/komari-theme-naive` | master | ⚠️ 主题依赖安装占用大量资源 | ✅ 全部支持 | 有配置项，已兼容 |
| `https://github.com/tonyliuzj/komari-next` | main | ✅ | ✅ 全部支持 | 有配置项，已兼容 |
| `https://github.com/TonyStarkJr2021/komari-theme-Gloria-Universe` | main | ✅ | ✅ 全部支持 | 有配置项，已兼容 |
| `https://github.com/123nhh/Komari-Home-Plus` | main | ✅ | ✅ 全部支持 | 有配置项，已兼容 |
| `https://github.com/mogumc/Komari-Home` | main | ✅ | ✅ 全部支持 | 有配置项，已兼容 |
| `https://github.com/imengying/Komari-Glass` | main | ✅ | ✅ 全部支持 | 有配置项，已兼容 |
| `https://github.com/jacob-bytes/komari-theme-ink` | main | ✅ | ✅ 全部支持 | 有配置项，已兼容 |
| `https://github.com/cazi-cc/komari-theme-emerald` | master | ✅ | ⚠️ 仅支持基础信息显示 | 有配置项，未兼容 |
| `https://github.com/VoyagerProbe/Glassmorphism-Plus` | master | ✅ | ✅ 全部支持 | 有配置项，已兼容 |
| `https://github.com/r11234567/komari-theme-adhesive-note` | main | ✅ | ❌ | 主题本身无配置项 |
| `https://github.com/qwer-xyz/komari-theme-zen` | main | ✅ | ✅ 全部支持 | 有配置项，已兼容 |
| `https://github.com/nuomiiiii/nezha` | main | ✅ | ✅ 全部支持 | 有配置项，已兼容 |

Monitor 主题已使用模拟 mmwx 数据完成本地构建及浏览器联调：Gloria Universe `93f0acc`、Doraemon `f340e11`。覆盖首页、节点详情、历史图表、连续 WebSocket 更新和配置保存后回读；未连接实际主控，兼容范围见上文 Monitor 主题说明。

> ℹ️ **上游未提供字段说明**：妙妙屋 X 主控接口（`/api/public/probe-servers` 与 `metric=system` 历史序列）不返回部分字段，映射层按「能省略则省略、否则 `unknown`、最后才 0」处理：Swap 用量、GPU、温度、进程数、权重、分组、标签、隐藏标记、自动续费、创建/更新时间等直接省略，Komari 主题按「无数据」处理；虚拟化、GPU 名称等字符串字段显示 `unknown`。这是上游数据源限制，非本适配器可补齐；若主控后续提供这些字段，映射层（`src/komari/mapper.ts`）会立即生效，无需改动。

### 📋 环境变量

| 变量 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `MMWX_ORIGIN` | 是 | - | 妙妙屋 X 主控地址。生产环境必须使用 HTTPS；仅 `localhost` 和 `127.0.0.1` 允许 HTTP |
| `PROBE_TOKEN` | 是 | - | 主控“系统设置 → 探针”生成的独立探针访问密钥，仅作为 `X-MMwx-Probe-Token` 转发给主控 |
| `THEME_REPO` | 是 | - | Komari 或 Monitor 主题 GitHub HTTPS 仓库地址，按主题清单自动识别协议 |
| `THEME_REF` | 否 | `main` | 主题仓库分支、标签或 commit。生产环境建议固定到 tag 或 commit |
| `THEME_GIT_PROXY` | 否 | 空（直连） | GitHub 克隆加速代理前缀，例如 `https://gh-proxy.com`；实际克隆地址拼为 `<代理>/https://github.com/owner/repo.git`。仅接受 HTTPS（`localhost` 和 `127.0.0.1` 允许 HTTP），不支持带凭据、查询或片段的地址 |
| `ADMIN_TOKEN` | 否 | - | `/admin` 管理员验证使用的 Token；未设置时禁用验证和主题配置写入。适配器仅保存签名会话 Cookie，配置仍保存在容器内部运行目录 |

## 🧠 功能细节

- 原始探针层：`/api/probe`、`/api/series`、`/api/stream` 只做妙妙屋 X 主控代理，不改写路径、状态码和流式行为
- 常驻采样与降载：`ProbeStreamRelay` 在单进程内维护一条常驻的到主控探针 WebSocket（启动即连接，断开后无条件指数退避重连，不依赖访客在线），把实时快照帧广播给所有下游访客；`/api/probe` 在 12 秒帧龄内复用最近一帧，历史序列 `/api/series` 实时直连；帧龄看门狗（10 秒检查）在 WS 闪断、假活或重连间隙用 HTTP 快照兜底采样，保证历史缓冲持续有样本
- 主控不可达不致命：看门狗兜底采样失败只记录 `帧龄看门狗兜底采样失败` 警告并在下一轮重试，不会终止进程。适配器在主控 4xx/5xx 或网络异常时保持运行、继续提供主题静态资源，主控恢复后自动回到正常采样；因此日志里出现该警告表示主控侧有问题，但无需靠重启容器恢复
- 历史采样缓冲：实时帧同步写入进程内 `ProbeHistoryBuffer`，Komari 兼容层的 ping / 负载历史优先返回逐帧密度样本；缓冲保留最近 1 小时逐帧、更早按分钟降采样、共 25 小时，并每 5 分钟落盘到运行目录 `history-buffer.json`、启动时自动恢复，进程重启不丢历史；仅当运行目录数据不存在（如未映射卷的容器重建）时由主控聚合序列填补冷启动窗口（主控聚合桶粒度较粗——实测约 30 分钟/桶，直接输出会导致 Komari 主题历史块出现空白段）
- 转换池：Komari 兼容层从探针快照和历史序列池读取数据，再映射成 Komari 需要的固定结构
- 字段映射：地区字段优先取 `region_country`（ISO 代码）供主题解析国旗；续费货币把 ISO 代码转换为 Komari 官方 12 种货币符号（`CNY`→`¥`、`USD`→`$`、`CAD`→`CA$` 等）；`ping.loss` 指标按 Komari 语义输出 0~1 比例
- 系统连接数：主控 `tcp_connections` / `udp_connections` 映射为 Komari 的 `connections` / `connections_udp` 状态字段与 `public:queryMetrics` 的 `connections.tcp` / `connections.udp` 指标。口径为**整机**而非代理用户连接（TCP 只数 `/proc/net/tcp{,6}` 的 ESTABLISHED，UDP 数 `/proc/net/udp{,6}` 的全部 socket），是纯计数，映射层不做任何单位进位换算。老 agent 与非 Linux agent 不上报时主控省略字段，适配器整字段省略、不补 0（0 会与「真的一条连接都没有」混淆），主题按「无数据」处理
- 流量口径：`/api/nodes`、`/api/public` 与 `common:getNodesLatestStatus` 中的 `totalUp/totalDown`、`net_total_up/net_total_down` 映射为妙妙屋主控的**计费周期已用流量**（`traffic_used`，已含 `traffic_adjustment`，按主控 `traffic_stats_mode` 把调整值分摊回上下行，`both` 按比例缩放使合计与主控一致；`upload`/`download` 计费方向直取，`max` 取较大方向），无周期字段时回退开机累计计数器；`public:queryMetrics` 的 `traffic.up/traffic.down` 输出**每个时间桶的增量字节**（主题逐点求和得当日流量），累计序列（`cumulative_*`）自动转换为相邻差分，而 `net.total.up/net.total.down` 仍保持开机累计计数器语义，供 records 类接口做差值统计
- 状态映射：`common:getNodes`、`common:getNodesLatestStatus`、`common:getNodeRecentStatus`、`common:getRecords`、`public:queryMetrics` 都从同一套转换结果生成
- 聚合规则：Ping / 负载历史在未指定 `uuid` 时聚合全部可见节点，避免主题只看到第一个节点
- 公共设置：`common:getPublicInfo` 和 `public:getPublicSettings` 都基于同一份主题配置和探针快照生成
- 主题加载流程：校验 `THEME_REPO` 和 `THEME_REF` 后克隆仓库；设置 `THEME_GIT_PROXY` 时把完整 GitHub 地址拼到代理前缀后克隆（如 gh-proxy），默认直连 GitHub；有构建脚本和受支持锁文件时执行生产构建，否则使用根目录静态 `index.html`
- 主题构建环境：运行镜像内置 Bun，并启用 Corepack 的 pnpm shim；声明 `packageManager: pnpm@...` 或依赖 `pnpm-lock.yaml`、`catalog:` 的主题可按自身包管理器安装构建
- 主题配置流程：保留完整 `komari-theme.json`，根据 `configuration` 渲染轻量配置页；先通过 `/admin` 的“管理员验证”，再保存主题配置；有配置项的主题将保存按钮放在配置卡片底部
- 管理员验证接口：`POST /api/admin/auth/verify` 校验 `Authorization: Bearer ADMIN_TOKEN`；验证成功后签发 7 天有效的 `HttpOnly`、`SameSite=Lax` 签名 Cookie；错误 Token 即使伴随已有会话也不会通过验证
- 前端主题配置会话：`/api/me`、HTTP RPC2 和 WebSocket RPC 会向已建立会话返回已登录状态，Lumina、LuminaPlus、Junimo 等前端配置页可复用 `/api/admin/theme/settings` 保存配置；调用 `POST /api/admin/auth/logout` 会清除会话
- 管理路由兼容：`/admin` 和 `/admin/` 展示适配器设置页；`/admin/dashboard` 重定向到 `/admin`，兼容会跳转到该地址的主题；其他 `/admin/*` 子路径仍返回 404
- 管理与访问日志：Docker 标准输出记录 HTTP 方法、路径、状态码、耗时，以及管理员 Token 验证成功/失败、退出登录和主题配置保存结果；日志不会记录 Token、Cookie 或请求体
- 包管理器优先级：`pnpm-lock.yaml`、`bun.lock` / `bun.lockb`、`package-lock.json`
- 构建隔离：主题构建使用 `CI=true`，不会把 `PROBE_TOKEN` 等敏感环境变量传入主题构建进程
- 输出校验：构建产物必须包含 `index.html`，并通过路径包含性和符号链接检查防止目录逃逸；构建命令失败时仅采用本次新生成的产物，拒绝误用构建前残留的旧产物
- 主题资源兜底：模拟 Komari 主控的静态资源路径 `/assets/flags/`（国旗）和 `/assets/logo/`（操作系统图标）。主题构建产物自带这些资源时优先主题，否则回退到镜像内置资源；两者都不存在时直接 404，避免 SPA fallback 返回 HTML 导致图标裂图

## 🧱 技术栈

- TypeScript：ESM 项目，使用 `tsc` 编译
- Node.js：运行镜像基于 `node:22-bookworm-slim`
- ws：WebSocket 客户端与服务端兼容层
- Docker：多阶段构建，运行阶段使用非 root 用户
- 目标平台：Docker、Docker Compose、GitHub Container Registry

## 🗂️ 项目结构

```
mmwx-probe-theme-adapter/
├── src/                         # TypeScript 源码
│   ├── main.ts                  # 服务入口、启动和关闭生命周期
│   ├── config.ts                # 环境变量解析与安全校验
│   ├── log.ts                   # 结构化日志与脱敏
│   ├── http/                    # HTTP、静态资源和 API 路由
│   ├── komari/                  # Komari 数据映射和服务层
│   ├── monitor/                 # Monitor 节点、实时与历史协议兼容
│   ├── mmwx/                    # MMWX independent-probe 客户端与流中继
│   └── theme/                   # 主题仓库加载、构建和发布
├── static-assets/               # 内置国旗与系统图标资源兜底
├── test/                        # node:test 单元与兼容性测试
├── .github/                     # GitHub Actions 与 Issue 模板
├── compose.yaml                 # GHCR 镜像部署示例
├── Dockerfile                   # 容器镜像定义
├── package.json                 # npm 脚本与依赖声明
└── tsconfig.json                # TypeScript 编译配置
```

## 👨‍💻 本地开发

### 🧰 环境

- Node.js 22+
- npm
- Docker（仅构建或本地容器验证时需要）

### ⚙️ 命令

```bash
npm install
npm run build
npm test
docker build -t mmwx-probe-theme-adapter .
```

## 🔐 安全报告

如果发现安全问题，请不要公开披露细节。请优先参考仓库中的 [SECURITY.md](./SECURITY.md) 提交安全报告。

## 📄 许可证

本项目基于 [GPL-3.0](./LICENSE) 开源。

<div align="center">
  <sub>Built with ❤️ by Sunny</sub>
</div>
