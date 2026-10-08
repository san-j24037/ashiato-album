interface Env {
  GAS_EXEC_URL?: string
  APP_ORIGIN?: string
}

export const onRequestPost = async ({
  request,
  env,
}: {
  request: Request
  env: Env
}): Promise<Response> => {
  const headers = corsHeaders(request, env)
  if (request.headers.get('origin') && !headers['Access-Control-Allow-Origin']) {
    return Response.json({ ok: false, error: 'Origin is not allowed' }, { status: 403 })
  }
  if (!env.GAS_EXEC_URL) {
    return Response.json({ ok: false, error: 'GAS_EXEC_URL is not configured' }, { status: 503, headers })
  }

  const contentLength = Number(request.headers.get('content-length') ?? 0)
  if (contentLength > 1_000_000) {
    return Response.json({ ok: false, error: 'Sync request exceeds the 1 MB limit' }, { status: 413, headers })
  }

  const body = await request.text()
  if (body.length > 1_000_000) {
    return Response.json({ ok: false, error: 'Sync request exceeds the 1 MB limit' }, { status: 413, headers })
  }

  try {
    const upstream = await fetch(env.GAS_EXEC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body,
      redirect: 'follow',
    })
    const responseBody = await upstream.text()
    return new Response(responseBody, {
      status: upstream.status,
      headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    })
  } catch (error) {
    console.error('GAS sync request failed', error)
    return Response.json({ ok: false, error: 'Could not reach the GAS sync service' }, { status: 502, headers })
  }
}

export const onRequestOptions = ({ request, env }: { request: Request; env: Env }): Response => {
  const headers = corsHeaders(request, env)
  if (request.headers.get('origin') && !headers['Access-Control-Allow-Origin']) {
    return new Response(null, { status: 403 })
  }
  return new Response(null, { status: 204, headers: { ...headers, Allow: 'POST, OPTIONS' } })
}

export const onRequestGet = (): Response =>
  Response.json({ ok: false, error: 'Use POST to synchronize data' }, { status: 405, headers: { Allow: 'POST, OPTIONS' } })

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get('origin')
  if (!origin) return {}
  const pagesOrigin = new URL(request.url).origin
  const allowedOrigins = new Set([
    pagesOrigin,
    env.APP_ORIGIN,
    'capacitor://localhost',
    'https://localhost',
    'http://localhost',
  ])
  if (!allowedOrigins.has(origin)) return {}
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
}
