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
  /** nativeUserIds the driver confirmed back. */
  confirmedIds: string[]
  /** Requests refused because they came from a page (an Origin header) or carried no Bearer. */
  refused: string[]
  close: () => Promise<void>
}

/**
 * Minimal stand-in for cfg-core-server's runtime-provision queue, so the service-GM
 * driver can run with NO real core-server:
 *   GET  /api/v1/installations/:id/foundry/pending-provisions?world=…  -> { data: [...] }
 *   POST /api/v1/installations/:id/foundry/pending-provisions/confirm  -> { ok: true }
 * Pending seats are served until confirmed.
 *
 * As strict as core is with the driver's page (cs#543): no CORS headers at all, and a
 * request carrying an Origin (one a page made) or no Bearer token is refused 403.
 */
export async function startStubCoreApi(pending: PendingProvision[]): Promise<StubCoreApi> {
  const confirmedIds: string[] = []
  const refused: string[] = []
  const server = http.createServer((req, res) => {
    const send = (code: number, body?: unknown): void => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(body === undefined ? '' : JSON.stringify(body))
    }
    const url = req.url ?? ''
    if (req.headers.origin || !/^Bearer \S+$/.test(req.headers.authorization ?? '')) {
      refused.push(`${req.method} ${url.split('?')[0]}`)
      return send(403, { error: 'Forbidden' })
    }
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
    refused,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
