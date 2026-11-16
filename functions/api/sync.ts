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
      return Response.json({
        ok: false,
        error: `同期サーバー（GAS）がエラーを返しました（HTTP ${upstream.status}）。GASのデプロイが有効か、GAS_EXEC_URLが正しいか確認してください`,
      }, { status: 502, headers: responseHeaders })
    }
    // GAS answers with JSON; an HTML page means a login redirect or a Google error page.
    if (!/^\s*[{[]/.test(responseBody)) {
      const redirectedToLogin = /accounts\.google\.com/.test(upstream.url) || /ServiceLogin|accounts\.google\.com/.test(responseBody)
      const title = /<title>([^<]*)<\/title>/i.exec(responseBody)?.[1]?.trim()
      console.error('GAS returned a non-JSON response', upstream.status, upstream.url, title)
      return Response.json({
        ok: false,
        error: redirectedToLogin
          ? 'GASがGoogleログインを要求しました。Apps Scriptの「デプロイを管理」で「アクセスできるユーザー」を「全員」にして再デプロイしてください'
          : `GASが想定外の応答を返しました${title ? `（${title}）` : ''}。GASのデプロイと実行ログ（「実行数」）を確認してください`,
      }, { status: 502, headers: responseHeaders })
    }
    try {
      const parsed: unknown = JSON.parse(responseBody)
      if (parsed && typeof parsed === 'object' && 'ok' in parsed && parsed.ok === false) {
        const gasError = 'error' in parsed && typeof parsed.error === 'string' ? parsed.error : ''
        console.error('GAS rejected sync', gasError)
        return Response.json({ ok: false, error: explainGasError(gasError) }, { status: 502, headers: responseHeaders })
      }
    } catch {
      return Response.json({ ok: false, error: 'GASの応答を読み取れませんでした' }, { status: 502, headers: responseHeaders })
    }
    return new Response(responseBody, { headers: responseHeaders })
  } catch (error) {
    console.error('GAS sync request failed', error)
    return Response.json({ ok: false, error: 'Could not reach the GAS sync service' }, { status: 502, headers: responseHeaders })
  }
}

/** Turns the (English) GAS error into a Japanese cause + fix, keeping the original text. */
function explainGasError(error: string): string {
  const rules: [RegExp, string][] = [
    [/Request is not authorized/, 'GAS_SERVICE_KEYがCloudflareとGASのスクリプトプロパティで一致していません'],
    [/session is invalid|session is required|APP_SESSION_SECRET/i, 'APP_SESSION_SECRETがCloudflareとGASで一致していないか、ログインの有効期限が切れています。値を確認し、ログインし直してください'],
    [/SPREADSHEET_ID/, 'GASのスクリプトプロパティにSPREADSHEET_IDが設定されていません'],
    [/Unexpected columns in the (\w+) sheet/, 'スプレッドシートのシートの1行目（列名）がアプリの想定と違います。手で変更した列名を元に戻すか、空のシートにしてください'],
    [/legacy Spots sheet/, '「Spots」シートの1行目（列名）がアプリの想定と違います。手で作ったSpotsシートなら削除してください'],
    [/Database is busy/, '別の同期が処理中です。少し待ってからもう一度同期してください'],
    [/openById|not have permission|権限|Unexpected error while getting the method or property openById/i, 'GASからスプレッドシートを開けません。SPREADSHEET_IDが正しいか、GASの所有者がそのスプレッドシートを編集できるか確認してください'],
    [/maximum execution time|実行時間/i, 'GASの処理時間の上限（6分）を超えました'],
    [/cells|セル/i, 'スプレッドシートのセル数の上限に達しました'],
    [/too many times|使用回数/i, 'Googleのサービス利用回数の上限に達しました。時間をおいて再度お試しください'],
  ]
  const rule = rules.find(([pattern]) => pattern.test(error))
  const detail = error ? `（GAS: ${error}）` : ''
  return rule ? `${rule[1]}${detail}` : `同期サーバー（GAS）でエラーが発生しました${detail}`
}

export const onRequestOptions = (): Response =>
  new Response(null, { status: 405, headers: { Allow: 'POST' } })

export const onRequestGet = (): Response =>
  Response.json({ ok: false, error: 'Use POST to synchronize data' }, { status: 405, headers: { Allow: 'POST' } })
