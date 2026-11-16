import {
  AuthServiceError,
  callGas,
  isAdminEmail,
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

/**
 * POST /api/admin
 *   {action:"listUsers"}             → every registered user with record counts
 *   {action:"userDetail", userId}    → one user's profile, points and favorites
 * Only sessions whose email is listed in ADMIN_EMAILS may call it. Read only.
 */
export const onRequestPost = async ({ request, env }: { request: Request; env: Env }): Promise<Response> => {
  if (!isSameOriginRequest(request)) return errorResponse('不正なリクエストです', 403)

  const token = readSessionCookie(request)
  const session = token ? await verifySessionToken(env, token) : null
  if (!token || !session) return errorResponse('ログインの有効期限が切れました。再度ログインしてください', 401)
  if (!isAdminEmail(env, session.email)) return errorResponse('管理者権限がありません', 403)

  let body: unknown
  try {
    const text = await request.text()
    if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) return errorResponse('リクエストが大きすぎます', 413)
    body = JSON.parse(text)
  } catch {
    return errorResponse('入力内容を読み取れませんでした', 400)
  }
  if (!isRecord(body) || typeof body.action !== 'string') return errorResponse('操作を確認してください', 400)

  try {
    if (body.action === 'listUsers') {
      return proxy(await callGas(env, { action: 'adminListUsers', sessionToken: token }))
    }
    if (body.action === 'userDetail') {
      const userId = typeof body.userId === 'string' ? body.userId : ''
      if (!/^[a-f0-9-]{36}$/i.test(userId)) return errorResponse('ユーザーIDが正しくありません', 400)
      const result = await callGas(env, { action: 'adminUserDetail', sessionToken: token, userId })
      if (result.ok !== true && result.code === 'USER_NOT_FOUND') return errorResponse('ユーザーが見つかりません', 404)
      return proxy(result)
    }
    return errorResponse('操作を確認してください', 400)
  } catch (error) {
    console.error('Admin request failed', error)
    const code = error instanceof AuthServiceError ? error.code : 'ADMIN_INTERNAL_ERROR'
    return errorResponse(`管理データを取得できません（${code}）`, 503)
  }
}

export const onRequestGet = (): Response =>
  Response.json({ ok: false, error: 'Use POST' }, { status: 405, headers: { ...headers, Allow: 'POST' } })

function proxy(result: Record<string, unknown>): Response {
  if (result.ok !== true) {
    console.error('GAS rejected admin request', result.error)
    return errorResponse('管理データを取得できませんでした', 502)
  }
  return Response.json(result, { headers })
}

function errorResponse(error: string, status: number): Response {
  return Response.json({ ok: false, error }, { status, headers })
}
