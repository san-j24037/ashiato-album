import L from 'leaflet'
import { ArrowLeft, Heart, Lock, Mail, MapPin, RefreshCw, Search, Users } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './AdminPage.css'

type AdminUser = {
  userId: string
  email: string
  displayName: string
  createdAt: string
  lastLoginAt: string
  failedAttempts: number
  lockedUntil: number
  pointCount: number
  lastPointAt: string
  favoriteCount: number
  publicFavoriteCount: number
}

type AdminPoint = { id: string; latitude: number; longitude: number; accuracy: number; recordedAt: string }

type AdminFavorite = {
  id: string
  title: string
  note: string
  address: string
  latitude: number
  longitude: number
  createdAt: string
  isPublic: boolean
  fileCount: number
}

type UserDetail = {
  user: AdminUser
  pointCount: number
  points: AdminPoint[]
  favorites: AdminFavorite[]
}

type ListResponse = { ok: boolean; error?: string; users?: AdminUser[]; mailQuotaRemaining?: number; mailQuotaReserve?: number }
type DetailResponse = { ok: boolean; error?: string } & Partial<UserDetail>

async function callAdmin<T extends { ok: boolean; error?: string }>(payload: Record<string, unknown>): Promise<T> {
  const response = await fetch('/api/admin', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const result = await response.json() as T
  if (!response.ok || !result.ok) throw new Error(result.error ?? `管理データを取得できませんでした (${response.status})`)
  return result
}

function formatDateTime(value: string): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export function AdminPage({ onClose }: { onClose: () => void }) {
  const [users, setUsers] = useState<AdminUser[]>([])
  const [mailQuota, setMailQuota] = useState<{ remaining: number; reserve: number } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<UserDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState('')
  const [loadedAt, setLoadedAt] = useState(0)

  // Fetches the user list; state is only updated after the request settles.
  const fetchUsers = useCallback(() => callAdmin<ListResponse>({ action: 'listUsers' })
    .then((result) => {
      setUsers(result.users ?? [])
      setLoadedAt(Date.now())
      setMailQuota(typeof result.mailQuotaRemaining === 'number'
        ? { remaining: result.mailQuotaRemaining, reserve: result.mailQuotaReserve ?? 0 }
        : null)
    })
    .catch((loadError: unknown) => {
      setError(loadError instanceof Error ? loadError.message : '管理データを取得できませんでした')
    })
    .finally(() => setLoading(false)), [])

  const loadUsers = () => {
    setLoading(true)
    setError('')
    void fetchUsers()
  }

  useEffect(() => {
    void fetchUsers()
  }, [fetchUsers])

  const openUser = async (userId: string) => {
    setSelectedId(userId)
    setDetail(null)
    setDetailError('')
    setDetailLoading(true)
    try {
      const result = await callAdmin<DetailResponse>({ action: 'userDetail', userId })
      if (!result.user) throw new Error('ユーザー情報を読み取れませんでした')
      setDetail({
        user: result.user,
        pointCount: result.pointCount ?? 0,
        points: result.points ?? [],
        favorites: result.favorites ?? [],
      })
    } catch (loadError) {
      setDetailError(loadError instanceof Error ? loadError.message : 'ユーザー情報を取得できませんでした')
    } finally {
      setDetailLoading(false)
    }
  }

  const filteredUsers = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    const sorted = [...users].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
    if (!keyword) return sorted
    return sorted.filter((user) => user.displayName.toLowerCase().includes(keyword) || user.email.toLowerCase().includes(keyword))
  }, [users, query])

  const totals = useMemo(() => users.reduce(
    (sum, user) => ({ points: sum.points + user.pointCount, favorites: sum.favorites + user.favoriteCount }),
    { points: 0, favorites: 0 },
  ), [users])

  return (
    <main className="admin-shell">
      <header className="admin-header">
        <button className="admin-back" type="button" onClick={onClose}><ArrowLeft size={17} />アプリに戻る</button>
        <div>
          <div className="section-kicker">ADMINISTRATION</div>
          <h1>管理者ページ</h1>
        </div>
        <button className="secondary-button admin-refresh" type="button" onClick={loadUsers} disabled={loading}>
          <RefreshCw size={15} />{loading ? '読み込み中…' : '再読み込み'}
        </button>
      </header>

      <section className="admin-stats" aria-label="全体の集計">
        <div className="admin-stat"><Users size={17} /><span>登録ユーザー</span><strong>{users.length.toLocaleString()}</strong></div>
        <div className="admin-stat"><MapPin size={17} /><span>GPS地点（合計）</span><strong>{totals.points.toLocaleString()}</strong></div>
        <div className="admin-stat"><Heart size={17} /><span>スポット（合計）</span><strong>{totals.favorites.toLocaleString()}</strong></div>
        <div className={`admin-stat ${mailQuota && mailQuota.remaining <= mailQuota.reserve ? 'warning' : ''}`}>
          <Mail size={17} />
          <span>本日のメール残り送信数</span>
          <strong>{mailQuota ? mailQuota.remaining.toLocaleString() : '—'}</strong>
          {mailQuota && <small>残り{mailQuota.reserve}通以下で再設定メールを停止</small>}
        </div>
      </section>

      {error && <p className="auth-error" role="alert">{error}</p>}

      <div className={`admin-body ${selectedId ? 'has-detail' : ''}`}>
        <section className="admin-users" aria-label="ユーザー一覧">
          <label className="admin-search">
            <Search size={15} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="名前・メールアドレスで検索" />
          </label>
          <div className="admin-user-list">
            {filteredUsers.map((user) => {
              const locked = user.lockedUntil > loadedAt
              return (
                <button
                  key={user.userId}
                  type="button"
                  className={`admin-user-row ${selectedId === user.userId ? 'selected' : ''}`}
                  onClick={() => void openUser(user.userId)}
                >
                  <span className="admin-avatar">{user.displayName.slice(0, 1)}</span>
                  <span className="admin-user-main">
                    <strong>{user.displayName}{locked && <span className="admin-badge danger"><Lock size={10} />ロック中</span>}</strong>
                    <small>{user.email}</small>
                    <small>最終ログイン {formatDateTime(user.lastLoginAt)}</small>
                  </span>
                  <span className="admin-user-counts">
                    <span><MapPin size={11} />{user.pointCount.toLocaleString()}</span>
                    <span><Heart size={11} />{user.favoriteCount.toLocaleString()}</span>
                  </span>
                </button>
              )
            })}
            {!loading && !filteredUsers.length && <p className="admin-empty">{query ? '該当するユーザーはいません' : '登録ユーザーはいません'}</p>}
          </div>
        </section>

        <section className="admin-detail" aria-label="ユーザー詳細">
          {!selectedId && <p className="admin-empty">左の一覧からユーザーを選ぶと、詳細を表示します。</p>}
          {selectedId && (
            <button className="admin-back admin-detail-back" type="button" onClick={() => setSelectedId(null)}>
              <ArrowLeft size={15} />一覧に戻る
            </button>
          )}
          {detailLoading && <p className="admin-empty">読み込み中…</p>}
          {detailError && <p className="auth-error" role="alert">{detailError}</p>}
          {detail && !detailLoading && <UserDetailView detail={detail} now={loadedAt} />}
        </section>
      </div>
    </main>
  )
}

function UserDetailView({ detail, now }: { detail: UserDetail; now: number }) {
  const { user } = detail
  const locked = user.lockedUntil > now
  return (
    <div className="admin-detail-content">
      <div className="admin-profile">
        <span className="admin-avatar large">{user.displayName.slice(0, 1)}</span>
        <div>
          <h2>{user.displayName}</h2>
          <p>{user.email}</p>
        </div>
      </div>
      <dl className="admin-facts">
        <div><dt>ユーザーID</dt><dd className="mono">{user.userId}</dd></div>
        <div><dt>登録日時</dt><dd>{formatDateTime(user.createdAt)}</dd></div>
        <div><dt>最終ログイン</dt><dd>{formatDateTime(user.lastLoginAt)}</dd></div>
        <div><dt>最終GPS記録</dt><dd>{formatDateTime(user.lastPointAt)}</dd></div>
        <div><dt>GPS地点</dt><dd>{detail.pointCount.toLocaleString()} 件</dd></div>
        <div><dt>スポット</dt><dd>{user.favoriteCount.toLocaleString()} 件（公開 {user.publicFavoriteCount}）</dd></div>
        <div><dt>ログイン失敗</dt><dd>{user.failedAttempts} 回{locked ? `（${formatDateTime(new Date(user.lockedUntil).toISOString())} までロック）` : ''}</dd></div>
      </dl>

      <AdminMap points={detail.points} favorites={detail.favorites} />
      {detail.pointCount > detail.points.length && (
        <p className="admin-note">地図と一覧には最新の {detail.points.length.toLocaleString()} 件を表示しています。</p>
      )}

      <h3>お気に入りスポット</h3>
      {detail.favorites.length ? (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead><tr><th>タイトル</th><th>住所・メモ</th><th>作成日時</th><th>公開</th><th>添付</th></tr></thead>
            <tbody>
              {detail.favorites.map((favorite) => (
                <tr key={favorite.id}>
                  <td>{favorite.title}</td>
                  <td>{favorite.address || favorite.note || `${favorite.latitude.toFixed(4)}, ${favorite.longitude.toFixed(4)}`}</td>
                  <td>{formatDateTime(favorite.createdAt)}</td>
                  <td>{favorite.isPublic ? '公開' : '—'}</td>
                  <td>{favorite.fileCount ? `${favorite.fileCount}件` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p className="admin-empty">スポットはありません。</p>}

      <h3>最近のGPS記録</h3>
      {detail.points.length ? (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead><tr><th>記録日時</th><th>緯度</th><th>経度</th><th>精度</th></tr></thead>
            <tbody>
              {detail.points.slice(0, 100).map((point) => (
                <tr key={point.id}>
                  <td>{formatDateTime(point.recordedAt)}</td>
                  <td>{point.latitude.toFixed(5)}</td>
                  <td>{point.longitude.toFixed(5)}</td>
                  <td>{Math.round(point.accuracy)} m</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p className="admin-empty">GPS記録はありません。</p>}
    </div>
  )
}

function AdminMap({ points, favorites }: { points: AdminPoint[]; favorites: AdminFavorite[] }) {
  const elementRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!elementRef.current) return
    const map = L.map(elementRef.current, { zoomControl: true, attributionControl: true })
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map)

    const ordered = [...points].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt))
    const route = ordered.map((point) => L.latLng(point.latitude, point.longitude))
    const bounds = L.latLngBounds([])
    if (route.length) {
      L.polyline(route, { color: '#397a69', weight: 3, opacity: 0.8 }).addTo(map)
      route.forEach((latLng) => bounds.extend(latLng))
    }
    favorites.forEach((favorite) => {
      const latLng = L.latLng(favorite.latitude, favorite.longitude)
      L.circleMarker(latLng, { radius: 7, color: '#fff', weight: 2, fillColor: '#d0645a', fillOpacity: 1 })
        .bindTooltip(favorite.title)
        .addTo(map)
      bounds.extend(latLng)
    })
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [24, 24], maxZoom: 16 })
    else map.setView([35.681, 139.767], 5)

    return () => {
      map.remove()
    }
  }, [points, favorites])

  return <div className="admin-map" ref={elementRef} role="img" aria-label="GPS経路とスポットの地図" />
}
