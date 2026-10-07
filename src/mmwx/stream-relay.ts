import WebSocket from 'ws'

import type { ProbeHistoryBuffer } from './history-buffer.js'
import type { ProbePayload, ProbeSeriesPayload, SeriesQuery } from './types.js'
import { serverIdentity } from './identity.js'

const MAX_FRAME_AGE_MS = 12_000
const RECONNECT_MAX_MS = 30_000
const WATCHDOG_INTERVAL_MS = 10_000
const STALE_FRAME_MS = 15_000

export interface ProbeOrigin {
  fetchProbe(): Promise<ProbePayload>
  fetchSeries(query: SeriesQuery): Promise<ProbeSeriesPayload>
  streamUrl(): string
  probeHeaders(): Record<string, string>
}

// WebSocket 工厂可注入：单测用受控假连接替代真实网络。
export type WebSocketFactory = (url: string, options: { headers: Record<string, string> }) => WebSocket

const defaultWebSocketFactory: WebSocketFactory = (url, options) => new WebSocket(url, options)

/**
 * ProbeStreamRelay 常驻采样与主控降载：
 * - 采集层与服务同生命周期：启动即连接主控探针 WebSocket，断线后无条件指数退避重连，
 *   看门狗在帧龄超阈值（WS 闪断、假活或重连间隙）时用 HTTP 快照兜底采样，
 *   历史缓冲 7x24 持续积累，不依赖访客在线。
 * - 分发层把每一帧写入历史缓冲、复用给 HTTP 快照请求并广播给所有下游访客；
 *   无论访客多少，主控侧始终只有一条连接。
 */
export class ProbeStreamRelay {
  private upstream: WebSocket | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private watchdogTimer: ReturnType<typeof setInterval> | null = null
  private reconnectAttempts = 0
  private latestPayload: ProbePayload | null = null
  private latestAt = 0
  private snapshotRequest: Promise<ProbePayload> | null = null
  private readonly clients = new Set<WebSocket>()
  private readonly transforms = new Map<WebSocket, (payload: ProbePayload) => unknown>()
  private readonly wsFactory: WebSocketFactory
  private topology = ''
  private revision = 0

  public get topologyRevision(): number { return this.revision }

  public constructor(
    private readonly origin: ProbeOrigin,
    private readonly history?: ProbeHistoryBuffer,
    wsFactory: WebSocketFactory = defaultWebSocketFactory,
  ) {
    this.wsFactory = wsFactory
  }

  // 常驻采集入口：启动即连接上游并开启帧龄看门狗；重复调用幂等。
  public start(): void {
    this.startWatchdog()
    this.ensureUpstream()
  }

  public async fetchProbe(): Promise<ProbePayload> {
    if (this.latestPayload !== null && this.frameAgeMs() <= MAX_FRAME_AGE_MS) {
      return this.latestPayload
    }
    return this.ensureSnapshot()
  }

  public async fetchSeries(query: SeriesQuery): Promise<ProbeSeriesPayload> {
    return this.origin.fetchSeries(query)
  }

  public subscribe(downstream: WebSocket, transform?: (payload: ProbePayload) => unknown): void {
    if (transform) this.transforms.set(downstream, transform)
    this.clients.add(downstream)
    const latest = this.latestPayload
    if (latest !== null && this.frameAgeMs() <= MAX_FRAME_AGE_MS) {
      this.sendTo(downstream, latest)
    } else {
      void this.seed(downstream)
    }
  }

  public unsubscribe(downstream: WebSocket): void {
    this.clients.delete(downstream)
    this.transforms.delete(downstream)
  }

  public close(): void {
    for (const client of this.clients) {
      try {
        client.close(1001, 'server shutting down')
      } catch {
        // 连接可能已关闭。
      }
    }
    this.clients.clear()
    this.transforms.clear()
    this.cancelReconnect()
    this.stopWatchdog()
    this.closeUpstream()
  }

  private async ensureSnapshot(): Promise<ProbePayload> {
    if (this.snapshotRequest) return this.snapshotRequest
    this.snapshotRequest = this.origin.fetchProbe()
      .then((payload) => {
        this.remember(payload)
        return payload
      })
      .finally(() => {
        this.snapshotRequest = null
      })
    return this.snapshotRequest
  }

  private async seed(downstream: WebSocket): Promise<void> {
    try {
      const payload = await this.ensureSnapshot()
      if (downstream.readyState === WebSocket.OPEN) this.sendTo(downstream, payload)
    } catch (error) {
      console.warn('ProbeStreamHub seed snapshot failed', error)
    }
  }

  private frameAgeMs(): number {
    return Date.now() - this.latestAt
  }

  private remember(payload: ProbePayload): void {
    const topology = JSON.stringify(payload.servers.map((server, index) => [serverIdentity(server, index), server.hidden === true]))
    if (topology !== this.topology) {
      this.topology = topology
      this.revision += 1
    }
    this.latestPayload = payload
    this.latestAt = Date.now()
    // 每一帧（WS 实时帧或 HTTP 快照）同时喂给历史缓冲，形成逐次密度采样。
    this.history?.ingest(payload, new Date(this.latestAt))
    for (const client of this.clients) {
      this.sendTo(client, payload)
    }
  }

  private sendTo(client: WebSocket, payload: ProbePayload): void {
    try {
      const transform = this.transforms.get(client)
      client.send(JSON.stringify(transform ? transform(payload) : payload))
    } catch {
      try {
        client.close(1011, 'send failed')
      } catch {
        // 连接可能已关闭。
      }
    }
  }

  private ensureUpstream(): void {
    if (this.upstream && (this.upstream.readyState === WebSocket.OPEN || this.upstream.readyState === WebSocket.CONNECTING)) return
    this.connectUpstream()
  }

  private connectUpstream(): void {
    const socket = this.wsFactory(this.origin.streamUrl(), {
      headers: this.origin.probeHeaders(),
    })
    this.upstream = socket

    socket.on('open', () => {
      this.reconnectAttempts = 0
      this.cancelReconnect()
    })
    socket.on('message', (data) => {
      if (this.upstream !== socket) return
      try {
        this.remember(JSON.parse(data.toString()) as ProbePayload)
      } catch {
        // 忽略单条无法解析的上游帧，保持连接继续。
      }
    })
    socket.on('close', () => {
      if (this.upstream !== socket) return
      this.upstream = null
      // 常驻采样：无论是否有下游访客都无条件重连。
      this.scheduleReconnect()
    })
    socket.on('error', () => {
      // close 事件随后触发，统一在 close 回调中处理重连。
    })
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return
    const delay = Math.min(1_000 * (2 ** this.reconnectAttempts), RECONNECT_MAX_MS)
    this.reconnectAttempts += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.ensureUpstream()
    }, delay)
  }

  private cancelReconnect(): void {
    if (!this.reconnectTimer) return
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
  }

  // 看门狗：帧龄超阈值说明上游 WS 未正常推帧（闪断、假活、重连间隙），
  // 主动拉一次 HTTP 快照兜底采样；ensureSnapshot 自带并发去重。
  private startWatchdog(): void {
    if (this.watchdogTimer) return
    this.watchdogTimer = setInterval(() => {
      if (this.frameAgeMs() <= STALE_FRAME_MS) return
      // 这里必须 catch：上游不可达是可恢复错误，下一轮 tick 会自然重试。
      // 直接 `void` 丢弃 promise 会让回源失败冒泡成未处理 rejection，Node 默认
      // 终止进程 —— 主控长期不可达时帧龄恒为超阈值，每个 tick 都会触发一次，
      // 于是变成稳定复现的 10 秒崩溃循环，而不是靠重连自愈。
      void this.ensureSnapshot().catch((error: unknown) => {
        console.warn('帧龄看门狗兜底采样失败', {
          reason: error instanceof Error ? error.message : 'unknown error',
        })
      })
    }, WATCHDOG_INTERVAL_MS)
  }

  private stopWatchdog(): void {
    if (!this.watchdogTimer) return
    clearInterval(this.watchdogTimer)
    this.watchdogTimer = null
  }

  private closeUpstream(): void {
    const socket = this.upstream
    this.upstream = null
    if (!socket) return
    try {
      socket.close(1000, 'ProbeHub shutting down')
    } catch {
      // 上游已关闭。
    }
  }
}
