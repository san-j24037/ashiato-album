import {
  AuthServiceError,
  callGas,
  isRecord,
  isSameOriginRequest,
  readSessionCookie,
  verifySessionToken,
  type AuthEnvironment,
} from '../_shared/account-auth'

interface Env extends AuthEnvironment {}

const MAX_BODY_BYTES = 4_096
const headers = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
}

/** action → GAS action. Visibility checks happen in GAS; this only forwards validated input. */
const ACTIONS: Record<string, string> = {
  me: 'socialMe',
  setNickname: 'socialSetNickname',
  search: 'socialSearch',
  follow: 'socialFollow',
  unfollow: 'socialUnfollow',
  removeFollower: 'socialRemoveFollower',
  connections: 'socialConnections',
  profile: 'socialProfile',
  feed: 'socialFeed',
}

/**
 * POST /api/social  {action, nickname?, query?, kind?}
 * Nicknames, follows and the favorites / lists other users have shared with the caller.
 */
export const onRequestPost = async ({ request, env }: { request: Request; env: Env }): Promise<Response> => {
  if (!isSameOriginRequest(request)) return errorResponse('不正なリクエストです', 403)

  const token = readSessionCookie(request)
  const session = token ? await verifySessionToken(env, token) : null
  if (!token || !session) return errorResponse('ログインの有効期限が切れました。再度ログインしてください', 401)

  let body: unknown
  try {
    const text = await request.text()
    if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) return errorResponse('リクエストが大きすぎます', 413)
    body = JSON.parse(text)
  } catch {
    return errorResponse('入力内容を読み取れませんでした', 400)
  }
  if (!isRecord(body) || typeof body.action !== 'string' || !ACTIONS[body.action]) {
    return errorResponse('操作を確認してください', 400)
  }

  const text = (value: unknown, max: number) => (typeof value === 'string' ? value.trim().slice(0, max) : '')
  const payload: Record<string, unknown> = { action: ACTIONS[body.action], sessionToken: token }
  if ('nickname' in body) payload.nickname = text(body.nickname, 40)
  if ('query' in body) payload.query = text(body.query, 40)
  if ('kind' in body) payload.kind = body.kind === 'followers' ? 'followers' : 'following'

  try {
    const result = await callGas(env, payload)
    if (result.ok !== true) {
      const status = result.code === 'USER_NOT_FOUND' ? 404 : result.code === 'NICKNAME_TAKEN' ? 409 : 400
      const message = typeof result.error === 'string' && result.code ? result.error : 'SNSの処理に失敗しました'
      if (!result.code) console.error('GAS rejected social request', result.error)
      return Response.json({ ok: false, code: result.code, error: message }, { status, headers })
    }
    return Response.json(result, { headers })
  } catch (error) {
    console.error('Social request failed', error)
    const code = error instanceof AuthServiceError ? error.code : 'SOCIAL_INTERNAL_ERROR'
    return errorResponse(`SNSのサーバーに接続できません（${code}）`, 503)
  }
}

export const onRequestGet = (): Response =>
  Response.json({ ok: false, error: 'Use POST' }, { status: 405, headers: { ...headers, Allow: 'POST' } })

function errorResponse(error: string, status: number): Response {
  return Response.json({ ok: false, error }, { status, headers })
}
