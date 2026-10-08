import { Capacitor, registerPlugin } from '@capacitor/core'
import { App as CapacitorApp } from '@capacitor/app'
import { Browser } from '@capacitor/browser'
import type { BackgroundGeolocationPlugin, Location } from '@capacitor-community/background-geolocation'
import { LocalNotifications } from '@capacitor/local-notifications'
import L from 'leaflet'
import {
  Camera,
  Check,
  ChevronDown,
  CircleHelp,
  Cloud,
  Compass,
  Crosshair,
  Footprints,
  Heart,
  LocateFixed,
  MapPin,
  Menu,
  Navigation,
  Pause,
  Play,
  Plus,
  Settings2,
  ShieldCheck,
  Sparkles,
  Upload,
  Video,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import 'leaflet/dist/leaflet.css'
import './App.css'
import { loadAccountData, loadAppState, saveAppData, setActiveAccount } from './data'
import { emptyAppData, type AppData, type Memory, type TrackPoint } from './types'

const BackgroundGeolocation = registerPlugin<BackgroundGeolocationPlugin>('BackgroundGeolocation')
const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, '')
const INTERVAL_KEY = 'ashiato-record-interval'
const intervals = [
  { seconds: 10, label: '10秒ごと', detail: '経路を細かく残す' },
  { seconds: 30, label: '30秒ごと', detail: 'バランス重視' },
  { seconds: 60, label: '1分ごと', detail: '記録を控えめに' },
]

type Tab = 'map' | 'spots' | 'settings'
type SyncResponse = { ok: boolean; error?: string; data?: AppData }

function readInterval() {
  const value = Number(localStorage.getItem(INTERVAL_KEY))
  return intervals.some((option) => option.seconds === value) ? value : 10
}

function MapView({
  points,
  memories,
  active,
  onSelect,
  onAddPoint,
  centerRequest,
}: {
  points: TrackPoint[]
  memories: Memory[]
  active: boolean
  onSelect(memory: Memory): void
  onAddPoint(point: TrackPoint): void
  centerRequest: [number, number] | null
}) {
  const elementRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const layerRef = useRef<L.LayerGroup | null>(null)
  const userMarkerRef = useRef<L.CircleMarker | null>(null)
  const lastCenteredIdRef = useRef<string | null>(null)
  const pointsRef = useRef(points)

  useEffect(() => {
    if (!elementRef.current) return
    const map = L.map(elementRef.current, { zoomControl: false, attributionControl: true })
      .setView([35.6812, 139.7671], 13)
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map)
    L.control.zoom({ position: 'bottomright' }).addTo(map)
    const layers = L.layerGroup().addTo(map)
    mapRef.current = map
    layerRef.current = layers
    map.on('click', (event: L.LeafletMouseEvent) => {
      const nearest = [...pointsRef.current].reverse().find((point) => {
        const distance = map.distance(event.latlng, [point.latitude, point.longitude])
        return distance < 120
      })
      if (nearest) onAddPoint(nearest)
    })
    const resizeObserver = new ResizeObserver(() => map.invalidateSize({ pan: false }))
    resizeObserver.observe(elementRef.current)
    return () => {
      resizeObserver.disconnect()
      map.remove()
      mapRef.current = null
      layerRef.current = null
    }
  }, [onAddPoint])

  useEffect(() => {
    pointsRef.current = points
    const map = mapRef.current
    const layers = layerRef.current
    if (!map || !layers) return
    layers.clearLayers()
    if (points.length > 1) {
      L.polyline(points.map((point) => [point.latitude, point.longitude]), {
        color: '#397a69',
        weight: 5,
        opacity: 0.86,
        lineCap: 'round',
        lineJoin: 'round',
      }).addTo(layers)
    }
    for (const point of points) {
      L.circleMarker([point.latitude, point.longitude], {
        radius: 5,
        color: '#fff',
        weight: 2,
        fillColor: '#4b8978',
        fillOpacity: 1,
      })
        .bindTooltip(new Date(point.recordedAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }))
        .addTo(layers)
    }
    for (const memory of memories) {
      const icon = L.divIcon({
        className: 'memory-marker',
        html: '<span>♥</span>',
        iconSize: [36, 42],
        iconAnchor: [18, 38],
      })
      L.marker([memory.latitude, memory.longitude], { icon })
        .bindTooltip(memory.title)
        .on('click', () => onSelect(memory))
        .addTo(layers)
    }
    const lastPoint = points[points.length - 1]
    if (lastPoint) {
      if (!userMarkerRef.current) {
        userMarkerRef.current = L.circleMarker([lastPoint.latitude, lastPoint.longitude], {
          radius: 9,
          color: '#fff',
          weight: 4,
          fillColor: '#438a75',
          fillOpacity: 1,
        }).addTo(map)
      } else {
        userMarkerRef.current.setLatLng([lastPoint.latitude, lastPoint.longitude])
      }
    } else if (userMarkerRef.current) {
      userMarkerRef.current.remove()
      userMarkerRef.current = null
    }
    if (points.length && points[points.length - 1].id !== lastCenteredIdRef.current) {
      const latest = points[points.length - 1]
      map.setView([latest.latitude, latest.longitude], Math.max(map.getZoom(), 14), { animate: true })
      lastCenteredIdRef.current = latest.id
    }
  }, [points, memories, onSelect])

  useEffect(() => {
    if (centerRequest && mapRef.current) mapRef.current.setView(centerRequest, Math.max(mapRef.current.getZoom(), 14))
  }, [centerRequest])

  return (
    <div className="map-canvas">
      <div ref={elementRef} className="leaflet-map" aria-label="訪れた場所の地図" />
      <div className={`map-status ${active ? 'is-recording' : ''}`}>
        <span className="status-dot" />
        {active ? '足跡を記録中' : '記録は停止中'}
      </div>
      <div className="map-hint">
        <Compass size={15} />
        {points.length ? `${points.length.toLocaleString()}件の記録地点` : '旅の足跡がここに並びます'}
      </div>
    </div>
  )
}

function App() {
  const [data, setData] = useState<AppData>(emptyAppData)
  const [dataLoaded, setDataLoaded] = useState(false)
  const [accountSub, setAccountSub] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('map')
  const [active, setActive] = useState(false)
  const [intervalSeconds, setIntervalSeconds] = useState(readInterval)
  const [identityToken, setIdentityToken] = useState<string | null>(null)
  const [accessToken, setAccessToken] = useState<string | null>(null)
  const [accessTokenExpiresAt, setAccessTokenExpiresAt] = useState(0)
  const [showGoogleLogin, setShowGoogleLogin] = useState(false)
  const [googleReady, setGoogleReady] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [message, setMessage] = useState('')
  const [selectedMemory, setSelectedMemory] = useState<Memory | null>(null)
  const [selectedPoint, setSelectedPoint] = useState<TrackPoint | null>(null)
  const [showSaveDialog, setShowSaveDialog] = useState(false)
  const [spotTitle, setSpotTitle] = useState('')
  const [spotNote, setSpotNote] = useState('')
  const [nativeWatcherId, setNativeWatcherId] = useState<string | null>(null)
  const nativeWatcherRef = useRef<string | null>(null)
  const [hasSynced, setHasSynced] = useState(false)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [centerRequest, setCenterRequest] = useState<[number, number] | null>(null)
  const mediaInputRef = useRef<HTMLInputElement>(null)
  const googleButtonRef = useRef<HTMLDivElement>(null)
  const webWatchId = useRef<number | null>(null)
  const intervalRef = useRef(intervalSeconds)
  const lastAcceptedTimeRef = useRef(0)
  const pendingOAuthStateRef = useRef<string | null>(null)
  const syncDataRef = useRef<(token: string | null) => Promise<void>>(async () => {})

  useEffect(() => {
    let cancelled = false
    void loadAppState().then(({ data: saved, accountSub: savedAccountSub }) => {
      if (!cancelled) {
        setData(saved)
        setAccountSub(savedAccountSub)
        setDataLoaded(true)
      }
    }).catch((error: unknown) => {
      console.error('足跡データを読み込めませんでした。', error)
      if (!cancelled) {
        setDataLoaded(true)
        setMessage('端末内の記録を読み込めませんでした')
      }
    })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (dataLoaded) {
      void saveAppData(data, accountSub).catch((error: unknown) => {
        console.error('足跡データを保存できませんでした。', error)
        setMessage('端末内にデータを保存できませんでした')
      })
    }
  }, [data, dataLoaded, accountSub])
  useEffect(() => {
    intervalRef.current = intervalSeconds
    localStorage.setItem(INTERVAL_KEY, String(intervalSeconds))
  }, [intervalSeconds])

  const acceptLocation = useCallback((latitude: number, longitude: number, accuracy: number, time: number) => {
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || time <= lastAcceptedTimeRef.current) return
    if (time - lastAcceptedTimeRef.current < intervalRef.current * 1000) return
    lastAcceptedTimeRef.current = time
    const point: TrackPoint = {
      id: crypto.randomUUID(),
      latitude,
      longitude,
      accuracy,
      recordedAt: new Date(time).toISOString(),
    }
    setData((current) => ({ ...current, points: [...current.points, point] }))
  }, [])

  const stopTracking = useCallback(async () => {
    try {
      if (nativeWatcherId) {
        await BackgroundGeolocation.removeWatcher({ id: nativeWatcherId })
        nativeWatcherRef.current = null
        setNativeWatcherId(null)
      } else if (webWatchId.current !== null) {
        navigator.geolocation.clearWatch(webWatchId.current)
        webWatchId.current = null
      }
      setActive(false)
      setMessage('GPS記録を停止しました')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'GPS記録を停止できませんでした')
    }
  }, [nativeWatcherId])

  const startTracking = useCallback(async () => {
    if (active) return
    if (!Capacitor.isNativePlatform() && !navigator.geolocation) {
      setMessage('この端末では位置情報を利用できません')
      return
    }
    setMessage('')
    let notificationWarning = false
    try {
      if (Capacitor.isNativePlatform()) {
        const notificationPermission = Capacitor.getPlatform() === 'android'
          ? await LocalNotifications.requestPermissions()
          : null
        notificationWarning = notificationPermission !== null && notificationPermission.display !== 'granted'
        const watcherId = await BackgroundGeolocation.addWatcher(
          {
            backgroundMessage: '足跡アルバムが移動経路を記録しています',
            backgroundTitle: '足跡を記録中',
            requestPermissions: true,
            stale: false,
            distanceFilter: 0,
          },
          (location?: Location, error?: Error) => {
            if (error) {
              setMessage(`位置情報を取得できません: ${error.message}`)
              return
            }
            if (location) {
              acceptLocation(location.latitude, location.longitude, location.accuracy, location.time ?? Date.now())
            }
          },
        )
        nativeWatcherRef.current = watcherId
        setNativeWatcherId(watcherId)
      } else {
        webWatchId.current = navigator.geolocation.watchPosition(
          ({ coords, timestamp }) => acceptLocation(coords.latitude, coords.longitude, coords.accuracy, timestamp),
          (error) => setMessage(`位置情報を取得できません: ${error.message}`),
          { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 },
        )
      }
      setActive(true)
      setMessage(notificationWarning
        ? '通知を許可すると、Androidでバックグラウンド記録中の通知が表示されます'
        : Capacitor.isNativePlatform() ? 'アプリを閉じている間も記録します' : 'この画面を開いている間、記録します')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'GPS記録を開始できませんでした')
    }
  }, [acceptLocation, active])

  const onAddPoint = useCallback((point: TrackPoint) => {
    setSelectedPoint(point)
    setShowSaveDialog(true)
    setSpotTitle('')
    setSpotNote('')
  }, [])

  const onSelectMemory = useCallback((memory: Memory) => setSelectedMemory(memory), [])

  const addMemory = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!selectedPoint || !spotTitle.trim()) return
    const memory: Memory = {
      id: crypto.randomUUID(),
      title: spotTitle.trim(),
      note: spotNote.trim(),
      latitude: selectedPoint.latitude,
      longitude: selectedPoint.longitude,
      createdAt: new Date().toISOString(),
      driveFiles: [],
    }
    setData((current) => ({ ...current, memories: [...current.memories, memory] }))
    setShowSaveDialog(false)
    setMessage(`「${memory.title}」をスポットに保存しました`)
  }

  const requestDriveToken = useCallback((): Promise<string> => {
    return new Promise((resolve, reject) => {
      if (Capacitor.isNativePlatform()) {
        if (accessToken && accessTokenExpiresAt > Date.now() + 30_000) resolve(accessToken)
        else reject(new Error('Google Driveの利用期限が切れました。Googleアカウントに再ログインしてください'))
        return
      }
      if (!CLIENT_ID || !window.google?.accounts.oauth2) {
        reject(new Error('Google Drive連携を使うには VITE_GOOGLE_CLIENT_ID の設定が必要です'))
        return
      }
      const client = window.google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: 'https://www.googleapis.com/auth/drive.file',
        callback: (response) => {
          if (response.error) reject(new Error(response.error))
          else {
            setAccessToken(response.access_token)
            setAccessTokenExpiresAt(Date.now() + response.expires_in * 1000)
            resolve(response.access_token)
          }
        },
      })
      client.requestAccessToken({ prompt: accessToken ? '' : 'consent' })
    })
  }, [accessToken, accessTokenExpiresAt])

  const uploadMedia = async (file: File) => {
    if (!selectedMemory) return
    try {
      setMessage('Google Driveへアップロードしています…')
      const token = await requestDriveToken()
      const metadata = { name: file.name, mimeType: file.type }
      const mimeType = file.type || 'application/octet-stream'
      const session = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,mimeType', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Type': mimeType,
          'X-Upload-Content-Length': String(file.size),
        },
        body: JSON.stringify({ name: metadata.name, mimeType }),
      })
      if (!session.ok) throw new Error(`Driveへの保存を開始できませんでした (${session.status})`)
      const uploadUrl = session.headers.get('Location')
      if (!uploadUrl) throw new Error('Google Driveからアップロード先が返されませんでした')
      const response = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': mimeType },
        body: file,
      })
      if (!response.ok) throw new Error(`Driveへの保存に失敗しました (${response.status})`)
      const saved = (await response.json()) as { id: string; name: string; mimeType: string; webViewLink?: string }
      const driveFile = {
        id: saved.id,
        name: saved.name,
        mimeType: saved.mimeType,
        url: `https://drive.google.com/file/d/${encodeURIComponent(saved.id)}/view`,
      }
      setData((current) => ({
        ...current,
        memories: current.memories.map((memory) =>
          memory.id === selectedMemory.id ? { ...memory, driveFiles: [...memory.driveFiles, driveFile] } : memory,
        ),
      }))
      setSelectedMemory((current) => current ? { ...current, driveFiles: [...current.driveFiles, driveFile] } : current)
      setMessage('Google Driveに保存しました')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'メディアを保存できませんでした')
    }
  }

  const syncData = async (token = identityToken) => {
    if (!token) {
      setMessage('先にGoogleアカウントでログインしてください')
      return
    }
    syncDataRef.current = syncData
    setSyncing(true)
    setMessage('')
    try {
      const tokenPayload = token.split('.')[1]
      if (!tokenPayload) throw new Error('Googleログイン情報を確認できませんでした')
      const claims = JSON.parse(atob(tokenPayload.replace(/-/g, '+').replace(/_/g, '/'))) as { sub?: string }
      if (!claims.sub) throw new Error('Googleログイン情報にアカウントIDがありません')
      const targetSub = claims.sub
      const uploadData = accountSub && accountSub !== targetSub ? await loadAccountData(targetSub) : data
      const batchCount = Math.max(1, Math.ceil(uploadData.points.length / 3000), Math.ceil(uploadData.memories.length / 100))
      let remoteData: AppData | undefined
      let synchronizedData: AppData | undefined
      for (let index = 0; index < batchCount; index += 1) {
        const pointBatch = uploadData.points.slice(index * 3000, (index + 1) * 3000)
        const memoryBatch = uploadData.memories.slice(index * 100, (index + 1) * 100)
        const response = await fetch(`${API_BASE_URL ?? ''}/api/sync`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idToken: token, data: { points: pointBatch, memories: memoryBatch } }),
        })
        const result = (await response.json()) as SyncResponse
        if (!response.ok || !result.ok) throw new Error(result.error ?? `同期に失敗しました (${response.status})`)
        remoteData = result.data
      }
      if (remoteData) {
        const points = new Map([...remoteData.points, ...uploadData.points].map((point) => [point.id, point]))
        const memories = new Map([...remoteData.memories, ...uploadData.memories].map((memory) => [memory.id, memory]))
        synchronizedData = { points: [...points.values()], memories: [...memories.values()] }
      }
      await setActiveAccount(targetSub)
      setAccountSub(targetSub)
      if (synchronizedData) setData(synchronizedData)
      setHasSynced(true)
      setMessage('Googleアカウントに同期しました')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '同期に失敗しました')
    } finally {
      setSyncing(false)
    }
  }

  const signIn = () => {
    if (Capacitor.isNativePlatform()) {
      if (!API_BASE_URL) {
        setMessage('ネイティブ版には VITE_API_BASE_URL の設定が必要です')
        return
      }
      const state = crypto.randomUUID()
      pendingOAuthStateRef.current = state
      localStorage.setItem('ashiato-pending-oauth-state', state)
      const startUrl = `${API_BASE_URL}/api/oauth/start?state=${encodeURIComponent(state)}`
      setMessage('Googleログインを開いています…')
      void Browser.open({ url: startUrl }).catch((error: unknown) => {
        pendingOAuthStateRef.current = null
        localStorage.removeItem('ashiato-pending-oauth-state')
        setMessage(error instanceof Error ? error.message : 'Googleログインを開けませんでした')
      })
      return
    }
    setShowGoogleLogin(true)
  }

  useEffect(() => {
    let cancelled = false
    let removeListener: (() => void) | undefined
    const handleOAuthUrl = (url: string) => {
      if (!url.startsWith('jp.ashiato.album://oauth/callback')) return
      const callback = new URL(url)
      const values = new URLSearchParams(callback.hash.slice(1))
      const expectedState = pendingOAuthStateRef.current ?? localStorage.getItem('ashiato-pending-oauth-state')
      if (!expectedState) return
      if (values.get('state') !== expectedState) {
        setMessage('Googleログインの状態を確認できませんでした')
        return
      }
      if (values.has('error')) {
        pendingOAuthStateRef.current = null
        localStorage.removeItem('ashiato-pending-oauth-state')
        setMessage(values.get('error') ?? 'Googleログインに失敗しました')
        void Browser.close()
        return
      }
      const token = values.get('id_token')
      const driveToken = values.get('access_token')
      const expiresIn = Number(values.get('expires_in'))
      pendingOAuthStateRef.current = null
      localStorage.removeItem('ashiato-pending-oauth-state')
      if (!token || !driveToken || !Number.isFinite(expiresIn) || expiresIn <= 0) {
        setMessage('Googleログインに失敗しました。もう一度お試しください')
        return
      }
      setIdentityToken(token)
      setAccessToken(driveToken)
      setAccessTokenExpiresAt(Date.now() + expiresIn * 1000)
      void Browser.close()
      void syncDataRef.current(token)
    }
    void CapacitorApp.addListener('appUrlOpen', ({ url }) => handleOAuthUrl(url)).then((listener) => {
      if (cancelled) void listener.remove()
      else removeListener = () => { void listener.remove() }
    })
    void CapacitorApp.getLaunchUrl().then((launchUrl) => {
      if (launchUrl?.url) handleOAuthUrl(launchUrl.url)
    })
    return () => {
      cancelled = true
      removeListener?.()
    }
  }, [])

  useEffect(() => {
    if (Capacitor.isNativePlatform()) return
    const script = document.createElement('script')
    script.id = 'google-identity-services'
    script.src = 'https://accounts.google.com/gsi/client'
    script.async = true
    script.defer = true
    script.onload = () => setGoogleReady(true)
    script.onerror = () => setMessage('Googleログインを読み込めませんでした。ネットワークを確認してください')
    document.head.appendChild(script)
    return () => script.remove()
  }, [])

  useEffect(() => {
    if (!showGoogleLogin || !googleReady || !CLIENT_ID || !window.google || !googleButtonRef.current) return
    googleButtonRef.current.replaceChildren()
    window.google.accounts.id.initialize({
      client_id: CLIENT_ID,
      callback: (response) => {
        setIdentityToken(response.credential)
        setShowGoogleLogin(false)
        void syncDataRef.current(response.credential)
      },
    })
    window.google.accounts.id.renderButton(googleButtonRef.current, {
      theme: 'outline',
      size: 'large',
      shape: 'pill',
      text: 'signin_with',
      locale: 'ja',
      width: 260,
    })
  }, [showGoogleLogin, googleReady])

  useEffect(() => () => {
    if (webWatchId.current !== null) navigator.geolocation.clearWatch(webWatchId.current)
    if (nativeWatcherRef.current) void BackgroundGeolocation.removeWatcher({ id: nativeWatcherRef.current })
  }, [])

  const recentMemories = useMemo(() => [...data.memories].reverse(), [data.memories])
  const pointForSpot = selectedPoint ?? data.points[data.points.length - 1]
  const latestDate = data.points.at(-1)?.recordedAt

  return (
    <main className="app-shell">
      <aside className={`sidebar ${mobileMenuOpen ? 'menu-open' : ''}`}>
        <div className="brand">
          <div className="brand-mark"><Footprints size={22} strokeWidth={2.2} /></div>
          <div>
            <div className="brand-name">ashiato</div>
            <div className="brand-subtitle">MY TRAVEL ALBUM</div>
          </div>
          <button className="icon-button mobile-close" onClick={() => setMobileMenuOpen(false)} aria-label="メニューを閉じる"><X size={20} /></button>
        </div>

        <nav className="primary-nav" aria-label="メインメニュー">
          <button className={`nav-item ${tab === 'map' ? 'selected' : ''}`} onClick={() => { setTab('map'); setMobileMenuOpen(false) }}>
            <MapPin size={19} /><span>足跡マップ</span><span className="nav-count">{data.points.length}</span>
          </button>
          <button className={`nav-item ${tab === 'spots' ? 'selected' : ''}`} onClick={() => { setTab('spots'); setMobileMenuOpen(false) }}>
            <Heart size={19} /><span>お気に入りスポット</span><span className="nav-count">{data.memories.length}</span>
          </button>
          <button className={`nav-item ${tab === 'settings' ? 'selected' : ''}`} onClick={() => { setTab('settings'); setMobileMenuOpen(false) }}>
            <Settings2 size={19} /><span>記録の設定</span>
          </button>
        </nav>

        {tab === 'settings' ? (
          <section className="settings-panel">
            <div className="section-kicker">GPS RECORDING</div>
            <h2>記録の間隔</h2>
            <p className="muted-copy">間隔を短くすると、移動経路を細かく残せます。</p>
            <div className="interval-options">
              {intervals.map((option) => (
                <button key={option.seconds} className={`interval-option ${intervalSeconds === option.seconds ? 'chosen' : ''}`} onClick={() => setIntervalSeconds(option.seconds)}>
                  <span className="radio-dot" />
                  <span><strong>{option.label}</strong><small>{option.detail}</small></span>
                  {intervalSeconds === option.seconds && <Check size={16} />}
                </button>
              ))}
            </div>
            <div className="privacy-note"><ShieldCheck size={17} /><span>足跡はこの端末に保存されます。地図表示では地図配信元に表示範囲が伝わります。</span></div>
            <div className="settings-divider" />
            <div className="section-kicker">ACCOUNT & SYNC</div>
            <h2>Google Driveと同期</h2>
            <p className="muted-copy">記録はご自身のGoogleアカウントに紐づけて保存します。</p>
            <button className="secondary-button full-button" onClick={signIn}><Cloud size={17} />Googleでログイン・同期</button>
            <p className="small-muted">{hasSynced ? 'Googleアカウントに同期済み' : 'まだ同期されていません'}</p>
            <div className="privacy-note"><CircleHelp size={17} /><span>写真・動画はスポットごとに、ご自身のGoogle Driveへ保存できます。</span></div>
          </section>
        ) : (
          <>
            <div className="panel-heading">
              <div>
                <div className="section-kicker">{tab === 'map' ? 'YOUR JOURNEY' : 'KEEPSAKES'}</div>
                <h1>{tab === 'map' ? '旅の足跡' : 'お気に入り'}</h1>
              </div>
              <button className="icon-button light" aria-label="表示オプション"><ChevronDown size={19} /></button>
            </div>
            {tab === 'map' ? (
              <>
                <div className="journey-card">
                  <div className="journey-icon"><Navigation size={18} /></div>
                  <div className="journey-copy"><strong>{active ? 'お出かけを記録中' : '今日の旅をはじめよう'}</strong><span>{active ? `約${intervalSeconds}秒ごとに位置を記録` : '記録を始めると、歩いた道が残ります'}</span></div>
                  <span className={`live-pill ${active ? 'on' : ''}`}><span />{active ? 'LIVE' : 'OFF'}</span>
                </div>
                <div className="stats-row">
                  <div className="stat-card"><span>記録した地点</span><strong>{data.points.length.toLocaleString()}<small> 件</small></strong></div>
                  <div className="stat-card"><span>お気に入り</span><strong>{data.memories.length.toLocaleString()}<small> スポット</small></strong></div>
                </div>
                <div className="list-header">
                  <div><span className="section-kicker">RECENT</span><h2>最近の記録</h2></div>
                  <span className="list-date">{latestDate ? new Date(latestDate).toLocaleDateString('ja-JP', { month: 'long', day: 'numeric' }) : '記録なし'}</span>
                </div>
                <div className="point-list">
                  {[...data.points].reverse().slice(0, 16).map((point, index) => (
                    <button className="point-item" key={point.id} onClick={() => { setSelectedPoint(point); setShowSaveDialog(true) }}>
                      <span className="point-icon">{index === 0 ? <LocateFixed size={15} /> : <MapPin size={15} />}</span>
                      <span className="point-text"><strong>{index === 0 ? '最新の記録地点' : '通過地点'}</strong><small>{point.latitude.toFixed(5)}°, {point.longitude.toFixed(5)}°</small></span>
                      <span className="point-time">{new Date(point.recordedAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}</span>
                    </button>
                  ))}
                  {!data.points.length && (
                    <div className="empty-points"><div className="empty-icon"><Footprints size={22} /></div><strong>あなたの旅は、ここから</strong><span>GPS記録を開始すると、訪れた場所が表示されます。</span></div>
                  )}
                </div>
              </>
            ) : (
              <div className="memories-list">
                {recentMemories.map((memory) => (
                  <button className="memory-card" key={memory.id} onClick={() => setSelectedMemory(memory)}>
                    <span className="memory-card-icon"><Heart size={17} fill="currentColor" /></span>
                    <span className="memory-card-text"><strong>{memory.title}</strong><small>{memory.note || `${memory.latitude.toFixed(4)}, ${memory.longitude.toFixed(4)}`}</small><small>{memory.driveFiles.length ? `写真・動画 ${memory.driveFiles.length}件` : '思い出を追加できます'}</small></span>
                    <ChevronDown size={16} className="memory-chevron" />
                  </button>
                ))}
                {!recentMemories.length && <div className="empty-points"><div className="empty-icon"><Heart size={22} /></div><strong>とっておきの場所を残そう</strong><span>記録した地点から、好きな場所をスポットにできます。</span></div>}
              </div>
            )}
            <div className="sidebar-spacer" />
            <div className="sync-card">
              <div className="sync-card-icon"><Cloud size={18} /></div>
              <div><strong>思い出を同期</strong><span>{identityToken ? 'Googleアカウントに保存できます' : 'Google Driveにバックアップ'}</span></div>
              <button onClick={() => identityToken ? void syncData() : signIn()} disabled={syncing} aria-label="同期する"><Upload size={17} /></button>
            </div>
            <div className="sidebar-footer"><span className="secure-dot" />あなたの思い出は、あなたのもの。</div>
          </>
        )}
      </aside>

      <section className="map-section">
        <header className="topbar">
          <button className="icon-button mobile-menu-button" onClick={() => setMobileMenuOpen(true)} aria-label="メニュー"><Menu size={20} /></button>
          <div className="breadcrumb"><span>マイアルバム</span><span className="breadcrumb-divider">/</span><strong>{tab === 'map' ? '足跡マップ' : tab === 'spots' ? 'お気に入り' : '記録の設定'}</strong></div>
          <div className="topbar-actions">
            <span className="location-label"><span className="location-pulse" />{active ? '位置情報を使用中' : 'GPS待機中'}</span>
            <button className="avatar-button" onClick={signIn} aria-label="Googleアカウント">旅</button>
          </div>
        </header>
        <MapView points={data.points} memories={data.memories} active={active} onSelect={onSelectMemory} onAddPoint={onAddPoint} centerRequest={centerRequest} />
        <div className="map-actions">
          <button className="floating-button locate-button" onClick={() => {
            const latest = data.points.at(-1)
            if (latest) {
              setCenterRequest([latest.latitude, latest.longitude])
              setMessage('最新の記録地点を表示しています')
            }
            else setMessage('位置情報を記録すると現在地を地図に表示します')
          }} aria-label="現在地を表示"><Crosshair size={19} /></button>
          <button className={`record-button ${active ? 'recording' : ''}`} onClick={() => active ? void stopTracking() : void startTracking()} disabled={!dataLoaded}>
            <span className="record-button-icon">{active ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" />}</span>
            <span>{!dataLoaded ? '準備しています…' : active ? '記録を一時停止' : '足跡の記録を開始'}</span>
            {!active && <span className="record-shortcut"><Sparkles size={14} /></span>}
          </button>
          {pointForSpot && (
            <button className="add-spot-button" onClick={() => onAddPoint(pointForSpot)}><Plus size={16} />スポットを保存</button>
          )}
        </div>
        {message && <div className="toast-message" role="status"><span>{message}</span><button onClick={() => setMessage('')} aria-label="閉じる"><X size={15} /></button></div>}
        {selectedMemory && (
          <div className="memory-detail">
            <button className="detail-close icon-button" onClick={() => setSelectedMemory(null)} aria-label="閉じる"><X size={18} /></button>
            <div className="detail-kicker"><Heart size={14} fill="currentColor" /> FAVORITE SPOT</div>
            <h2>{selectedMemory.title}</h2>
            {selectedMemory.note && <p>{selectedMemory.note}</p>}
            <div className="detail-coordinate">{selectedMemory.latitude.toFixed(5)}°, {selectedMemory.longitude.toFixed(5)}°</div>
            <div className="drive-files">
              {selectedMemory.driveFiles.map((file) => (
                <a className="drive-file" href={file.url} target="_blank" rel="noreferrer" key={file.id}>
                  {file.mimeType.startsWith('video/') ? <Video size={16} /> : <Camera size={16} />}<span>{file.name}</span>
                </a>
              ))}
              <button className="secondary-button full-button" onClick={() => mediaInputRef.current?.click()}><Camera size={17} />写真・動画を追加</button>
              <input ref={mediaInputRef} type="file" accept="image/*,video/*" hidden onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) void uploadMedia(file)
                event.currentTarget.value = ''
              }} />
              <span className="small-muted">ご自身のGoogle Driveに保存されます</span>
            </div>
          </div>
        )}
      </section>

      {showGoogleLogin && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowGoogleLogin(false) }}>
          <section className="save-dialog login-dialog" role="dialog" aria-modal="true" aria-labelledby="google-login-title">
            <button type="button" className="dialog-close icon-button" onClick={() => setShowGoogleLogin(false)} aria-label="閉じる"><X size={18} /></button>
            <div className="dialog-icon"><Cloud size={20} /></div>
            <div className="section-kicker">BACK UP YOUR JOURNEY</div>
            <h2 id="google-login-title">Googleアカウントに同期</h2>
            <p>足跡とスポットをあなたのアカウントに保存します。写真・動画はご自身のGoogle Driveに保存されます。</p>
            {CLIENT_ID
              ? <div className="google-button-wrap">{googleReady ? <div ref={googleButtonRef} /> : <span className="small-muted">Googleログインを読み込み中…</span>}</div>
              : <div className="privacy-note"><CircleHelp size={17} /><span>VITE_GOOGLE_CLIENT_IDを設定するとGoogleログインを利用できます。</span></div>}
          </section>
        </div>
      )}

      {showSaveDialog && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowSaveDialog(false) }}>
          <form className="save-dialog" onSubmit={addMemory}>
            <button type="button" className="dialog-close icon-button" onClick={() => setShowSaveDialog(false)} aria-label="閉じる"><X size={18} /></button>
            <div className="dialog-icon"><Heart size={20} /></div>
            <div className="section-kicker">SAVE A MEMORY</div>
            <h2>お気に入りの場所にする</h2>
            <p>いつかまた訪れたい場所に、名前をつけましょう。</p>
            {selectedPoint && <div className="dialog-coordinate"><MapPin size={15} />{selectedPoint.latitude.toFixed(5)}°, {selectedPoint.longitude.toFixed(5)}°</div>}
            <label className="field-label" htmlFor="spot-title">スポット名</label>
            <input id="spot-title" className="text-field" value={spotTitle} onChange={(event) => setSpotTitle(event.target.value)} placeholder="例：夕焼けがきれいな丘" required autoFocus />
            <label className="field-label" htmlFor="spot-note">メモ <span>任意</span></label>
            <textarea id="spot-note" className="text-field note-field" value={spotNote} onChange={(event) => setSpotNote(event.target.value)} placeholder="ここでの思い出を書き留める" rows={3} />
            <button className="primary-button full-button" type="submit"><Heart size={17} />スポットに保存</button>
          </form>
        </div>
      )}
    </main>
  )
}

export default App
