import http from 'node:http'
import type { AddressInfo } from 'node:net'

export interface PendingProvision {
  nativeUserId: string
  foundryUsername: string
  role: number
  password: string
}

export interface StubCoreApi {
  url: string
  /** nativeUserIds the plugin drain confirmed back. */
  confirmedIds: string[]
  close: () => Promise<void>
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'Content-Type,Authorization',
} as const

/**
 * Minimal stand-in for cfg-core-server's runtime-provision queue, so the in-world
 * plugin ProvisionDrain can run with NO real core-server:
 *   GET  /api/v1/installations/:id/foundry/pending-provisions?world=…  -> { data: [...] }
 *   POST /api/v1/installations/:id/foundry/pending-provisions/confirm  -> { ok: true }
 * Pending seats are served until confirmed. CORS-open (the drain fetches it from
 * the Foundry page's origin with an Authorization: Bearer header).
 */
export async function startStubCoreApi(pending: PendingProvision[]): Promise<StubCoreApi> {
  const confirmedIds: string[] = []
  const server = http.createServer((req, res) => {
    const send = (code: number, body?: unknown): void => {
      res.writeHead(code, { 'content-type': 'application/json', ...CORS })
      res.end(body === undefined ? '' : JSON.stringify(body))
    }
    const url = req.url ?? ''
    if (req.method === 'OPTIONS') return send(204)
    if (req.method === 'GET' && url.includes('/pending-provisions')) {
      return send(200, { data: pending.filter((p) => !confirmedIds.includes(p.nativeUserId)) })
    }
    if (req.method === 'POST' && url.includes('/pending-provisions/confirm')) {
      let raw = ''
      req.on('data', (c) => (raw += c))
      req.on('end', () => {
        try {
          const b = JSON.parse(raw || '{}') as { nativeUserId?: string }
          if (b.nativeUserId) confirmedIds.push(b.nativeUserId)
        } catch {
          /* ignore malformed body */
        }
        send(200, { ok: true })
      })
      return
    }
    send(404, { error: 'not found' })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://localhost:${port}`,
    confirmedIds,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
