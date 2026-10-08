interface Env {
  GOOGLE_CLIENT_ID?: string
  GOOGLE_REDIRECT_URI?: string
}

export const onRequestGet = ({ request, env }: { request: Request; env: Env }): Response => {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_REDIRECT_URI) {
    return new Response('Google OAuth is not configured', { status: 503 })
  }
  const state = new URL(request.url).searchParams.get('state')
  if (!state || !/^[a-f0-9-]{36}$/i.test(state)) {
    return new Response('Invalid OAuth state', { status: 400 })
  }

  const authorize = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  authorize.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: env.GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/drive.file',
    state,
    access_type: 'online',
    prompt: 'select_account',
  }).toString()
  return Response.redirect(authorize.toString(), 302)
}
