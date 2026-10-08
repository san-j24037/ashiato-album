import {
  callGas,
  clearSessionCookie,
  createSessionToken,
  hashPassword,
  isRecord,
  isSameOriginRequest,
  normalizeEmail,
  readSessionCookie,
  sessionCookie,
  verifySessionToken,
  type Account,
  type AuthEnvironment,
} from '../_shared/account-auth'

interface Env extends AuthEnvironment {}

const PASSWORD_MIN_LENGTH = 12
const PASSWORD_MAX_LENGTH = 128
const DUMMY_SALT = Uint8Array.from([34, 91, 173, 10, 78, 220, 143, 51, 11, 199, 75, 244, 16, 29, 102, 208])
const DUMMY_HASH = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const MAX_BODY_BYTES = 16_384

export const onRequestGet = async ({ request, env }: { request: Request; env: Env }): Promise<Response> => {
  const token = readSessionCookie(request)
  const session = token ? await verifySessionToken(env, token) : null
  if (!session) return Response.json({ ok: true, user: null }, { headers: privateHeaders })
  return Response.json({
    ok: true,
    user: { id: session.id, name: session.name, email: session.email },
  }, { headers: privateHeaders })
}

export const onRequestPost = async ({ request, env }: { request: Request; env: Env }): Promise<Response> => {
  if (!isSameOriginRequest(request)) {
    return errorResponse('不正なリクエストです', 403)
  }

  const contentLength = Number(request.headers.get('content-length') ?? 0)
  if (contentLength > MAX_BODY_BYTES) return errorResponse('リクエストが大きすぎます', 413)

  let body: unknown
  try {
    const text = await request.text()
    if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) return errorResponse('リクエストが大きすぎます', 413)
    body = JSON.parse(text)
  } catch {
    return errorResponse('入力内容を読み取れませんでした', 400)
  }
  if (!isRecord(body) || typeof body.action !== 'string') return errorResponse('入力内容を確認してください', 400)

  if (body.action === 'logout') {
    return Response.json({ ok: true }, { headers: { ...privateHeaders, 'Set-Cookie': clearSessionCookie() } })
  }

  try {
    if (body.action === 'register') return await registerAccount(env, body)
    if (body.action === 'login') return await loginAccount(env, body)
    return errorResponse('操作を確認してください', 400)
  } catch (error) {
    console.error('Account authentication request failed', error)
    return errorResponse('認証サービスを利用できません。設定を確認してから再度お試しください', 503)
  }
}

async function registerAccount(env: Env, body: Record<string, unknown>): Promise<Response> {
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  const email = normalizeEmail(body.email)
  const password = typeof body.password === 'string' ? body.password : ''
  const hasControlCharacter = [...name].some((character) => {
    const code = character.charCodeAt(0)
    return code <= 0x1f || code === 0x7f
  })
  if (!name || name.length > 80 || hasControlCharacter) {
    return errorResponse('表示名は1〜80文字で入力してください', 400)
  }
  if (!email) return errorResponse('有効なメールアドレスを入力してください', 400)
  if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
    return errorResponse(`パスワードは${PASSWORD_MIN_LENGTH}〜${PASSWORD_MAX_LENGTH}文字で設定してください`, 400)
  }

  const passwordHash = await hashPassword(password)
  const account: Account = { id: crypto.randomUUID(), name, email }
  const result = await callGas(env, {
    action: 'accountRegister',
    account,
    passwordSalt: passwordHash.salt,
    passwordHash: passwordHash.hash,
  })
  if (result.ok !== true) {
    if (result.code === 'EMAIL_EXISTS') return errorResponse('このメールアドレスは登録済みです', 409)
    throw new Error(typeof result.error === 'string' ? result.error : 'Account creation failed')
  }
  return authenticatedResponse(env, account)
}

async function loginAccount(env: Env, body: Record<string, unknown>): Promise<Response> {
  const email = normalizeEmail(body.email)
  const password = typeof body.password === 'string' ? body.password : ''
  if (!email || password.length < 1 || password.length > PASSWORD_MAX_LENGTH) {
    await hashPassword('invalid-login-attempt', DUMMY_SALT)
    return errorResponse('メールアドレスまたはパスワードが正しくありません', 401)
  }

  const lookup = await callGas(env, { action: 'accountLookup', email })
  if (lookup.ok !== true) throw new Error('Account lookup failed')
  const storedUser = isRecord(lookup.user) ? lookup.user : null
  const saltValue = storedUser && typeof storedUser.passwordSalt === 'string' ? storedUser.passwordSalt : null
  const expectedHash = storedUser && typeof storedUser.passwordHash === 'string' ? storedUser.passwordHash : DUMMY_HASH
  const salt = saltValue ? decodeSalt(saltValue) : DUMMY_SALT
  const derived = await hashPassword(password, salt)
  const passwordMatches = constantTimeEqual(derived.hash, expectedHash)
  const lockUntil = storedUser && typeof storedUser.lockedUntil === 'number' ? storedUser.lockedUntil : 0

  if (!storedUser || !passwordMatches || lockUntil > Date.now()) {
    if (storedUser && lockUntil <= Date.now()) {
      const failure = await callGas(env, { action: 'accountLoginFailure', email })
      if (failure.ok !== true) throw new Error('Could not record failed login attempt')
    }
    return errorResponse('メールアドレスまたはパスワードが正しくありません', 401)
  }

  const success = await callGas(env, { action: 'accountLoginSuccess', email })
  if (success.ok !== true) throw new Error('Could not record successful login')
  const account: Account = {
    id: typeof storedUser.userId === 'string' ? storedUser.userId : '',
    email,
    name: typeof storedUser.displayName === 'string' ? storedUser.displayName : '',
  }
  if (!account.id || !account.name) throw new Error('Stored account profile is incomplete')
  return authenticatedResponse(env, account)
}

async function authenticatedResponse(env: Env, account: Account): Promise<Response> {
  const token = await createSessionToken(env, account)
  return Response.json(
    { ok: true, user: account },
    { headers: { ...privateHeaders, 'Set-Cookie': sessionCookie(token) } },
  )
}

function decodeSalt(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]{22}$/.test(value)) throw new Error('Stored password salt is invalid')
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/') + '=='
  const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))
  if (bytes.length !== 16) throw new Error('Stored password salt is invalid')
  return bytes
}

function constantTimeEqual(actual: string, expected: string): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/.test(expected)) return false
  let difference = actual.length ^ expected.length
  for (let index = 0; index < 43; index += 1) {
    difference |= (actual.charCodeAt(index) || 0) ^ expected.charCodeAt(index)
  }
  return difference === 0
}

function errorResponse(error: string, status: number): Response {
  return Response.json({ ok: false, error }, { status, headers: privateHeaders })
}

const privateHeaders = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
}
