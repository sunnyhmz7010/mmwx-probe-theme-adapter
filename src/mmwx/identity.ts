import type { ProbeServer } from './types.js'

// 优先使用上游身份；旧主控缺少 id 时退回 host/name，全部缺失才使用列表位置。
export function serverIdentity(server: ProbeServer, index: number): string {
  if (server.id !== undefined && String(server.id).trim()) return `id:${String(server.id).trim()}`
  if (server.host?.trim()) return `host:${server.host.trim()}`
  if (server.name?.trim()) return `name:${server.name.trim()}`
  return `index:${index}`
}
