import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { once } from 'node:events'
import { test } from 'node:test'
import WebSocket from 'ws'

import { createApiRouter } from '../src/http/api.js'
import { createHttpServer } from '../src/http/server.js'
import { KomariDataService } from '../src/komari/service.js'
import { ProbeStreamRelay } from '../src/mmwx/stream-relay.js'
import type { AppConfig } from '../src/config.js'
import type { LoadedTheme } from '../src/theme/types.js'

interface Fixture {
  observed: {
    http: string[]
    websocket: string[]
    rpc2: string[]
  }
}

const baseConfig: AppConfig = {
  mmwxOrigin: 'http://127.0.0.1:0',
  probeToken: 'probe-secret',
  themeRepo: 'https://github.com/acme/theme',
  themeRef: 'main',
  themeGitProxy: '',
}

async function fixture(name: string): Promise<Fixture> {
  return JSON.parse(await readFile(path.join('test', 'fixtures', name), 'utf8')) as Fixture
}

async function reservePort(): Promise<number> {
  const server = http.createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return address.port
}

async function request(baseUrl: string, spec: string): Promise<Response> {
  const [method, pathname] = spec.split(' ')
  return await fetch(`${baseUrl}${pathname}`, { method })
}

async function runObservedFixture(file: string): Promise<void> {
  const observed = await fixture(file)
  const mmwx = {
    fetchProbe: async () => ({
      servers: [{
        name: 'node-0',
        online: true,
        cpu: 1,
        memory: 2,
        ping: [{ name: 'Google', value: 10 }],
      }],
    }),
    fetchSeries: async () => ({
      systems: [{ serverId: 0, points: [{ timestamp: '2026-08-21T00:00:00.000Z', cpu: 1 }] }],
    }),
    streamUrl: () => 'ws://127.0.0.1:1/api/public/probe-ws',
    probeHeaders: () => ({ 'X-MMwx-Probe-Token': 'probe-secret' }),
  } as never
  const hub = new ProbeStreamRelay(mmwx)
  const service = new KomariDataService(hub)
  const api = createApiRouter(service)
  const port = await reservePort()
  const theme: LoadedTheme = {
    directory: process.cwd(),
    indexPath: path.join(process.cwd(), 'package.json'),
    source: { repoUrl: 'https://github.com/acme/theme', ref: 'test' },
  }
  const server = createHttpServer(baseConfig, theme, api, hub, undefined, port)

  try {
    await server.listen()
    const baseUrl = `http://127.0.0.1:${port}`
    for (const spec of observed.observed.http) {
      if (spec === 'POST /api/rpc2') continue
      const response = await request(baseUrl, spec)
      assert.ok(response.status >= 200 && response.status < 500, `${spec} returned ${response.status}`)
      assert.equal(new URL(response.url).origin, baseUrl)
    }
    for (const method of observed.observed.rpc2) {
      const response = await fetch(`${baseUrl}/api/rpc2`, {
        method: 'POST',
        body: JSON.stringify({ jsonrpc: '2.0', id: method, method, params: { uuid: 'mmwx-0', hours: 1 } }),
      })
      assert.equal(response.status, 200)
      const body = await response.json() as { error?: unknown }
      assert.equal('error' in body, false, `${method} returned RPC error`)
    }
    if (observed.observed.websocket.includes('GET /api/rpc2')) {
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/api/rpc2`)
        ws.on('open', () => ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'rpc.ping', params: {} })))
        ws.once('message', (data) => {
          assert.deepEqual(JSON.parse(data.toString()), { jsonrpc: '2.0', id: 1, result: 'pong' })
          ws.close()
        })
        ws.once('close', resolve)
        ws.once('error', reject)
      })
    }
  } finally {
    await server.close()
  }
}

test('theme smoke: adhesive-note observed public API requests are supported', async () => {
  await runObservedFixture('theme-adhesive-note.json')
})

test('theme smoke: junimo observed public API requests are supported', async () => {
  await runObservedFixture('theme-junimo.json')
})
