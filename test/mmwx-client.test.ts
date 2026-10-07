import assert from 'node:assert/strict'
import { once } from 'node:events'
import http from 'node:http'
import { test } from 'node:test'
import { WebSocketServer } from 'ws'

import { MmwxClient, UpstreamError } from '../src/mmwx/client.js'
import type { AppConfig } from '../src/config.js'

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    mmwxOrigin: 'https://panel.example.com',
    probeToken: 'probe-secret',
    themeRepo: 'https://github.com/acme/theme',
    themeRef: 'main',
    themeGitProxy: '',
    ...overrides,
  }
}

async function withMockFetch<T>(handler: (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>, run: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch
  globalThis.fetch = handler as typeof fetch
  try {
    return await run()
  } finally {
    globalThis.fetch = originalFetch
  }
}

test('MMWX client fetches probe data from the fixed public route with only the probe token header', async () => {
  const seen: { url?: URL; headers?: Headers; signal?: AbortSignal } = {}
  await withMockFetch(async (input, init) => {
    seen.url = new URL(String(input))
    seen.headers = new Headers(init?.headers)
    seen.signal = init?.signal ?? undefined
    return Response.json({ servers: [] })
  }, async () => {
    const result = await new MmwxClient(config()).fetchProbe()
    assert.deepEqual(result, { servers: [] })
  })

  assert.equal(seen.url?.origin, 'https://panel.example.com')
  assert.equal(seen.url?.pathname, '/api/public/probe-servers')
  assert.equal(seen.url?.search, '')
  assert.equal(seen.headers?.get('X-MMwx-Probe-Token'), 'probe-secret')
  assert.equal(seen.headers?.has('cookie'), false)
  assert.equal(seen.headers?.has('authorization'), false)
  assert.ok(seen.signal instanceof AbortSignal)
})

test('MMWX client fetches series through the fixed path and forwards only query parameters', async () => {
  const calls: URL[] = []
  await withMockFetch(async (input) => {
    calls.push(new URL(String(input)))
    return Response.json({ pings: [], systems: [] })
  }, async () => {
    await new MmwxClient(config()).fetchSeries({
      hours: 1,
      uuid: 'mmwx-0',
      origin: 'https://evil.example',
    })
  })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].origin, 'https://panel.example.com')
  assert.equal(calls[0].pathname, '/api/public/probe-series')
  assert.equal(calls[0].searchParams.get('hours'), '1')
  assert.equal(calls[0].searchParams.get('uuid'), 'mmwx-0')
  assert.equal(calls[0].searchParams.has('origin'), false)
})

test('MMWX client wraps non-2xx HTTP responses without leaking the token', async () => {
  const token = 'leak-check-token'
  await withMockFetch(async () => new Response('upstream says no', { status: 503 }), async () => {
    await assert.rejects(
      () => new MmwxClient(config({ probeToken: token })).fetchProbe(),
      (error: unknown) => {
        if (!(error instanceof Error)) return false
        const statusCode = (error as { statusCode?: unknown }).statusCode
        return error instanceof UpstreamError
          && statusCode === 503
          && /probe-servers/.test(error.message)
          && !error.message.includes(token)
      },
    )
  })
})

test('MMWX client opens the fixed upstream WebSocket with the probe token header', async () => {
  const server = http.createServer()
  const wss = new WebSocketServer({ noServer: true })
  const observed: { url?: string; token?: string } = {}

  server.on('upgrade', (request, socket, head) => {
    observed.url = request.url
    observed.token = request.headers['x-mmwx-probe-token'] as string | undefined
    wss.handleUpgrade(request, socket, head, (ws) => {
      ws.send(JSON.stringify({ servers: [] }))
      ws.close()
    })
  })

  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address === 'object')

  const received: unknown[] = []
  await new Promise<void>((resolve, reject) => {
    const closeable = new MmwxClient(config({ mmwxOrigin: `http://127.0.0.1:${address.port}` })).openStream(
      (payload: unknown) => received.push(payload),
      () => resolve(),
    )
    setTimeout(() => {
      closeable.close()
      reject(new Error('timed out waiting for websocket close'))
    }, 2_000).unref()
  })

  await new Promise<void>((resolve) => wss.close(() => resolve()))
  await new Promise<void>((resolve) => server.close(() => resolve()))

  assert.equal(observed.url, '/api/public/probe-ws')
  assert.equal(observed.token, 'probe-secret')
  assert.deepEqual(received, [{ servers: [] }])
})
