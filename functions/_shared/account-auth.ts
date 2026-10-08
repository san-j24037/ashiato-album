export interface Account {
  id: string
  name: string
  email: string
}

export interface AuthEnvironment {
  GAS_EXEC_URL?: string
  GAS_SERVICE_KEY?: string
  APP_SESSION_SECRET?: string
}

export interface SessionClaims extends Account {
  sub: string
  exp: number
  iat: number
}

const SESSION_COOKIE = 'ashiato_session'
const SESSION_DURATION_SECONDS = 60 * 60 * 24 * 7
const HASH_ITERATIONS = 600_000
const encoder = new TextEncoder()

export async function callGas(env: AuthEnvironment, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!env.GAS_EXEC_URL || !env.GAS_SERVICE_KEY || !env.APP_SESSION_SECRET) {
    throw new Error('Authentication services are not configured')
  }
  let endpoint: URL
  try {
    endpoint = new URL(env.GAS_EXEC_URL)
  } catch {
    throw new Error('GAS_EXEC_URL must be an absolute HTTPS URL')
  }
  if (endpoint.protocol !== 'https:' || endpoint.hostname !== 'script.google.com') {
    throw new Error('GAS_EXEC_URL must use the Google Apps Script HTTPS endpoint')
  }
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ ...payload, serviceKey: env.GAS_SERVICE_KEY }),
    redirect: 'follow',
  })
  if (!response.ok) throw new Error('Account service is unavailable')
  const result: unknown = await response.json()
  if (!isRecord(result)) throw new Error('Account service returned an invalid response')
  return result
}

export async function hashPassword(password: string, salt?: Uint8Array): Promise<{ salt: string; hash: string }> {
  const actualSalt = salt ?? crypto.getRandomValues(new Uint8Array(16))
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: toArrayBuffer(actualSalt), iterations: HASH_ITERATIONS },
    key,
    256,
  )
  return { salt: toBase64Url(actualSalt), hash: toBase64Url(new Uint8Array(bits)) }
}

export async function createSessionToken(env: AuthEnvironment, account: Account): Promise<string> {
  if (!env.APP_SESSION_SECRET) throw new Error('Authentication services are not configured')
  const now = Math.floor(Date.now() / 1000)
  const claims: SessionClaims = {
    ...account,
    sub: account.id,
    iat: now,
    exp: now + SESSION_DURATION_SECONDS,
  }
  const content = `${toBase64Url(encoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })))}.${toBase64Url(encoder.encode(JSON.stringify(claims)))}`
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(env.APP_SESSION_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(content))
  return `${content}.${toBase64Url(new Uint8Array(signature))}`
}

export async function verifySessionToken(env: AuthEnvironment, token: string): Promise<SessionClaims | null> {
  if (!env.APP_SESSION_SECRET || token.length > 4096) return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(env.APP_SESSION_SECRET),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    )
    const valid = await crypto.subtle.verify('HMAC', key, toArrayBuffer(fromBase64Url(parts[2])), encoder.encode(`${parts[0]}.${parts[1]}`))
    if (!valid) return null
    const header: unknown = JSON.parse(new TextDecoder().decode(fromBase64Url(parts[0])))
    const claims: unknown = JSON.parse(new TextDecoder().decode(fromBase64Url(parts[1])))
    if (!isRecord(header) || header.alg !== 'HS256' || !isAccount(claims)) return null
    if (typeof claims.exp !== 'number' || claims.exp <= Date.now() / 1000) return null
    if (typeof claims.iat !== 'number' || claims.iat > Date.now() / 1000 + 60) return null
    return claims as unknown as SessionClaims
  } catch {
    return null
  }
}

export function readSessionCookie(request: Request): string | null {
  const cookies = request.headers.get('Cookie')
  if (!cookies) return null
  for (const part of cookies.split(';')) {
    const separator = part.indexOf('=')
    if (separator < 0 || part.slice(0, separator).trim() !== SESSION_COOKIE) continue
    try {
      return decodeURIComponent(part.slice(separator + 1).trim())
    } catch {
      return null
    }
  }
  return null
}

export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${SESSION_DURATION_SECONDS}; HttpOnly; Secure; SameSite=Lax`
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`
}

export function isSameOriginRequest(request: Request): boolean {
  const origin = request.headers.get('Origin')
  return origin === new URL(request.url).origin
}

export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const email = value.trim().toLowerCase()
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null
  return email
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isAccount(value: unknown): value is Account & Record<string, unknown> {
  return isRecord(value) &&
    typeof value.id === 'string' && value.id.length >= 16 && value.id.length <= 100 &&
    typeof value.name === 'string' && value.name.length > 0 && value.name.length <= 80 &&
    typeof value.email === 'string' && value.email.length <= 254
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid encoded value')
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)
  const binary = atob(base64)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  return buffer
}
