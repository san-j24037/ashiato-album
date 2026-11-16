import { ArrowLeft, Check, RefreshCw, Search, UserMinus, UserPlus, Users } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { MarkBadge } from './FavoriteLists'
import { DEFAULT_MARK, VISIBILITY_LABELS, sanitizeMark } from './marks'
import type { Mark, PublicMemory, Visibility } from './types'

type SocialUser = {
  nickname: string
  followerCount: number
  followingCount: number
  isFollowing: boolean
  followsMe: boolean
  isMe: boolean
}

type SharedFavorite = PublicMemory & { visibility: Visibility; listName?: string; ownerNickname?: string }
type SharedList = { id: string; name: string; mark: Mark; visibility: Visibility; count: number }

type View =
  | { kind: 'home' }
  | { kind: 'profile'; nickname: string }
  | { kind: 'connections'; which: 'following' | 'followers' }

type SocialResponse = {
  ok: boolean
  error?: string
  code?: string
  me?: SocialUser
  user?: SocialUser
  users?: SocialUser[]
  profile?: SocialUser
  lists?: SharedList[]
  favorites?: SharedFavorite[]
}

async function callSocial(action: string, params: Record<string, unknown> = {}): Promise<SocialResponse> {
  const response = await fetch('/api/social', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...params }),
  })
  let result: SocialResponse
  try {
    result = await response.json() as SocialResponse
  } catch {
    throw new Error(`SNSのサーバーから想定外の応答がありました（HTTP ${response.status}）`)
  }
  if (!response.ok || !result.ok) throw new Error(result.error ?? `SNSの処理に失敗しました (${response.status})`)
  return result
}

function formatDate(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('ja-JP', { year: 'numeric', month: 'numeric', day: 'numeric' })
}

/**
 * The "みんな" tab: own nickname, user search, timeline of followed accounts, follow lists
 * and other users' profiles. Shared favorites are handed to the map through onShowFavorites.
 */
export function SocialPanel({
  initialProfile,
  onShowFavorites,
  onSelectFavorite,
}: {
  initialProfile?: string
  onShowFavorites(favorites: PublicMemory[] | null): void
  onSelectFavorite(favorite: PublicMemory): void
}) {
  const [me, setMe] = useState<SocialUser | null>(null)
  const [view, setView] = useState<View>(initialProfile ? { kind: 'profile', nickname: initialProfile } : { kind: 'home' })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [nicknameDraft, setNicknameDraft] = useState('')
  const [editingNickname, setEditingNickname] = useState(false)
  const [query, setQuery] = useState('')
  const [searchResults, setSearchResults] = useState<SocialUser[] | null>(null)
  const [feed, setFeed] = useState<SharedFavorite[] | null>(null)
  const [profile, setProfile] = useState<{ user: SocialUser; lists: SharedList[]; favorites: SharedFavorite[] } | null>(null)
  const [profileList, setProfileList] = useState('all')
  const [connections, setConnections] = useState<SocialUser[] | null>(null)

  const fail = (reason: unknown) => setError(reason instanceof Error ? reason.message : 'SNSの処理に失敗しました')

  // Initial load: own profile and the timeline.
  useEffect(() => {
    void callSocial('me').then((result) => setMe(result.me ?? null)).catch(fail)
    void callSocial('feed').then((result) => setFeed(result.favorites ?? [])).catch(fail)
  }, [])

  const loadProfile = useCallback((nickname: string) => callSocial('profile', { nickname })
    .then((result) => {
      if (!result.profile) throw new Error('プロフィールを読み込めませんでした')
      setProfile({ user: result.profile, lists: result.lists ?? [], favorites: result.favorites ?? [] })
    })
    .catch(fail), [])

  const loadConnections = useCallback((which: 'following' | 'followers') => callSocial('connections', { kind: which })
    .then((result) => setConnections(result.users ?? []))
    .catch(fail), [])

  useEffect(() => {
    if (view.kind === 'profile') void loadProfile(view.nickname)
    if (view.kind === 'connections') void loadConnections(view.which)
  }, [view, loadProfile, loadConnections])

  // What the map shows while this tab is open.
  const profileFavorites = useMemo(() => {
    if (!profile) return []
    return profileList === 'all' ? profile.favorites : profile.favorites.filter((favorite) => favorite.listId === profileList)
  }, [profile, profileList])
  useEffect(() => {
    if (view.kind === 'profile') onShowFavorites(profile ? profileFavorites : [])
    else if (view.kind === 'home') onShowFavorites(feed ?? [])
    else onShowFavorites(null)
  }, [view, profile, profileFavorites, feed, onShowFavorites])
  useEffect(() => () => onShowFavorites(null), [onShowFavorites])

  const open = (next: View) => {
    setError('')
    if (next.kind === 'profile') {
      setProfile(null)
      setProfileList('all')
    }
    if (next.kind === 'connections') setConnections(null)
    setView(next)
  }

  const saveNickname = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    void callSocial('setNickname', { nickname: nicknameDraft })
      .then((result) => {
        setMe(result.me ?? null)
        setEditingNickname(false)
      })
      .catch(fail)
      .finally(() => setBusy(false))
  }

  const search = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!query.trim()) return
    setBusy(true)
    setError('')
    void callSocial('search', { query })
      .then((result) => setSearchResults(result.users ?? []))
      .catch(fail)
      .finally(() => setBusy(false))
  }

  /** follow / unfollow / removeFollower, then refresh every place that shows the user. */
  const act = (action: 'follow' | 'unfollow' | 'removeFollower', user: SocialUser) => {
    if (action === 'removeFollower' && !window.confirm(`@${user.nickname} さんをフォロワーから外しますか？\n相手には通知されません。`)) return
    setBusy(true)
    setError('')
    void callSocial(action, { nickname: user.nickname })
      .then((result) => {
        const updated = result.user
        if (!updated) return
        const replace = (list: SocialUser[] | null) => list?.map((item) => item.nickname === user.nickname ? updated : item) ?? null
        setSearchResults(replace)
        setConnections((list) => action === 'removeFollower' ? list?.filter((item) => item.nickname !== user.nickname) ?? null : replace(list))
        if (view.kind === 'profile') void loadProfile(view.nickname)
        void callSocial('me').then((meResult) => setMe(meResult.me ?? null))
        if (action !== 'removeFollower') void callSocial('feed').then((feedResult) => setFeed(feedResult.favorites ?? []))
      })
      .catch(fail)
      .finally(() => setBusy(false))
  }

  const followButton = (user: SocialUser) => {
    if (user.isMe) return null
    if (user.isFollowing) {
      return <button type="button" className="secondary-button social-follow following" disabled={busy} onClick={() => act('unfollow', user)}><Check size={14} />フォロー中</button>
    }
    return (
      <button
        type="button"
        className="primary-button social-follow"
        disabled={busy || !me?.nickname}
        title={me?.nickname ? undefined : 'フォローするには、先に自分のニックネームを設定してください'}
        onClick={() => act('follow', user)}
      >
        <UserPlus size={14} />フォロー
      </button>
    )
  }

  const userRow = (user: SocialUser, extra?: React.ReactNode) => (
    <div className="social-user" key={user.nickname}>
      <button type="button" className="social-user-main" onClick={() => open({ kind: 'profile', nickname: user.nickname })}>
        <span className="social-avatar">{user.nickname.slice(0, 1)}</span>
        <span><strong>@{user.nickname}</strong><small>フォロワー {user.followerCount}{user.followsMe ? '・あなたをフォロー中' : ''}</small></span>
      </button>
      {extra}
      {followButton(user)}
    </div>
  )

  const favoriteCard = (favorite: SharedFavorite, showOwner: boolean) => {
    const mark = sanitizeMark(favorite.mark) ?? DEFAULT_MARK
    return (
      <button type="button" className="memory-card social-favorite" key={`${favorite.ownerNickname}:${favorite.id}`} onClick={() => onSelectFavorite(favorite)}>
        <MarkBadge mark={mark} size={34} />
        <span className="memory-card-text">
          <strong>{favorite.title}</strong>
          <small>{favorite.address || favorite.note || `${favorite.latitude.toFixed(4)}, ${favorite.longitude.toFixed(4)}`}</small>
          <small>
            {showOwner && <>@{favorite.ownerNickname || favorite.ownerName}・</>}
            {favorite.listName && <>{favorite.listName}・</>}
            {formatDate(favorite.createdAt)}
            {favorite.visibility === 'followers' && '・フォロワー限定'}
          </small>
        </span>
      </button>
    )
  }

  return (
    <section className="social-panel">
      {error && <p className="auth-error" role="alert">{error}</p>}

      {view.kind === 'home' && (
        <>
          <div className="panel-heading">
            <div><div className="section-kicker">COMMUNITY</div><h1>みんな</h1></div>
          </div>

          <div className="social-me">
            {me?.nickname && !editingNickname ? (
              <>
                <div className="social-me-head">
                  <span className="social-avatar large">{me.nickname.slice(0, 1)}</span>
                  <span><strong>@{me.nickname}</strong><button type="button" className="text-button" onClick={() => { setNicknameDraft(me.nickname); setEditingNickname(true) }}>ニックネームを変更</button></span>
                </div>
                <div className="social-counts">
                  <button type="button" onClick={() => open({ kind: 'connections', which: 'following' })}><strong>{me.followingCount}</strong>フォロー中</button>
                  <button type="button" onClick={() => open({ kind: 'connections', which: 'followers' })}><strong>{me.followerCount}</strong>フォロワー</button>
                  <button type="button" onClick={() => open({ kind: 'profile', nickname: me.nickname })}><Users size={14} />公開中の内容</button>
                </div>
              </>
            ) : me ? (
              <form className="social-nickname-form" onSubmit={saveNickname}>
                <strong>{me.nickname ? 'ニックネームを変更' : 'ニックネームを設定しましょう'}</strong>
                <small>ニックネームを設定すると、ほかの人をフォローしたり、フォローされたりできます。ほかの人にはニックネームだけが表示されます（メールアドレスや登録名は表示されません）。</small>
                <div className="social-inline">
                  <span className="social-at">@</span>
                  <input className="text-field" value={nicknameDraft} onChange={(event) => setNicknameDraft(event.target.value)} placeholder="例：tabi_hanako" maxLength={20} minLength={2} required />
                  <button className="primary-button" type="submit" disabled={busy}>保存</button>
                  {me.nickname && <button type="button" className="text-button" onClick={() => setEditingNickname(false)}>取消</button>}
                </div>
                <small>2〜20文字。文字・数字・アンダースコア（_）が使えます。ほかの人と同じものは使えません。</small>
              </form>
            ) : (
              <p className="small-muted">読み込み中…</p>
            )}
          </div>

          <form className="social-search" onSubmit={search}>
            <Search size={15} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="ニックネームでユーザーを検索" maxLength={20} />
            <button type="submit" disabled={busy || !query.trim()}>検索</button>
          </form>
          {searchResults && (
            <div className="social-users">
              {searchResults.map((user) => userRow(user))}
              {!searchResults.length && <p className="small-muted">見つかりませんでした。ニックネームを設定しているユーザーだけが検索できます。</p>}
            </div>
          )}

          <div className="list-header-row">
            <span className="section-kicker">TIMELINE</span>
            <button type="button" className="icon-button light" aria-label="タイムラインを更新" onClick={() => { setFeed(null); void callSocial('feed').then((result) => setFeed(result.favorites ?? [])).catch(fail) }}><RefreshCw size={15} /></button>
          </div>
          <div className="memories-list">
            {feed?.map((favorite) => favoriteCard(favorite, true))}
            {feed && !feed.length && <div className="empty-points"><div className="empty-icon"><Users size={22} /></div><strong>フォローした人の新着がここに並びます</strong><span>ニックネームで検索して、気になる人をフォローしましょう。</span></div>}
            {!feed && <p className="small-muted">読み込み中…</p>}
          </div>
        </>
      )}

      {view.kind === 'connections' && (
        <>
          <button type="button" className="social-back" onClick={() => open({ kind: 'home' })}><ArrowLeft size={15} />みんな</button>
          <div className="social-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={view.which === 'following'} className={view.which === 'following' ? 'selected' : ''} onClick={() => open({ kind: 'connections', which: 'following' })}>フォロー中</button>
            <button type="button" role="tab" aria-selected={view.which === 'followers'} className={view.which === 'followers' ? 'selected' : ''} onClick={() => open({ kind: 'connections', which: 'followers' })}>フォロワー</button>
          </div>
          <div className="social-users">
            {connections?.map((user) => userRow(user, view.which === 'followers' && (
              <button type="button" className="icon-button light" aria-label={`@${user.nickname} をフォロワーから外す`} title="フォロワーから外す" disabled={busy} onClick={() => act('removeFollower', user)}><UserMinus size={15} /></button>
            )))}
            {connections && !connections.length && <p className="small-muted">{view.which === 'following' ? 'まだ誰もフォローしていません。' : 'まだフォロワーはいません。'}</p>}
            {!connections && <p className="small-muted">読み込み中…</p>}
          </div>
        </>
      )}

      {view.kind === 'profile' && (
        <>
          <button type="button" className="social-back" onClick={() => open({ kind: 'home' })}><ArrowLeft size={15} />みんな</button>
          {!profile && <p className="small-muted">読み込み中…</p>}
          {profile && (
            <>
              <div className="social-profile-head">
                <span className="social-avatar large">{profile.user.nickname.slice(0, 1)}</span>
                <span>
                  <strong>@{profile.user.nickname}</strong>
                  <small>フォロー中 {profile.user.followingCount}・フォロワー {profile.user.followerCount}{profile.user.followsMe ? '・あなたをフォロー中' : ''}</small>
                </span>
                {followButton(profile.user)}
              </div>
              {profile.user.isMe && <p className="small-muted">ほかの人に公開している内容です（非公開のものは表示されません）。見える範囲は相手がフォロワーかどうかで変わります。</p>}
              {(profile.lists.length > 0 || profile.favorites.length > 0) && (
                <div className="list-filter" role="group" aria-label="リストで絞り込み">
                  <button type="button" className={profileList === 'all' ? 'selected' : ''} onClick={() => setProfileList('all')}>すべて<span className="chip-count">{profile.favorites.length}</span></button>
                  {profile.lists.map((list) => (
                    <button type="button" key={list.id} className={profileList === list.id ? 'selected' : ''} onClick={() => setProfileList(list.id)} title={VISIBILITY_LABELS[list.visibility]}>
                      <MarkBadge mark={sanitizeMark(list.mark) ?? DEFAULT_MARK} size={18} />{list.name}<span className="chip-count">{list.count}</span>
                    </button>
                  ))}
                </div>
              )}
              <div className="memories-list">
                {profileFavorites.map((favorite) => favoriteCard(favorite, false))}
                {!profileFavorites.length && (
                  <div className="empty-points">
                    <div className="empty-icon"><Users size={22} /></div>
                    <strong>公開されているお気に入りはありません</strong>
                    <span>{profile.user.isFollowing || profile.user.isMe ? '' : 'フォローすると、フォロワー限定の内容も見られます。'}</span>
                  </div>
                )}
              </div>
            </>
          )}
        </>
      )}
    </section>
  )
}
