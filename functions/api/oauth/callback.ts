interface Env {
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
  GOOGLE_REDIRECT_URI?: string
}

const NATIVE_CALLBACK = 'jp.ashiato.album://oauth/callback'

export const onRequestGet = async ({ request, env }: { request: Request; env: Env }): Promise<Response> => {
  const params = new URL(request.url).searchParams
  const state = params.get('state') ?? ''
  if (!/^[a-f0-9-]{36}$/i.test(state)) return new Response('Invalid OAuth state', { status: 400 })
  if (params.has('error')) return redirectToApp({ state, error: 'Google login was cancelled' })
  const code = params.get('code')
  if (!code) return new Response('Google did not return an authorization code', { status: 400 })
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REDIRECT_URI) {
    return new Response('Google OAuth is not configured', { status: 503 })
  }

  try {
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: env.GOOGLE_REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
    })
    const token = (await response.json()) as { access_token?: string; expires_in?: number; error?: string }
    if (!response.ok || !token.access_token || !token.expires_in) {
      console.error('Google OAuth code exchange failed', token.error ?? response.status)
      return redirectToApp({ state, error: 'Google token exchange failed' })
    }
    return redirectToApp({
      state,
      access_token: token.access_token,
      expires_in: String(token.expires_in),
    })
  } catch (error) {
    console.error('Google OAuth code exchange request failed', error)
    return redirectToApp({ state, error: 'Google token exchange failed' })
  }
}

function redirectToApp(values: Record<string, string>): Response {
  const target = `${NATIVE_CALLBACK}#${new URLSearchParams(values).toString()}`
  const body = `<!doctype html><meta name="referrer" content="no-referrer"><p>ashiatoアプリに戻っています…</p><a href="${target}">アプリに戻る</a><script>location.replace(${JSON.stringify(target)})</script>`
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
