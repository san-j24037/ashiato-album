import { isSameOriginRequest, readSessionCookie, verifySessionToken } from '../_shared/account-auth'

interface Env {
  GAS_EXEC_URL?: string
  GAS_SERVICE_KEY?: string
  APP_SESSION_SECRET?: string
}

const MAX_BODY_BYTES = 1_000_000
const responseHeaders = {
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
}

export const onRequestPost = async ({
  request,
  env,
}: {
  request: Request
  env: Env
}): Promise<Response> => {
  if (!isSameOriginRequest(request)) {
    return Response.json({ ok: false, error: 'Origin is not allowed' }, { status: 403, headers: responseHeaders })
  }

  const token = readSessionCookie(request)
  const session = token ? await verifySessionToken(env, token) : null
  if (!token || !session) {
    return Response.json({ ok: false, error: 'ログインの有効期限が切れました。再度ログインしてください' }, { status: 401, headers: responseHeaders })
  }
  if (!env.GAS_EXEC_URL || !env.GAS_SERVICE_KEY || !env.APP_SESSION_SECRET) {
    return Response.json({ ok: false, error: 'Account sync is not configured' }, { status: 503, headers: responseHeaders })
  }

  const contentLength = Number(request.headers.get('content-length') ?? 0)
  if (contentLength > MAX_BODY_BYTES) {
    return Response.json({ ok: false, error: 'Sync request exceeds the 1 MB limit' }, { status: 413, headers: responseHeaders })
  }

  const body = await request.text()
  if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) {
    return Response.json({ ok: false, error: 'Sync request exceeds the 1 MB limit' }, { status: 413, headers: responseHeaders })
  }

  let data: unknown
  try {
    data = JSON.parse(body)
  } catch {
    return Response.json({ ok: false, error: 'Sync request is not valid JSON' }, { status: 400, headers: responseHeaders })
  }

  try {
    const endpoint = new URL(env.GAS_EXEC_URL)
    if (endpoint.protocol !== 'https:' || endpoint.hostname !== 'script.google.com') {
      return Response.json({ ok: false, error: 'GAS_EXEC_URL must use the Google Apps Script HTTPS endpoint' }, { status: 500, headers: responseHeaders })
    }
    const upstream = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'sync', data, sessionToken: token, serviceKey: env.GAS_SERVICE_KEY }),
      redirect: 'follow',
    })
    const responseBody = await upstream.text()
    if (!upstream.ok) {
      console.error('GAS sync request failed', upstream.status)
      return Response.json({ ok: false, error: 'Account sync service is unavailable' }, { status: 502, headers: responseHeaders })
    }
    return new Response(responseBody, { headers: responseHeaders })
  } catch (error) {
    console.error('GAS sync request failed', error)
    return Response.json({ ok: false, error: 'Could not reach the GAS sync service' }, { status: 502, headers: responseHeaders })
  }
}

export const onRequestOptions = (): Response =>
  new Response(null, { status: 405, headers: { Allow: 'POST' } })

export const onRequestGet = (): Response =>
  Response.json({ ok: false, error: 'Use POST to synchronize data' }, { status: 405, headers: { Allow: 'POST' } })
