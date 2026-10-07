import { KomariDataService } from '../komari/service.js'
import type { ProbeHistoryBuffer } from '../mmwx/history-buffer.js'
import { serverIdentity } from '../mmwx/identity.js'
import type { ProbeOrigin } from '../mmwx/stream-relay.js'
import type { ProbePayload } from '../mmwx/types.js'
import { numericId, toMonitorSnapshot } from './mapper.js'

export class MonitorDataService {
  private historyService: KomariDataService
  private topology = ''
  private topologyVersion = 0

  public constructor(private readonly source: Pick<ProbeOrigin, 'fetchProbe' | 'fetchSeries'> & { readonly topologyRevision?: number }, private readonly history?: ProbeHistoryBuffer) {
    this.historyService = new KomariDataService(source, undefined, history)
  }

  public snapshot(payload: ProbePayload): ReturnType<typeof toMonitorSnapshot> {
    this.syncTopology(payload)
    return toMonitorSnapshot(payload)
  }

  public async getSnapshot(): Promise<ReturnType<typeof toMonitorSnapshot>> {
    return this.snapshot(await this.source.fetchProbe())
  }

  private syncTopology(payload: ProbePayload): void {
    const topology = JSON.stringify([this.source.topologyRevision, payload.servers.map((server, index) => [serverIdentity(server, index), server.hidden === true])])
    if (topology === this.topology) return
    // 上游序列按下标查询，重排后不能沿用上一份下标缓存。
    this.historyService = new KomariDataService(this.source, undefined, this.history)
    this.topology = topology
    this.topologyVersion += 1
  }

  public async getHistory(id: string, params: URLSearchParams): Promise<unknown> {
    if (!/^\d+$/.test(id) || !Number.isSafeInteger(Number(id))) throw httpError(400, 'invalid node id')
    const hours = boundedInteger(params.get('hours'), 24, 1, 24)
    const points = boundedInteger(params.get('points'), 600, 60, 1440)
    const series = params.get('series')
    if (series !== null && series !== 'metrics' && series !== 'ping') throw httpError(400, 'invalid series')
    const payload = await this.source.fetchProbe()
    this.snapshot(payload)
    const index = payload.servers.findIndex((server, index) => server.hidden !== true && numericId(serverIdentity(server, index)) === Number(id))
    if (index < 0) throw httpError(404, 'node not found')
    const topologyVersion = this.topologyVersion
    const service = this.historyService
    const query = { uuid: `mmwx-${index}`, hours }
    const [load, ping] = await Promise.all([
      series === 'ping' ? undefined : service.getLoadHistory(query.uuid, query),
      series === 'metrics' ? undefined : service.getPingHistory(query),
    ])
    const current = await this.source.fetchProbe()
    this.syncTopology(current)
    if (this.topologyVersion !== topologyVersion || current.servers[index]?.hidden === true) throw httpError(503, 'node list changed; retry')
    const now = Date.now() / 1000
    const from = now - hours * 3600
    const inRange = (time: string): boolean => Date.parse(time) / 1000 >= from && Date.parse(time) / 1000 <= now
    const metrics = sample((load?.records ?? []).filter(row => inRange(row.time)).map(row => ({
      ts: Math.floor(Date.parse(row.time) / 1000), cpu: row.cpu, mem_used: row.ram,
      disk_used: row.disk, net_rx: row.net_in, net_tx: row.net_out,
    })), points)
    const probes: Record<string, string> = {}
    const loss: Record<string, number> = {}
    const rows: Array<{ task_id: number; ts: number; latency: number | null; loss?: number }> = []
    for (const task of ping?.tasks ?? []) {
      const taskId = numericId(`ping:${task.name}`)
      probes[String(taskId)] = task.name
      const records = (ping?.records ?? []).filter(row => row.task_id === task.id && inRange(row.time))
      const mapped = records.map(row => ({
        task_id: taskId, ts: Math.floor(Date.parse(row.time) / 1000),
        latency: row.value !== null && row.value >= 0 ? row.value : null,
        loss: row.loss == null ? (row.value === null || row.value < 0 ? 100 : undefined) : Math.min(100, Math.max(0, row.loss)),
      }))
      const known = mapped.filter(row => row.loss !== undefined)
      if (known.length) loss[String(taskId)] = known.reduce((sum, row) => sum + row.loss!, 0) / known.length
      rows.push(...sample(mapped, points))
    }
    return { metrics, ping: rows, probes, loss }
  }
}

function httpError(statusCode: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode })
}

function boundedInteger(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null) return fallback
  const value = Number(raw)
  if (!raw.trim() || !Number.isFinite(value) || value <= 0) throw httpError(400, 'invalid history query')
  return Math.max(min, Math.min(max, Math.floor(value)))
}

// 仅抽取真实样本，保留首尾；不补点或伪造桶内峰值。
function sample<T>(rows: T[], points: number): T[] {
  if (rows.length <= points) return rows
  return Array.from({ length: points }, (_, i) => rows[Math.round(i * (rows.length - 1) / (points - 1))])
}
