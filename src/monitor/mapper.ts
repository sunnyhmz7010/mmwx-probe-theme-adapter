import { createHash } from 'node:crypto'
import type { ProbePayload, ProbeServer } from '../mmwx/types.js'
import { serverIdentity } from '../mmwx/identity.js'
import { toKomariNode } from '../komari/mapper.js'

export interface MonitorNode {
  id: number
  name: string
  online: boolean
  public: boolean
  metrics: Record<string, number | number[] | undefined> | null
  [key: string]: unknown
}

export function numericId(identity: string): number {
  // 48 位整数在 JS 安全整数范围内；跨启动稳定，不泄露原始 host 或字符串 id。
  return Number.parseInt(createHash('sha256').update(identity).digest('hex').slice(0, 12), 16) + 1
}

function number(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (value === null || value === undefined || value === '' || typeof value === 'boolean') continue
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function text(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.trim().length > 0)?.trim()
}

function seconds(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined
  const numeric = number(value)
  const ms = numeric === undefined ? Date.parse(String(value)) : numeric < 1e12 ? numeric * 1000 : numeric
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined
}

export function toMonitorNode(server: ProbeServer, index: number, updatedAt?: ProbePayload['updatedAt']): MonitorNode {
  const base = toKomariNode(server, index)
  const mode = text(server.traffic_stats_mode, server.traffic_limit_type)
  const trafficMode = ({ both: 'sum', upload: 'up', download: 'down', max: 'max', sum: 'sum', up: 'up', down: 'down' } as Record<string, string>)[mode ?? 'both']
  const periodUp = number(server.traffic_used_up)
  const periodDown = number(server.traffic_used_down)
  const billed = number(server.traffic_used, server.traffic_used_total)
  const hasPeriod = periodUp !== undefined || periodDown !== undefined || billed !== undefined
  let monthTx = hasPeriod ? base.network?.totalUp : undefined
  let monthRx = hasPeriod ? base.network?.totalDown : undefined
  // 仅有调整后的总用量时，仍保证主题聚合结果等于主控计费用量。
  if (billed !== undefined && (periodUp ?? 0) + (periodDown ?? 0) === 0) {
    monthTx = trafficMode === 'down' ? 0 : billed
    monthRx = trafficMode === 'down' ? billed : 0
  }
  const renewal = text(server.renewal_cycle)
  const billingCycle = ({ month: 'monthly', quarter: 'quarterly', half_year: 'semiannual', year: 'yearly' } as Record<string, string>)[renewal ?? '']
    ?? ({ '-1': 'once', '30': 'monthly', '90': 'quarterly', '180': 'semiannual', '365': 'yearly', '730': 'biennial', '1095': 'triennial', '1825': '60m' } as Record<string, string>)[String(number(server.billing_cycle))]
  const expiry = seconds(server.expired_at ?? server.expires_at)
  const country = text(server.region_country, server.country, server.region)?.toUpperCase()
  const metrics: MonitorNode['metrics'] = server.online === false ? null : {
    cpu: base.cpu,
    mem_used: base.ram?.used,
    mem_total: base.ram?.total,
    disk_used: base.disk?.used,
    disk_total: base.disk?.total,
    swap_used: number(server.swap),
    swap_total: number(server.swap_total),
    net_rx: base.network?.down,
    net_tx: base.network?.up,
    tcp: number(server.tcp_connections),
    udp: number(server.udp_connections),
    procs: number(server.process),
    uptime: number(server.uptime),
    load: base.load?.load1 === undefined ? undefined : [base.load.load1, base.load.load5, base.load.load15].filter((v): v is number => v !== undefined),
  }
  return {
    id: numericId(serverIdentity(server, index)),
    name: text(server.name) ?? `Node ${index + 1}`,
    online: server.online !== false,
    public: server.hidden !== true,
    last_seen: seconds(server.updated_at ?? updatedAt) ?? (server.online !== false ? Math.floor(Date.now() / 1000) : undefined),
    metrics,
    country: country && /^[A-Z]{2}$/.test(country) ? country : undefined,
    group: text(server.group),
    sort: number(server.weight),
    os: text(server.os),
    kernel: text(server.kernel_version, server.kernel),
    arch: text(server.arch),
    virt: text(server.virtualization),
    cpu_name: text(server.cpu_name, server.cpu_model),
    cpu_cores: number(server.cpu_cores),
    mem_total: number(server.mem_total),
    swap_total: number(server.swap_total),
    disk_total: number(server.disk_total),
    price: number(server.price, server.renewal_price, server.renewal_price_cny),
    currency: text(server.currency, server.renewal_currency) ?? (server.renewal_price_cny != null ? 'CNY' : undefined),
    billing_cycle: billingCycle,
    expires_at: expiry === undefined ? undefined : new Date(expiry * 1000).toISOString().slice(0, 10),
    expires_in: expiry === undefined ? undefined : Math.ceil((expiry * 1000 - Date.now()) / 86_400_000),
    traffic_limit: number(server.traffic_limit),
    traffic_mode: trafficMode,
    month_tx: monthTx,
    month_rx: monthRx,
    month_used: billed,
    month_start: seconds(server.period_start),
    // MMWX 的累计计数仅覆盖当前开机周期，不能混用计费周期字段。
    total_tx: number(server.cumulative_up, server.boot_traffic_up, server.net_total_up, server.totalUpload),
    total_rx: number(server.cumulative_down, server.boot_traffic_down, server.net_total_down, server.totalDownload),
  }
}

export function toMonitorSnapshot(payload: ProbePayload): { nodes: MonitorNode[] } {
  const ids = new Set<number>()
  const nodes = payload.servers.flatMap((server, index) => {
    if (server.hidden === true) return []
    const node = toMonitorNode(server, index, payload.updatedAt)
    if (ids.has(node.id)) throw new Error('MMWX nodes must have distinct id, host or name')
    ids.add(node.id)
    return [node]
  })
  return { nodes }
}
