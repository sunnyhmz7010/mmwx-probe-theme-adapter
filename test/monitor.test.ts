import assert from 'node:assert/strict'
import { once } from 'node:events'
import http from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import WebSocket from 'ws'
import { toMonitorSnapshot } from '../src/monitor/mapper.js'
import { MonitorDataService } from '../src/monitor/service.js'
import { KomariDataService } from '../src/komari/service.js'
import { ProbeHistoryBuffer } from '../src/mmwx/history-buffer.js'
import { ProbeStreamRelay } from '../src/mmwx/stream-relay.js'
import type { ProbePayload, SeriesQuery } from '../src/mmwx/types.js'
import { createApiRouter } from '../src/http/api.js'
import { createHttpServer } from '../src/http/server.js'
import { FileThemeSettingsStore } from '../src/theme/settings-store.js'

test('Monitor snapshot preserves billing semantics, omits private fields and keeps IDs across reorder', () => {
  const payload: ProbePayload = { servers: [
    { id: 'server-a', host: 'private.example', name: 'Tokyo', cpu_pct: '12.5', mem_used: 20, region_country: 'jp',
      traffic_used_up: 20, traffic_used_down: 80, traffic_used: 150, traffic_stats_mode: 'both', cumulative_up: 1000,
      renewal_price: 10, renewal_currency: 'USD', renewal_cycle: 'year', tcp_connections: 0 },
    { id: 2, name: 'Offline', online: false, cpu: 99 },
    { id: 3, name: 'Hidden', hidden: true },
  ] }
  const { nodes } = toMonitorSnapshot(payload)
  assert.equal(nodes.length, 2)
  assert.equal(nodes[0].country, 'JP')
  assert.equal(nodes[0].metrics?.cpu, 12.5)
  assert.equal(nodes[0].metrics?.tcp, 0)
  assert.equal(nodes[0].metrics?.udp, undefined)
  assert.equal(nodes[0].month_tx, 30)
  assert.equal(nodes[0].month_rx, 120)
  assert.equal(nodes[0].total_tx, 1000)
  assert.equal(nodes[0].billing_cycle, 'yearly')
  assert.equal(nodes[0].currency, 'USD')
  assert.equal(nodes[1].metrics, null)
  assert.equal(nodes[0].id, toMonitorSnapshot({ servers: [...payload.servers].reverse() }).nodes[1].id)
  assert.doesNotMatch(JSON.stringify(nodes), /private.example|server-a/)
  const adjusted = toMonitorSnapshot({ servers: [{ id: 1, traffic_used: 99, traffic_stats_mode: 'download' }] }).nodes[0]
  assert.equal(adjusted.month_rx, 99)
  assert.equal(adjusted.month_tx, 0)
})

test('Monitor history clamps range, samples real points, shares cache and follows node identity', async () => {
  const now = Date.now()
  let payload: ProbePayload = { servers: [{ id: 'a', cpu: 12, disk_used: 123 }, { id: 'b', cpu: 34 }] }
  const buffer = new ProbeHistoryBuffer()
  buffer.ingest(payload, new Date(now - 1000))
  const calls: SeriesQuery[] = []
  const source = {
    fetchProbe: async () => payload,
    fetchSeries: async (query: SeriesQuery) => {
      calls.push(query)
      return query.metric === 'system'
        ? { series: { cpu_pct: Array.from({ length: 200 }, (_, i) => ({ t: Math.floor(now / 1000) - 200 + i, value: Number(query.server) + 10 })),
          disk_used: [{ t: Math.floor(now / 1000) - 100, value: 500 }] } }
        : { bucket_sec: 60, generated_at: Math.floor(now / 1000), all_series: [{ label: 'Telecom', buckets: [{ ms: 20, loss: 25 }, { ms: null, loss: 100 }] }] }
    },
  }
  const monitor = new MonitorDataService(source, buffer)
  const id = (await monitor.getSnapshot()).nodes[0].id
  const params = new URLSearchParams('hours=2160&points=60')
  const result = await monitor.getHistory(String(id), params) as { metrics: Array<{ ts: number; cpu: number }>; ping: Array<{ loss: number; latency: number | null }>; probes: object }
  assert.equal(result.metrics.length, 60)
  assert.ok(calls.every(query => query.range === '24h' && query.server === '0'))
  assert.equal(result.ping[0].loss, 25)
  assert.equal(result.ping[1].latency, null)
  await monitor.getHistory(String(id), params)
  assert.equal(calls.length, 2)
  payload = { servers: [...payload.servers].reverse() }
  buffer.ingest(payload, new Date(now))
  await monitor.getHistory(String(id), params)
  assert.ok(calls.slice(2).every(query => query.server === '1'))
  assert.equal(buffer.snapshotLoad(1)[0].cpu, 12)
  assert.equal(buffer.snapshotLoad(1)[0].disk, 123)
  const restored = new ProbeHistoryBuffer()
  restored.load(buffer.toJSON())
  restored.ingest({ servers: [...payload.servers].reverse() })
  assert.equal(restored.snapshotLoad(0)[0].cpu, 12)
  await assert.rejects(monitor.getHistory('999', params), /node not found/)
  await assert.rejects(monitor.getHistory(String(id), new URLSearchParams('hours=nope')), /invalid history query/)
})

test('ambiguous upstream identities never share sampled history', () => {
  const buffer = new ProbeHistoryBuffer()
  const now = Date.now()
  buffer.ingest({ servers: [{ name: 'same', cpu: 10 }, { name: 'same', cpu: 90 }] }, new Date(now - 2000))
  buffer.ingest({ servers: [{ name: 'same', cpu: 11 }, { name: 'same', cpu: 91 }] }, new Date(now))
  assert.deepEqual(buffer.snapshotLoad(0).map(row => row.cpu), [11])
  assert.deepEqual(buffer.snapshotLoad(1).map(row => row.cpu), [91])
})

test('rejects a history result if topology changes and returns to its original order', async () => {
  const original: ProbePayload = { servers: [{ id: 'a' }, { id: 'b' }] }
  const source = {
    fetchProbe: async () => original,
    fetchSeries: async () => {
      monitor.snapshot({ servers: [...original.servers].reverse() })
      monitor.snapshot(original)
      return { series: { cpu_pct: [{ t: Date.now() / 1000 - 10, value: 99 }] } }
    },
  }
  const monitor = new MonitorDataService(source)
  const id = monitor.snapshot(original).nodes[0].id
  await assert.rejects(monitor.getHistory(String(id), new URLSearchParams('series=metrics')), /node list changed/)
})

test('Monitor HTTP, shared realtime stream and authenticated configuration readback', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'monitor-api-'))
  const reservation = http.createServer()
  reservation.listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  const port = (reservation.address() as { port: number }).port
  await new Promise<void>(resolve => reservation.close(() => resolve()))
  const payload: ProbePayload = { title: 'MMWX Test', updatedAt: Date.now(), servers: [{ id: 7, name: 'Tokyo', cpu: 7 }, { id: 8, hidden: true }] }
  let snapshots = 0
  const source = {
    fetchProbe: async () => { snapshots += 1; return payload }, fetchSeries: async () => ({}),
    streamUrl: () => 'ws://127.0.0.1:1', probeHeaders: () => ({ 'X-MMwx-Probe-Token': 'secret-probe' }),
  }
  const hub = new ProbeStreamRelay(source)
  const monitor = new MonitorDataService(hub)
  const config = { mmwxOrigin: 'http://127.0.0.1:1', probeToken: 'secret-probe', themeRepo: 'https://github.com/test/theme', themeRef: 'main', themeGitProxy: '', adminToken: 'admin-secret' }
  const manifest = { short: 'doraemon', config: [{ key: 'interval', type: 'number', min: 1, max: 60, default: 3 }] }
  const store = new FileThemeSettingsStore(path.join(directory, 'settings.json'))
  const service = new KomariDataService(hub, { repoUrl: config.themeRepo, ref: 'main', themeShort: 'doraemon', themeManifest: manifest, themeSettings: { interval: 3 }, themeSettingsStore: store })
  const api = createApiRouter(service, { adminToken: config.adminToken, monitor, themeShort: 'doraemon' })
  const server = createHttpServer(config, { kind: 'monitor', short: 'doraemon', directory, indexPath: path.join(directory, 'index.html'), manifest, source: { repoUrl: config.themeRepo, ref: 'main' } }, api, hub, undefined, port, monitor)
  const sockets: WebSocket[] = []
  try {
    await server.listen()
    const base = `http://127.0.0.1:${port}`
    const me = await (await fetch(`${base}/api/me`)).json() as { authed: boolean; site_name: string }
    assert.equal(me.authed, false)
    assert.equal(me.site_name, 'MMWX Test')
    const nodes = await (await fetch(`${base}/api/nodes`)).json() as { nodes: unknown[] }
    assert.equal(nodes.nodes.length, 1)
    const frames = await Promise.all(['/api/ws', '/api/ws', '/api/stream'].map(async route => {
      const ws = new WebSocket(base.replace('http:', 'ws:') + route)
      sockets.push(ws)
      const [data] = await once(ws, 'message')
      return JSON.parse(data.toString())
    }))
    assert.deepEqual(frames[0], nodes)
    assert.deepEqual(frames[1], nodes)
    assert.deepEqual(frames[2], payload)
    assert.equal(snapshots, 1)
    assert.doesNotMatch(JSON.stringify(frames), /secret-probe/)
    const settingsUrl = `${base}/api/admin/theme/settings`
    assert.equal((await fetch(settingsUrl, { method: 'POST', body: '{"interval":5}' })).status, 401)
    const login = await fetch(`${base}/api/admin/auth/verify`, { method: 'POST', headers: { authorization: 'Bearer admin-secret' } })
    const cookie = login.headers.get('set-cookie')!.split(';')[0]
    const headers = { cookie, 'content-type': 'application/json' }
    assert.equal((await (await fetch(`${base}/api/me`, { headers })).json() as { authed: boolean }).authed, true)
    assert.equal((await fetch(settingsUrl, { method: 'POST', headers, body: '{"interval":999}' })).status, 400)
    assert.equal((await fetch(settingsUrl, { method: 'POST', headers, body: '{"interval":5}' })).status, 200)
    assert.deepEqual(await (await fetch(`${base}/api/themes/doraemon/config`)).json(), { interval: 5 })
    assert.deepEqual(await new FileThemeSettingsStore(path.join(directory, 'settings.json')).read(), { interval: 5 })
    assert.equal((await fetch(`${base}/api/themes/other/config`)).status, 404)
    assert.deepEqual(await (await fetch(`${base}/themes/doraemon/theme.json`)).json(), manifest)
    assert.equal((await fetch(`${base}/api/nodes`, { method: 'POST' })).status, 405)
  } finally {
    for (const ws of sockets) ws.terminate()
    await server.close()
    await rm(directory, { recursive: true, force: true })
  }
})
