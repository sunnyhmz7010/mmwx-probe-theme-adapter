import type { ProbePayload, ProbeServer } from './types.js'
import { serverIdentity } from './identity.js'

// 历史采样缓冲：用实时快照帧在适配器内自建逐次密度历史，
// 弥补主控 probe-series 只提供聚合桶（1h 视图约 5 分钟/桶）的粒度限制。
// 热层保留最近 1 小时逐帧原样；更早数据按分钟降采样进入冷层，整体覆盖 25 小时（满足 hours=24 查询）。
const HOT_WINDOW_MS = 60 * 60 * 1000
const COLD_WINDOW_MS = 25 * 60 * 60 * 1000
const COLD_BUCKET_MS = 60 * 1000
const MAX_HOT_POINTS = 2400
const MAX_COLD_POINTS = 1800

export interface BufferedLoadPoint {
  t: number
  cpu?: number
  ram?: number
  mem_total?: number
  disk?: number
  load?: number
  net_out?: number
  net_in?: number
  net_total_up?: number
  net_total_down?: number
}

export interface BufferedPingPoint {
  t: number
  value: number | null
  loss: number | null
}

interface PointSeries<T extends { t: number }> {
  hot: T[]
  cold: Map<number, T>
}

interface ClientSeries {
  load: PointSeries<BufferedLoadPoint>
  ping: Map<string, PointSeries<BufferedPingPoint>>
}

// 落盘格式版本：字段结构变化时递增，load 遇到不认识的版本直接丢弃。
const SNAPSHOT_VERSION = 1

function numberOrUndefined(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined
  const numeric = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(numeric) ? numeric : undefined
}

function firstFinite(values: readonly unknown[]): number | undefined {
  for (const value of values) {
    const numeric = numberOrUndefined(value)
    if (numeric !== undefined) return numeric
  }
  return undefined
}

function load1Of(value: ProbeServer['load'] | ProbeServer['loadavg']): number | undefined {
  if (Array.isArray(value)) return numberOrUndefined(value[0])
  if (typeof value === 'string' && value.trim().includes(' ')) return numberOrUndefined(value.trim().split(/\s+/)[0])
  return numberOrUndefined(value)
}

function pingTaskName(bucket: { key?: string | null; name?: string | null; label?: string | null }, index: number): string {
  return bucket.name?.trim() || bucket.label?.trim() || bucket.key?.trim() || `Ping ${index + 1}`
}

function isFiniteOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value))
}

function isPingPoint(item: unknown): item is BufferedPingPoint {
  if (typeof item !== 'object' || item === null) return false
  const point = item as { t?: unknown; value?: unknown; loss?: unknown }
  return Number.isFinite(point.t) && isFiniteOrNull(point.value) && isFiniteOrNull(point.loss)
}

function isLoadPoint(item: unknown): item is BufferedLoadPoint {
  if (typeof item !== 'object' || item === null) return false
  return Number.isFinite((item as { t?: unknown }).t)
}

/**
 * ProbeHistoryBuffer 以实时帧为样本源维护各节点的 load 与 ping 滚动历史。
 * 内存态，不持久化：重启后由 KomariService 回退主控聚合桶合并，运行满窗口后完全为逐帧密度。
 */
export class ProbeHistoryBuffer {
  private readonly clients = new Map<number, ClientSeries>()
  private identities = new Map<number, string>()

  public ingest(payload: ProbePayload, at: Date = new Date()): void {
    const servers = Array.isArray(payload.servers) ? payload.servers : []
    // 上游历史 API 使用列表下标；节点重排时让采样跟随身份，避免把上一台机器的历史拼进来。
    const previous = new Map([...this.identities].map(([index, identity]) => [identity, this.clients.get(index)]))
    const nextIdentities = new Map(servers.map((server, index) => [index, serverIdentity(server, index)]))
    const ambiguous = new Set<string>()
    for (const identities of [this.identities, nextIdentities]) {
      const seen = new Set<string>()
      for (const identity of identities.values()) {
        if (seen.has(identity)) ambiguous.add(identity)
        seen.add(identity)
      }
    }
    if (this.clients.size > 0) {
      this.clients.clear()
      for (const [index, identity] of nextIdentities) {
        // 重名旧节点身份不可靠，丢弃其旧样本；绝不能让两个下标共享同一缓冲对象。
        if (ambiguous.has(identity)) continue
        const series = previous.get(identity)
        if (series) this.clients.set(index, series)
      }
    }
    this.identities = nextIdentities
    const t = Math.floor(at.getTime() / 1000) * 1000
    for (let index = 0; index < servers.length; index += 1) {
      const server = servers[index]
      // 离线节点的帧字段是残值，不记为新样本，离线时段保持「无数据」语义。
      if (server.online === false) continue
      const series = this.clientSeries(index)
      this.appendLoad(series, server, t)
      this.appendPing(series, server, t)
    }
  }

  public snapshotLoad(index: number): BufferedLoadPoint[] {
    return this.mergeSeries(this.clients.get(index)?.load)
  }

  public snapshotPing(index: number): Map<string, BufferedPingPoint[]> {
    const result = new Map<string, BufferedPingPoint[]>()
    const series = this.clients.get(index)
    if (!series) return result
    for (const [name, points] of series.ping) {
      const merged = this.mergeSeries(points)
      if (merged.length > 0) result.set(name, merged)
    }
    return result
  }

  // 序列化为可落盘的 JSON 结构，冷层 Map 转数组。
  public toJSON(): unknown {
    const clients: Record<string, unknown> = {}
    for (const [index, series] of this.clients) {
      clients[String(index)] = {
        load: this.serializeSeries(series.load),
        ping: [...series.ping].map(([name, points]) => [name, this.serializeSeries(points)]),
      }
    }
    return { version: SNAPSHOT_VERSION, clients, identities: Object.fromEntries(this.identities) }
  }

  // 从落盘 JSON 恢复缓冲；按当前时间重整热/冷层归位并裁剪过期数据。形状不符时整体丢弃。
  public load(data: unknown, now: Date = new Date()): void {
    if (typeof data !== 'object' || data === null) return
    const snapshot = data as { version?: unknown; clients?: unknown; identities?: Record<string, unknown> }
    if (snapshot.version !== SNAPSHOT_VERSION) return
    if (typeof snapshot.clients !== 'object' || snapshot.clients === null) return
    const nowMs = now.getTime()
    for (const [key, value] of Object.entries(snapshot.clients as Record<string, unknown>)) {
      const index = Number(key)
      if (!Number.isInteger(index) || index < 0) continue
      const series = this.deserializeClient(value, nowMs)
      if (series) this.clients.set(index, series)
      const identity = snapshot.identities?.[key]
      if (typeof identity === 'string') this.identities.set(index, identity)
    }
  }

  private serializeSeries<T extends { t: number }>(series: PointSeries<T>): unknown {
    return {
      hot: series.hot,
      cold: [...series.cold.entries()],
    }
  }

  private deserializeClient(value: unknown, nowMs: number): ClientSeries | null {
    if (typeof value !== 'object' || value === null) return null
    const raw = value as { load?: unknown; ping?: unknown }
    const load = this.deserializeSeries<BufferedLoadPoint>(raw.load, nowMs, isLoadPoint)
    if (!load) return null
    const ping = new Map<string, PointSeries<BufferedPingPoint>>()
    if (Array.isArray(raw.ping)) {
      for (const entry of raw.ping) {
        if (!Array.isArray(entry) || typeof entry[0] !== 'string') continue
        const points = this.deserializeSeries<BufferedPingPoint>(entry[1], nowMs, isPingPoint)
        if (points && points.hot.length + points.cold.size > 0) ping.set(entry[0], points)
      }
    }
    return { load, ping }
  }

  private deserializeSeries<T extends { t: number }>(value: unknown, nowMs: number, isPoint: (item: unknown) => item is T): PointSeries<T> | null {
    if (typeof value !== 'object' || value === null) return null
    const raw = value as { hot?: unknown; cold?: unknown }
    if (!Array.isArray(raw.hot) || !Array.isArray(raw.cold)) return null
    const hot = raw.hot.filter(isPoint)
    const cold = new Map<number, T>()
    for (const entry of raw.cold) {
      if (!Array.isArray(entry) || !Number.isFinite(entry[0]) || !isPoint(entry[1])) continue
      cold.set(entry[0] as number, entry[1])
    }
    const series: PointSeries<T> = { hot, cold }
    // 恢复后按当前时间重整：停机期间过热层窗口的点降级冷层，超总窗口的裁剪。
    this.applyRetention(series, nowMs)
    return series
  }

  private clientSeries(index: number): ClientSeries {
    let series = this.clients.get(index)
    if (!series) {
      series = { load: { hot: [], cold: new Map() }, ping: new Map() }
      this.clients.set(index, series)
    }
    return series
  }

  private appendLoad(series: ClientSeries, server: ProbeServer, t: number): void {
    const point: BufferedLoadPoint = { t }
    const cpu = firstFinite([server.cpu, server.cpu_pct])
    const ram = firstFinite([server.memory, server.mem_used])
    const memTotal = numberOrUndefined(server.mem_total)
    const disk = numberOrUndefined(server.disk_used)
    const load = load1Of(server.load ?? server.loadavg)
    const netOut = firstFinite([server.upload, server.upload_speed])
    const netIn = firstFinite([server.download, server.download_speed])
    const netTotalUp = firstFinite([server.net_total_up, server.cumulative_up])
    const netTotalDown = firstFinite([server.net_total_down, server.cumulative_down])
    if (cpu !== undefined) point.cpu = cpu
    if (ram !== undefined) point.ram = ram
    if (memTotal !== undefined) point.mem_total = memTotal
    if (disk !== undefined) point.disk = disk
    if (load !== undefined) point.load = load
    if (netOut !== undefined) point.net_out = netOut
    if (netIn !== undefined) point.net_in = netIn
    if (netTotalUp !== undefined) point.net_total_up = netTotalUp
    if (netTotalDown !== undefined) point.net_total_down = netTotalDown
    // 整帧无有效指标时不产生样本，避免空白时段被残帧填出假数据。
    if (Object.keys(point).length === 1) return
    this.append(series.load, point, t)
  }

  private appendPing(series: ClientSeries, server: ProbeServer, t: number): void {
    const buckets = server.ping ?? []
    for (let index = 0; index < buckets.length; index += 1) {
      const bucket = buckets[index]
      const name = pingTaskName(bucket, index)
      let points = series.ping.get(name)
      if (!points) {
        points = { hot: [], cold: new Map() }
        series.ping.set(name, points)
      }
      const value = firstFinite([bucket.value, bucket.latency, bucket.current_ms]) ?? null
      const loss = numberOrUndefined(bucket.loss) ?? numberOrUndefined(bucket.loss_pct) ?? null
      this.append(points, { t, value, loss }, t)
    }
  }

  private append<T extends { t: number }>(target: PointSeries<T>, point: T, t: number): void {
    // 同一秒的重复帧（WS 帧与 HTTP 快照同源）覆盖，不产生重复样本。
    const last = target.hot[target.hot.length - 1]
    if (last && last.t === t) {
      target.hot[target.hot.length - 1] = point
      return
    }
    target.hot.push(point)
    this.applyRetention(target, t)
  }

  private applyRetention<T extends { t: number }>(target: PointSeries<T>, now: number): void {
    // 热层超出 1 小时的点按分钟降采样移入冷层，同一分钟保留最后一条。
    while (target.hot.length > 0 && target.hot[0].t <= now - HOT_WINDOW_MS) {
      const evicted = target.hot.shift()
      if (evicted) target.cold.set(Math.floor(evicted.t / COLD_BUCKET_MS) * COLD_BUCKET_MS, evicted)
    }
    if (target.hot.length > MAX_HOT_POINTS) target.hot.splice(0, target.hot.length - MAX_HOT_POINTS)
    // 冷层按 25 小时窗口过期，再以容量上限兜底（1 分钟粒度下 1800 桶约 30 小时）。
    while (target.cold.size > 0) {
      const oldest = target.cold.keys().next().value as number | undefined
      if (oldest === undefined || oldest >= now - COLD_WINDOW_MS) break
      target.cold.delete(oldest)
    }
    while (target.cold.size > MAX_COLD_POINTS) {
      const oldest = target.cold.keys().next().value as number | undefined
      if (oldest === undefined) break
      target.cold.delete(oldest)
    }
  }

  private mergeSeries<T extends { t: number }>(series?: PointSeries<T>): T[] {
    if (!series) return []
    return [...series.cold.values(), ...series.hot].sort((left, right) => left.t - right.t)
  }
}
