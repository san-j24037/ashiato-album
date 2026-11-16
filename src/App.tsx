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
  Eye,
  EyeOff,
  FileUp,
  Footprints,
  Heart,
  Image,
  LocateFixed,
  Map as MapIcon,
  MapPin,
  Menu,
  Mountain,
  Navigation,
  Pause,
  Play,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Upload,
  Video,
  X,
} from 'lucide-react'
import { type ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import 'leaflet/dist/leaflet.css'
import './App.css'
import { AdminPage } from './AdminPage'
import { loadAccountData, saveAppData, setActiveAccount } from './data'
import { LOCATION_FILE_ACCEPT, parseLocationFile } from './location-import'
import { LocationImportError } from './timeline-import'
import { emptyAppData, type AppData, type FavoriteList, type Mark, type Memory, type PublicMemory, type TrackPoint } from './types'
import { DEFAULT_MARK, effectiveMark, escapeHtml } from './marks'
import { ListEditorDialog, MarkBadge, MarkPicker } from './FavoriteLists'

const BackgroundGeolocation = registerPlugin<BackgroundGeolocationPlugin>('BackgroundGeolocation')
const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, '')
const INTERVAL_KEY = 'ashiato-record-interval'
const MAP_STYLE_KEY = 'ashiato-map-style'
const intervals = [
  { seconds: 10, label: '10秒ごと', detail: '経路を細かく残す' },
  { seconds: 30, label: '30秒ごと', detail: 'バランス重視' },
  { seconds: 60, label: '1分ごと', detail: '記録を控えめに' },
]

type Tab = 'map' | 'spots' | 'settings'
type MapStyle = 'standard' | 'terrain' | 'satellite'
type SyncResponse = { ok: boolean; error?: string; data?: AppData; recommendations?: PublicMemory[] }
type ImportResult = {
  status: 'success' | 'partial' | 'nothing-new' | 'failure'
  fileName: string
  format?: string
  total?: number
  added?: number
  duplicates?: number
  skipped?: number
  firstAt?: string
  lastAt?: string
  syncError?: string
  cause?: string
  hint?: string
}

type AccountProfile = { id: string; name: string; email: string; isAdmin?: boolean }
type PlaceSearchResult = {
  id: string
  latitude: number
  longitude: number
  name: string
  address: string
  category: string
}

function parsePlaceSearchResults(value: unknown): PlaceSearchResult[] {
  if (!Array.isArray(value)) throw new Error('場所の検索結果を読み取れませんでした')
  return value.flatMap((item: unknown) => {
    if (!item || typeof item !== 'object') return []
    const place = item as Record<string, unknown>
    const latitude = Number(place.lat)
    const longitude = Number(place.lon)
    if (
      !Number.isFinite(latitude) || latitude < -90 || latitude > 90
      || !Number.isFinite(longitude) || longitude < -180 || longitude > 180
      || typeof place.display_name !== 'string'
    ) return []
    const address = place.display_name
    const name = typeof place.name === 'string' && place.name ? place.name : address.split(',')[0].trim()
    const category = [place.class, place.type]
      .filter((part): part is string => typeof part === 'string' && part.length > 0)
      .join(' / ')
    return [{
      id: String(place.place_id ?? `${latitude},${longitude}`),
      latitude,
      longitude,
      name,
      address,
      category,
    }]
  })
}

function readInterval() {
  const value = Number(localStorage.getItem(INTERVAL_KEY))
  return intervals.some((option) => option.seconds === value) ? value : 10
}

function readMapStyle(): MapStyle {
  const savedStyle = localStorage.getItem(MAP_STYLE_KEY)
  return savedStyle === 'terrain' || savedStyle === 'satellite' ? savedStyle : 'standard'
}

/** Upper bound of point circles drawn at once; more visible points are thinned out evenly. */
const MAX_VISIBLE_POINT_MARKERS = 1500

function updateSatelliteColorMask(map: L.Map, layer: L.TileLayer, points: TrackPoint[]) {
  const container = layer.getContainer()
  if (!container) return

  const mapBounds = map.getContainer().getBoundingClientRect()
  const visibleBounds = map.getBounds().pad(0.2)
  const seen = new Set<string>()
  const circles: { x: number; y: number; radius: number }[] = []
  for (const point of points) {
    if (!visibleBounds.contains([point.latitude, point.longitude])) continue
    const center = map.latLngToContainerPoint([point.latitude, point.longitude])
    // Points that land on (almost) the same pixel add nothing to the mask.
    const key = `${Math.round(center.x / 2)}:${Math.round(center.y / 2)}`
    if (seen.has(key)) continue
    seen.add(key)
    const targetLatitude = point.latitude > 89.999
      ? point.latitude - 20 / 111_320
      : point.latitude + 20 / 111_320
    const edge = map.latLngToContainerPoint([targetLatitude, point.longitude])
    circles.push({
      x: mapBounds.left + center.x,
      y: mapBounds.top + center.y,
      radius: Math.max(Math.hypot(edge.x - center.x, edge.y - center.y), 0.5),
    })
  }

  container.querySelectorAll<HTMLImageElement>('.leaflet-tile').forEach((tile) => {
    const tileBounds = tile.getBoundingClientRect()
    const width = Math.max(tile.clientWidth, 1)
    const height = Math.max(tile.clientHeight, 1)
    const tileCircles = circles
      .filter((circle) => (
        circle.x + circle.radius >= tileBounds.left
        && circle.x - circle.radius <= tileBounds.right
        && circle.y + circle.radius >= tileBounds.top
        && circle.y - circle.radius <= tileBounds.bottom
      ))
      .map((circle) => (
        `<circle cx="${(circle.x - tileBounds.left).toFixed(2)}" cy="${(circle.y - tileBounds.top).toFixed(2)}" r="${circle.radius.toFixed(2)}" fill="white"/>`
      ))
      .join('')
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${tileCircles}</svg>`
    const mask = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`
    tile.style.setProperty('mask-image', mask)
    tile.style.setProperty('-webkit-mask-image', mask)
  })
}

function MapView({
  points,
  memories,
  lists,
  recommendations,
  active,
  onSelect,
  onSelectRecommendation,
  onAddPoint,
  centerRequest,
  searchResults,
  selectedSearchResult,
  searching,
  searchError,
  onSearch,
  onChooseSearchResult,
}: {
  points: TrackPoint[]
  memories: Memory[]
  lists: FavoriteList[]
  recommendations: PublicMemory[]
  active: boolean
  onSelect(memory: Memory): void
  onSelectRecommendation(memory: PublicMemory): void
  onAddPoint(point: TrackPoint): void
  centerRequest: [number, number] | null
  searchResults: PlaceSearchResult[]
  selectedSearchResult: PlaceSearchResult | null
  searching: boolean
  searchError: string
  onSearch(query: string): void
  onChooseSearchResult(result: PlaceSearchResult): void
}) {
  const elementRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const tileLayerRef = useRef<L.TileLayer | null>(null)
  const satelliteColorLayerRef = useRef<L.TileLayer | null>(null)
  const rendererRef = useRef<L.Canvas | null>(null)
  const trackLayerRef = useRef<L.LayerGroup | null>(null)
  const pointLayerRef = useRef<L.LayerGroup | null>(null)
  const memoryLayerRef = useRef<L.LayerGroup | null>(null)
  const recommendationLayerRef = useRef<L.LayerGroup | null>(null)
  const drawnTrackRef = useRef<{ line: L.Polyline | null; length: number; firstId?: string; lastId?: string } | null>(null)
  const userMarkerRef = useRef<L.CircleMarker | null>(null)
  const searchMarkerRef = useRef<L.Marker | null>(null)
  const lastCenteredIdRef = useRef<string | null>(null)
  const pointsRef = useRef(points)
  const [mapStyle, setMapStyle] = useState<MapStyle>(readMapStyle)
  const [searchQuery, setSearchQuery] = useState('')
  // Circles for every GPS point are optional (off by default) because they are the heaviest layer.
  const [showPointMarkers, setShowPointMarkers] = useState(false)
  const showTrackMarkings = active
    && !searchQuery.trim()
    && !searching
    && !searchError
    && searchResults.length === 0
    && !selectedSearchResult

  useEffect(() => {
    if (!elementRef.current) return
    // Canvas rendering keeps thousands of vectors fast (SVG creates one DOM node per shape).
    const map = L.map(elementRef.current, { zoomControl: false, attributionControl: true, preferCanvas: true })
      .setView([35.6812, 139.7671], 13)
    L.control.zoom({ position: 'bottomright' }).addTo(map)
    rendererRef.current = L.canvas({ padding: 0.5, tolerance: 4 })
    trackLayerRef.current = L.layerGroup().addTo(map)
    pointLayerRef.current = L.layerGroup().addTo(map)
    memoryLayerRef.current = L.layerGroup().addTo(map)
    recommendationLayerRef.current = L.layerGroup().addTo(map)
    mapRef.current = map
    map.on('click', (event: L.LeafletMouseEvent) => {
      // Newest point within 120 m of the click (scans backwards without copying the array).
      const current = pointsRef.current
      for (let index = current.length - 1; index >= 0; index -= 1) {
        const point = current[index]
        if (map.distance(event.latlng, [point.latitude, point.longitude]) < 120) {
          onAddPoint(point)
          return
        }
      }
    })
    const resizeObserver = new ResizeObserver(() => map.invalidateSize({ pan: false }))
    resizeObserver.observe(elementRef.current)
    return () => {
      resizeObserver.disconnect()
      map.remove()
      mapRef.current = null
      tileLayerRef.current = null
      satelliteColorLayerRef.current = null
      rendererRef.current = null
      trackLayerRef.current = null
      pointLayerRef.current = null
      memoryLayerRef.current = null
      recommendationLayerRef.current = null
      drawnTrackRef.current = null
      userMarkerRef.current = null
    }
  }, [onAddPoint])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    tileLayerRef.current?.remove()
    satelliteColorLayerRef.current?.remove()
    satelliteColorLayerRef.current = null
    const satellite = mapStyle === 'satellite'
    const highlightSatellite = satellite && showTrackMarkings
    const tileLayer = mapStyle === 'standard'
      ? L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 19,
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        })
      : mapStyle === 'terrain'
        ? L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
          maxZoom: 19,
          maxNativeZoom: 17,
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, <a href="https://opentopomap.org/">OpenTopoMap</a> (CC-BY-SA)',
        })
        : L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
            maxZoom: 19,
            maxNativeZoom: 17,
            className: highlightSatellite ? 'satellite-muted-layer' : '',
            attribution: 'Tiles &copy; Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
          })
    tileLayer.addTo(map)
    tileLayerRef.current = tileLayer
    if (highlightSatellite) {
      const colorLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        maxZoom: 19,
        maxNativeZoom: 17,
        className: 'satellite-color-layer',
      }).addTo(map)
      satelliteColorLayerRef.current = colorLayer
    }
    localStorage.setItem(MAP_STYLE_KEY, mapStyle)
  }, [mapStyle, showTrackMarkings])

  useEffect(() => {
    const map = mapRef.current
    const colorLayer = satelliteColorLayerRef.current
    if (!map || !colorLayer || !showTrackMarkings) return

    let frame = 0
    const updateMask = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        updateSatelliteColorMask(map, colorLayer, points)
      })
    }
    updateMask()
    map.on('moveend zoomend resize', updateMask)
    colorLayer.on('tileload', updateMask)
    return () => {
      if (frame) cancelAnimationFrame(frame)
      map.off('moveend zoomend resize', updateMask)
      colorLayer.off('tileload', updateMask)
    }
  }, [points, mapStyle, showTrackMarkings])

  // Route line + current-position marker. While recording, new points are appended to the
  // existing polyline instead of redrawing the whole history.
  useEffect(() => {
    pointsRef.current = points
    const map = mapRef.current
    const trackLayer = trackLayerRef.current
    if (!map || !trackLayer) return
    const drawn = drawnTrackRef.current
    const appendOnly = drawn?.line
      && points.length > drawn.length
      && points[0]?.id === drawn.firstId
      && points[drawn.length - 1]?.id === drawn.lastId
    let line = drawn?.line ?? null
    if (appendOnly && line) {
      for (let index = drawn.length; index < points.length; index += 1) {
        line.addLatLng([points[index].latitude, points[index].longitude])
      }
    } else {
      trackLayer.clearLayers()
      line = points.length > 1
        ? L.polyline(points.map((point) => [point.latitude, point.longitude] as L.LatLngTuple), {
            color: '#397a69',
            weight: 5,
            opacity: 0.86,
            lineCap: 'round',
            lineJoin: 'round',
            smoothFactor: 1.5,
            interactive: false,
            renderer: rendererRef.current ?? undefined,
          }).addTo(trackLayer)
        : null
    }
    drawnTrackRef.current = {
      line,
      length: points.length,
      firstId: points[0]?.id,
      lastId: points[points.length - 1]?.id,
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
          renderer: rendererRef.current ?? undefined,
        }).addTo(map)
      } else {
        userMarkerRef.current.setLatLng([lastPoint.latitude, lastPoint.longitude])
      }
    } else if (userMarkerRef.current) {
      userMarkerRef.current.remove()
      userMarkerRef.current = null
    }
    if (lastPoint && lastPoint.id !== lastCenteredIdRef.current) {
      map.setView([lastPoint.latitude, lastPoint.longitude], Math.max(map.getZoom(), 14), { animate: true })
      lastCenteredIdRef.current = lastPoint.id
    }
  }, [points])

  // Optional per-point circles: only those inside the visible area are drawn, thinned out
  // evenly when there are more than MAX_VISIBLE_POINT_MARKERS, and redrawn after panning.
  useEffect(() => {
    const map = mapRef.current
    const pointLayer = pointLayerRef.current
    if (!map || !pointLayer) return
    pointLayer.clearLayers()
    if (!showPointMarkers) return
    const renderer = rendererRef.current ?? undefined
    const showRange = showTrackMarkings && mapStyle !== 'satellite'

    const render = () => {
      pointLayer.clearLayers()
      const bounds = map.getBounds().pad(0.1)
      const visible: TrackPoint[] = []
      for (const point of points) {
        if (bounds.contains([point.latitude, point.longitude])) visible.push(point)
      }
      const step = Math.max(1, Math.ceil(visible.length / MAX_VISIBLE_POINT_MARKERS))
      const drawRange = showRange && map.getZoom() >= 15
      for (let index = 0; index < visible.length; index += step) {
        const point = visible[index]
        if (drawRange) {
          L.circle([point.latitude, point.longitude], {
            radius: 20,
            color: '#397a69',
            weight: 1,
            opacity: 0.8,
            fillColor: '#397a69',
            fillOpacity: 0.16,
            interactive: false,
            renderer,
          }).addTo(pointLayer)
        }
        L.circleMarker([point.latitude, point.longitude], {
          radius: 5,
          color: '#fff',
          weight: 2,
          fillColor: '#4b8978',
          fillOpacity: 1,
          renderer,
        })
          .bindTooltip(() => new Date(point.recordedAt).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }))
          .addTo(pointLayer)
      }
    }

    render()
    map.on('moveend', render)
    return () => {
      map.off('moveend', render)
      pointLayer.clearLayers()
    }
  }, [points, showPointMarkers, showTrackMarkings, mapStyle])

  useEffect(() => {
    const memoryLayer = memoryLayerRef.current
    if (!memoryLayer) return
    memoryLayer.clearLayers()
    const listsById = new Map(lists.map((list) => [list.id, list]))
    for (const memory of memories) {
      const mark = effectiveMark(memory, listsById)
      const icon = L.divIcon({
        className: 'memory-marker',
        html: `<span style="background:${mark.color}"><i>${escapeHtml(mark.symbol)}</i></span>`,
        iconSize: [36, 42],
        iconAnchor: [18, 38],
      })
      const list = memory.listId ? listsById.get(memory.listId) : undefined
      L.marker([memory.latitude, memory.longitude], { icon })
        .bindTooltip(list && !list.deletedAt ? `${memory.title}（${list.name}）` : memory.title)
        .on('click', () => onSelect(memory))
        .addTo(memoryLayer)
    }
  }, [memories, lists, onSelect])

  useEffect(() => {
    const recommendationLayer = recommendationLayerRef.current
    if (!recommendationLayer) return
    recommendationLayer.clearLayers()
    const icon = L.divIcon({
      className: 'recommendation-marker',
      html: '<span>★</span>',
      iconSize: [36, 42],
      iconAnchor: [18, 38],
    })
    for (const memory of recommendations) {
      L.marker([memory.latitude, memory.longitude], { icon })
        .bindTooltip(memory.title)
        .on('click', () => onSelectRecommendation(memory))
        .addTo(recommendationLayer)
    }
  }, [recommendations, onSelectRecommendation])

  useEffect(() => {
    if (centerRequest && mapRef.current) mapRef.current.setView(centerRequest, Math.max(mapRef.current.getZoom(), 14))
  }, [centerRequest])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    searchMarkerRef.current?.remove()
    searchMarkerRef.current = null
    if (!selectedSearchResult) return

    const location = selectedSearchResult
    const icon = L.divIcon({
      className: 'search-marker',
      html: '<span><i></i></span>',
      iconSize: [42, 48],
      iconAnchor: [21, 44],
    })
    const popupContent = L.DomUtil.create('div', 'search-marker-popup')
    const title = L.DomUtil.create('strong', '', popupContent)
    title.textContent = location.name
    const address = L.DomUtil.create('span', '', popupContent)
    address.textContent = location.address
    searchMarkerRef.current = L.marker([location.latitude, location.longitude], { icon })
      .bindPopup(popupContent)
      .addTo(map)
    map.flyTo([location.latitude, location.longitude], 17, { duration: 0.8 })
  }, [selectedSearchResult])

  return (
    <div className="map-canvas">
      <div ref={elementRef} className="leaflet-map" aria-label="訪れた場所の地図" />
      <div className="map-search">
        <form className="map-search-form" onSubmit={(event) => {
          event.preventDefault()
          onSearch(searchQuery)
        }}>
          <Search size={17} aria-hidden="true" />
          <input
            type="search"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="場所の名前・住所を検索"
            aria-label="場所の名前または住所"
            maxLength={200}
          />
          <button type="submit" disabled={searching || !searchQuery.trim()} aria-label="検索">
            {searching ? '検索中…' : '検索'}
          </button>
        </form>
        {(searching || searchError || searchResults.length > 0) && (
          <div className="map-search-results" aria-live="polite">
            {searching && <p className="search-status">場所を検索しています…</p>}
            {searchError && <p className="search-status is-error" role="status">{searchError}</p>}
            {searchResults.map((result) => (
              <button
                type="button"
                className={`search-result ${selectedSearchResult?.id === result.id ? 'selected' : ''}`}
                key={result.id}
                onClick={() => onChooseSearchResult(result)}
              >
                <MapPin size={16} />
                <span><strong>{result.name}</strong><small>{result.address}</small></span>
              </button>
            ))}
            <small className="search-attribution">検索結果 © OpenStreetMap contributors</small>
          </div>
        )}
      </div>
      <div className={`map-status ${active ? 'is-recording' : ''}`}>
        <span className="status-dot" />
        {active ? '足跡を記録中' : '記録は停止中'}
      </div>
      <div className="map-style-switch" role="group" aria-label="地図の表示方法">
        <button
          className={mapStyle === 'standard' ? 'selected' : ''}
          onClick={() => setMapStyle('standard')}
          aria-pressed={mapStyle === 'standard'}
        >
          <MapIcon size={15} />
          標準
        </button>
        <button
          className={mapStyle === 'terrain' ? 'selected' : ''}
          onClick={() => setMapStyle('terrain')}
          aria-pressed={mapStyle === 'terrain'}
        >
          <Mountain size={15} />
          地形
        </button>
        <button
          className={mapStyle === 'satellite' ? 'selected' : ''}
          onClick={() => setMapStyle('satellite')}
          aria-pressed={mapStyle === 'satellite'}
        >
          <Image size={15} />
          航空写真
        </button>
      </div>
      <button
        type="button"
        className={`map-hint map-point-toggle ${showPointMarkers ? 'on' : ''}`}
        onClick={() => setShowPointMarkers((visible) => !visible)}
        aria-pressed={showPointMarkers}
        disabled={!points.length}
        title={showPointMarkers ? '地点の〇を非表示にする' : '地点の〇を表示する（地点が多いと重くなります）'}
      >
        <Compass size={15} />
        {points.length ? `${points.length.toLocaleString()}件の記録地点` : '旅の足跡がここに並びます'}
        {points.length > 0 && <span className="toggle-pill">〇 {showPointMarkers ? '表示' : '非表示'}</span>}
      </button>
    </div>
  )
}

function App() {
  const [data, setData] = useState<AppData>(emptyAppData)
  const [dataLoaded, setDataLoaded] = useState(false)
  const [accountSub, setAccountSub] = useState<string | null>(null)
  const [account, setAccount] = useState<AccountProfile | null>(null)
  const [authReady, setAuthReady] = useState(false)
  const [authMode, setAuthMode] = useState<'login' | 'register' | 'reset'>('login')
  const [resetStep, setResetStep] = useState<'request' | 'confirm'>('request')
  const [adminOpen, setAdminOpen] = useState(false)
  const [importResult, setImportResult] = useState<ImportResult | null>(null)
  const [resetCode, setResetCode] = useState('')
  const [authNotice, setAuthNotice] = useState('')
  const [authName, setAuthName] = useState('')
  const [authEmail, setAuthEmail] = useState('')
  const [authPassword, setAuthPassword] = useState('')
  const [authPasswordConfirm, setAuthPasswordConfirm] = useState('')
  const [privacyAccepted, setPrivacyAccepted] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [authBusy, setAuthBusy] = useState(false)
  const [authError, setAuthError] = useState('')
  const [tab, setTab] = useState<Tab>('map')
  const [recommendations, setRecommendations] = useState<PublicMemory[]>([])
  const [active, setActive] = useState(false)
  const [intervalSeconds, setIntervalSeconds] = useState(readInterval)
  const [accessToken, setAccessToken] = useState<string | null>(null)
  const [accessTokenExpiresAt, setAccessTokenExpiresAt] = useState(0)
  const [syncing, setSyncing] = useState(false)
  const [message, setMessage] = useState('')
  const [selectedMemory, setSelectedMemory] = useState<Memory | null>(null)
  const [selectedRecommendation, setSelectedRecommendation] = useState<PublicMemory | null>(null)
  const [editSpotTitle, setEditSpotTitle] = useState('')
  const [editSpotAddress, setEditSpotAddress] = useState('')
  const [editSpotNote, setEditSpotNote] = useState('')
  const [editSpotIsPublic, setEditSpotIsPublic] = useState(false)
  const [editSpotListId, setEditSpotListId] = useState('')
  const [editSpotMark, setEditSpotMark] = useState<Mark | null>(null)
  // 'all' | 'none' (favorites without a list) | a list id
  const [listFilter, setListFilter] = useState('all')
  const listFilterRef = useRef('all')
  const [listEditor, setListEditor] = useState<{ list: FavoriteList | null } | null>(null)
  const [selectedPoint, setSelectedPoint] = useState<TrackPoint | null>(null)
  const [showSaveDialog, setShowSaveDialog] = useState(false)
  const [spotTitle, setSpotTitle] = useState('')
  const [spotAddress, setSpotAddress] = useState('')
  const [spotNote, setSpotNote] = useState('')
  const [spotIsPublic, setSpotIsPublic] = useState(false)
  const [spotListId, setSpotListId] = useState('')
  const [spotMark, setSpotMark] = useState<Mark | null>(null)
  const [nativeWatcherId, setNativeWatcherId] = useState<string | null>(null)
  const nativeWatcherRef = useRef<string | null>(null)
  const [hasSynced, setHasSynced] = useState(false)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [centerRequest, setCenterRequest] = useState<[number, number] | null>(null)
  const [searchResults, setSearchResults] = useState<PlaceSearchResult[]>([])
  const [selectedSearchResult, setSelectedSearchResult] = useState<PlaceSearchResult | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState('')
  const [importingTimeline, setImportingTimeline] = useState(false)
  const searchAbortRef = useRef<AbortController | null>(null)
  const lastSearchRequestAtRef = useRef(0)
  const mediaInputRef = useRef<HTMLInputElement>(null)
  const timelineInputRef = useRef<HTMLInputElement>(null)
  const webWatchId = useRef<number | null>(null)
  const intervalRef = useRef(intervalSeconds)
  const lastAcceptedTimeRef = useRef(0)
  const syncDataRef = useRef<(sourceData?: AppData) => Promise<string | null>>(async () => null)

  useEffect(() => {
    let cancelled = false
    void fetch('/api/auth', { credentials: 'same-origin', cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error(`ログイン状態を確認できませんでした (${response.status})`)
        return await response.json() as { ok: boolean; user: AccountProfile | null }
      })
      .then(async (result) => {
        if (!result.ok) throw new Error('ログイン状態を確認できませんでした')
        if (result.user) {
          const saved = await loadAccountData(result.user.id)
          await setActiveAccount(result.user.id)
          if (!cancelled) {
            setAccount(result.user)
            setAccountSub(result.user.id)
            setData(saved)
            setDataLoaded(true)
            setAuthReady(true)
            void syncDataRef.current(saved)
          }
        } else if (!cancelled) {
          setData(emptyAppData)
          setAccountSub(null)
          setDataLoaded(false)
          setAuthReady(true)
        }
      })
      .catch((error: unknown) => {
        console.error('ログイン状態を確認できませんでした。', error)
        if (!cancelled) {
          setAuthError('サーバーに接続できません。公開URLと認証設定を確認してください。')
          setAuthReady(true)
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
    setSpotAddress('')
    setSpotNote('')
    setSpotIsPublic(false)
    // New favorites go into the list currently shown in the favorites tab.
    const filter = listFilterRef.current
    setSpotListId(filter !== 'all' && filter !== 'none' ? filter : '')
    setSpotMark(null)
  }, [])

  useEffect(() => {
    listFilterRef.current = listFilter
  }, [listFilter])

  const onSelectMemory = useCallback((memory: Memory) => {
    setSelectedRecommendation(null)
    setSelectedMemory(memory)
    setEditSpotTitle(memory.title)
    setEditSpotAddress(memory.address ?? '')
    setEditSpotNote(memory.note)
    setEditSpotIsPublic(memory.isPublic ?? false)
    setEditSpotListId(memory.listId ?? '')
    setEditSpotMark(memory.mark ?? null)
  }, [])

  const onSelectRecommendation = useCallback((memory: PublicMemory) => {
    setSelectedMemory(null)
    setSelectedRecommendation(memory)
  }, [])

  const finishLogin = async (user: AccountProfile) => {
    const saved = await loadAccountData(user.id)
    await setActiveAccount(user.id)
    setAccount(user)
    setAccountSub(user.id)
    setData(saved)
    setDataLoaded(true)
    setHasSynced(false)
    setAuthPassword('')
    setAuthPasswordConfirm('')
    setResetCode('')
    setAuthNotice('')
    setPrivacyAccepted(false)
    void syncDataRef.current(saved)
  }

  const switchAuthMode = (mode: 'login' | 'register' | 'reset') => {
    setAuthError('')
    setAuthNotice('')
    setAuthPassword('')
    setAuthPasswordConfirm('')
    setResetCode('')
    setResetStep('request')
    setAuthMode(mode)
  }

  const requestPasswordReset = async () => {
    setAuthBusy(true)
    setAuthError('')
    setAuthNotice('')
    try {
      const response = await fetch('/api/auth', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'requestPasswordReset', email: authEmail }),
      })
      const result = await response.json() as { ok: boolean; error?: string }
      if (!response.ok || !result.ok) throw new Error(result.error ?? 'ワンタイムパスワードを送信できませんでした')
      setResetStep('confirm')
      setAuthNotice('登録済みのメールアドレスであれば、ワンタイムパスワードを送信しました。メールに記載された6桁の数字を入力してください（有効期限15分）。')
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'ワンタイムパスワードを送信できませんでした')
    } finally {
      setAuthBusy(false)
    }
  }

  const submitPasswordReset = async () => {
    if (resetStep === 'request') {
      await requestPasswordReset()
      return
    }
    if (authPassword !== authPasswordConfirm) {
      setAuthError('確認用パスワードが一致しません')
      return
    }
    setAuthBusy(true)
    try {
      const response = await fetch('/api/auth', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'resetPassword', email: authEmail, code: resetCode, password: authPassword }),
      })
      const result = await response.json() as { ok: boolean; user?: AccountProfile; error?: string }
      if (!response.ok || !result.ok || !result.user) throw new Error(result.error ?? 'パスワードを変更できませんでした')
      setAuthMode('login')
      setResetStep('request')
      await finishLogin(result.user)
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'パスワードを変更できませんでした')
    } finally {
      setAuthBusy(false)
    }
  }

  const submitAuthentication = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setAuthError('')
    if (authMode === 'reset') {
      await submitPasswordReset()
      return
    }
    setAuthNotice('')
    if (authMode === 'register') {
      if (authPassword !== authPasswordConfirm) {
        setAuthError('確認用パスワードが一致しません')
        return
      }
      if (!privacyAccepted) {
        setAuthError('データの保存について確認してください')
        return
      }
    }
    setAuthBusy(true)
    try {
      const response = await fetch('/api/auth', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: authMode,
          name: authName,
          email: authEmail,
          password: authPassword,
        }),
      })
      const result = await response.json() as { ok: boolean; user?: AccountProfile; error?: string }
      if (!response.ok || !result.ok || !result.user) {
        throw new Error(result.error ?? (authMode === 'login' ? 'メールアドレスまたはパスワードが正しくありません' : 'アカウントを作成できませんでした'))
      }
      await finishLogin(result.user)
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'ログインできませんでした。設定とネットワークを確認してください')
    } finally {
      setAuthBusy(false)
    }
  }

  const logout = async () => {
    setAuthBusy(true)
    setAuthError('')
    try {
      const response = await fetch('/api/auth', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'logout' }),
      })
      if (!response.ok) throw new Error('ログアウトできませんでした')
      if (nativeWatcherRef.current) {
        await BackgroundGeolocation.removeWatcher({ id: nativeWatcherRef.current })
        nativeWatcherRef.current = null
        setNativeWatcherId(null)
      }
      if (webWatchId.current !== null) {
        navigator.geolocation.clearWatch(webWatchId.current)
        webWatchId.current = null
      }
      await setActiveAccount(null)
      setAccount(null)
      setAccountSub(null)
      setData(emptyAppData)
      setDataLoaded(false)
      setActive(false)
      setHasSynced(false)
      setSelectedMemory(null)
      setSelectedRecommendation(null)
      setSelectedPoint(null)
      setTab('map')
      setAdminOpen(false)
      setAuthMode('login')
      setResetStep('request')
      setResetCode('')
      setAuthNotice('')
      setAuthPassword('')
      setAuthPasswordConfirm('')
      setAuthError('')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'ログアウトできませんでした')
    } finally {
      setAuthBusy(false)
    }
  }

  const addMemory = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!selectedPoint || !spotTitle.trim()) return
    const memory: Memory = {
      id: crypto.randomUUID(),
      title: spotTitle.trim(),
      address: spotAddress.trim(),
      note: spotNote.trim(),
      isPublic: spotIsPublic,
      listId: spotListId,
      mark: spotMark,
      latitude: selectedPoint.latitude,
      longitude: selectedPoint.longitude,
      createdAt: new Date().toISOString(),
      driveFiles: [],
    }
    const nextData = { ...data, memories: [...data.memories, memory] }
    setData(nextData)
    setShowSaveDialog(false)
    setMessage(`「${memory.title}」をスポットに保存しました。スプレッドシートに同期しています`)
    void syncData(nextData)
  }

  const saveMemoryDetails = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!selectedMemory || !editSpotTitle.trim()) return
    const updatedMemory = {
      ...selectedMemory,
      title: editSpotTitle.trim(),
      address: editSpotAddress.trim(),
      note: editSpotNote.trim(),
      isPublic: editSpotIsPublic,
      listId: editSpotListId,
      mark: editSpotMark,
    }
    const nextData = {
      ...data,
      memories: data.memories.map((memory) => memory.id === updatedMemory.id ? updatedMemory : memory),
    }
    setData(nextData)
    setSelectedMemory(updatedMemory)
    setMessage('お気に入り情報を保存しています')
    void syncData(nextData)
  }

  const saveList = (name: string, mark: Mark) => {
    const now = new Date().toISOString()
    const editing = listEditor?.list
    const saved: FavoriteList = editing
      ? { ...editing, name, mark, updatedAt: now }
      : { id: crypto.randomUUID(), name, mark, createdAt: now, updatedAt: now }
    const nextData: AppData = {
      ...data,
      lists: editing ? data.lists.map((list) => list.id === saved.id ? saved : list) : [...data.lists, saved],
    }
    setData(nextData)
    setListEditor(null)
    if (!editing) setListFilter(saved.id)
    void syncData(nextData)
  }

  const deleteList = (target: FavoriteList) => {
    const now = new Date().toISOString()
    // Keep a tombstone so other devices learn about the deletion; favorites move to "未分類".
    const nextData: AppData = {
      ...data,
      lists: data.lists.map((list) => list.id === target.id ? { ...list, deletedAt: now, updatedAt: now } : list),
      memories: data.memories.map((memory) => memory.listId === target.id ? { ...memory, listId: '' } : memory),
    }
    setData(nextData)
    setListEditor(null)
    setListFilter('all')
    if (selectedMemory?.listId === target.id) setSelectedMemory({ ...selectedMemory, listId: '' })
    if (editSpotListId === target.id) setEditSpotListId('')
    void syncData(nextData)
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

  const syncData = useCallback(async (sourceData = data) => {
    setSyncing(true)
    setMessage('')
    try {
      const uploadData = sourceData
      const batchCount = Math.max(1, Math.ceil(uploadData.points.length / 3000), Math.ceil(uploadData.memories.length / 100))
      let remoteData: AppData | undefined
      let remoteRecommendations: PublicMemory[] = []
      let synchronizedData: AppData | undefined
      for (let index = 0; index < batchCount; index += 1) {
        const pointBatch = uploadData.points.slice(index * 3000, (index + 1) * 3000)
        const memoryBatch = uploadData.memories.slice(index * 100, (index + 1) * 100)
        const response = await fetch('/api/sync', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          // Lists are small, so they travel with the first batch only.
          body: JSON.stringify({ data: { points: pointBatch, memories: memoryBatch, lists: index === 0 ? uploadData.lists : [] } }),
        })
        const responseText = await response.text()
        let result: SyncResponse
        try {
          result = JSON.parse(responseText) as SyncResponse
        } catch {
          // Cloudflare / GAS error pages are HTML, not JSON.
          const title = /<title>([^<]*)<\/title>/i.exec(responseText)?.[1]?.trim()
          throw new Error(`同期サーバーから想定外の応答がありました（HTTP ${response.status}${title ? `「${title}」` : ''}）。サーバーの処理上限を超えたか、設定に誤りがある可能性があります`)
        }
        if (!response.ok || !result.ok) throw new Error(result.error ?? `同期に失敗しました (${response.status})`)
        remoteData = result.data
        remoteRecommendations = result.recommendations ?? []
      }
      if (remoteData) {
        const points = new Map([...remoteData.points, ...uploadData.points].map((point) => [point.id, point]))
        const memories = new Map([...remoteData.memories, ...uploadData.memories].map((memory) => [memory.id, memory]))
        // A list edited on several devices keeps its newest version (deletions included).
        const lists = new Map<string, FavoriteList>()
        for (const list of [...(remoteData.lists ?? []), ...uploadData.lists]) {
          const current = lists.get(list.id)
          if (!current || Date.parse(list.updatedAt) >= Date.parse(current.updatedAt)) lists.set(list.id, list)
        }
        synchronizedData = { points: [...points.values()], memories: [...memories.values()], lists: [...lists.values()] }
        setRecommendations(remoteRecommendations)
      }
      if (synchronizedData) setData(synchronizedData)
      setHasSynced(true)
      setMessage('アカウントに同期しました')
      return null
    } catch (error) {
      const syncError = error instanceof Error ? error.message : '同期に失敗しました'
      setMessage(syncError)
      return syncError
    } finally {
      setSyncing(false)
    }
  }, [data])
  useEffect(() => {
    syncDataRef.current = syncData
  }, [syncData])

  const signIn = () => {
    if (Capacitor.isNativePlatform()) {
      if (!API_BASE_URL) {
        setMessage('ネイティブ版には VITE_API_BASE_URL の設定が必要です')
        return
      }
      const state = crypto.randomUUID()
      localStorage.setItem('ashiato-pending-oauth-state', state)
      const startUrl = `${API_BASE_URL}/api/oauth/start?state=${encodeURIComponent(state)}`
      setMessage('Googleログインを開いています…')
      void Browser.open({ url: startUrl }).catch((error: unknown) => {
        localStorage.removeItem('ashiato-pending-oauth-state')
        setMessage(error instanceof Error ? error.message : 'Googleログインを開けませんでした')
      })
      return
    }
    setTab('settings')
  }

  useEffect(() => {
    let cancelled = false
    let removeListener: (() => void) | undefined
    const handleOAuthUrl = (url: string) => {
      if (!url.startsWith('jp.ashiato.album://oauth/callback')) return
      const callback = new URL(url)
      const values = new URLSearchParams(callback.hash.slice(1))
      const expectedState = localStorage.getItem('ashiato-pending-oauth-state')
      if (!expectedState) return
      if (values.get('state') !== expectedState) {
        setMessage('Googleログインの状態を確認できませんでした')
        return
      }
      if (values.has('error')) {
        localStorage.removeItem('ashiato-pending-oauth-state')
        setMessage(values.get('error') ?? 'Googleログインに失敗しました')
        void Browser.close()
        return
      }
      const driveToken = values.get('access_token')
      const expiresIn = Number(values.get('expires_in'))
      localStorage.removeItem('ashiato-pending-oauth-state')
      if (!driveToken || !Number.isFinite(expiresIn) || expiresIn <= 0) {
        setMessage('Googleログインに失敗しました。もう一度お試しください')
        return
      }
      setAccessToken(driveToken)
      setAccessTokenExpiresAt(Date.now() + expiresIn * 1000)
      void Browser.close()
      setMessage('Google Driveを利用できます')
      void syncDataRef.current()
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
    script.onerror = () => setMessage('Google Drive連携を読み込めませんでした。ネットワークを確認してください')
    document.head.appendChild(script)
    return () => script.remove()
  }, [])

  useEffect(() => () => {
    if (webWatchId.current !== null) navigator.geolocation.clearWatch(webWatchId.current)
    if (nativeWatcherRef.current) void BackgroundGeolocation.removeWatcher({ id: nativeWatcherRef.current })
    searchAbortRef.current?.abort()
  }, [])

  const activeLists = useMemo(
    () => data.lists.filter((list) => !list.deletedAt).sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
    [data.lists],
  )
  const listsById = useMemo(() => new Map(data.lists.map((list) => [list.id, list])), [data.lists])
  const isInActiveList = useCallback((memory: Memory) => {
    const list = memory.listId ? listsById.get(memory.listId) : undefined
    return !!list && !list.deletedAt
  }, [listsById])
  const filteredMemories = useMemo(() => {
    if (listFilter === 'all') return data.memories
    if (listFilter === 'none') return data.memories.filter((memory) => !isInActiveList(memory))
    return data.memories.filter((memory) => memory.listId === listFilter)
  }, [data.memories, listFilter, isInActiveList])
  const recentMemories = useMemo(() => [...filteredMemories].reverse(), [filteredMemories])
  const listCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const memory of data.memories) {
      const key = isInActiveList(memory) ? memory.listId ?? '' : 'none'
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return counts
  }, [data.memories, isInActiveList])
  const selectedList = activeLists.find((list) => list.id === listFilter) ?? null
  const listMarkFor = (listId: string) => activeLists.find((list) => list.id === listId)?.mark ?? DEFAULT_MARK
  // On the favorites tab, the map follows the chosen list.
  const mapMemories = tab === 'spots' && listFilter !== 'all' ? filteredMemories : data.memories
  const pointForSpot = selectedPoint ?? data.points[data.points.length - 1]
  const latestDate = data.points.at(-1)?.recordedAt

  const searchPlaces = async (query: string) => {
    const normalizedQuery = query.trim()
    if (normalizedQuery.length < 2) {
      setSearchError('場所の名前または住所を2文字以上入力してください')
      setSearchResults([])
      setSelectedSearchResult(null)
      return
    }
    if (Date.now() - lastSearchRequestAtRef.current < 1000) {
      setSearchError('検索は1秒以上間隔をあけてお試しください')
      return
    }
    searchAbortRef.current?.abort()
    const controller = new AbortController()
    searchAbortRef.current = controller
    lastSearchRequestAtRef.current = Date.now()
    setSearching(true)
    setSearchError('')
    setSearchResults([])
    setSelectedSearchResult(null)
    try {
      const params = new URLSearchParams({
        q: normalizedQuery,
        format: 'jsonv2',
        addressdetails: '1',
        limit: '5',
        'accept-language': 'ja',
      })
      const response = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      })
      if (!response.ok) {
        if (response.status === 429) throw new Error('検索が混み合っています。少し待ってから再度お試しください')
        throw new Error(`場所を検索できませんでした (${response.status})`)
      }
      const results = parsePlaceSearchResults(await response.json())
      if (controller.signal.aborted) return
      setSearchResults(results)
      setSelectedSearchResult(results[0] ?? null)
      if (!results.length) setSearchError('場所が見つかりませんでした。別の名前や住所で検索してください')
    } catch (error) {
      if (controller.signal.aborted) return
      console.error('場所を検索できませんでした。', error)
      setSearchError(error instanceof Error ? error.message : '場所を検索できませんでした。ネットワークを確認してください')
    } finally {
      if (!controller.signal.aborted) setSearching(false)
    }
  }

  const importTimeline = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    const fail = (cause: string, hint?: string, format?: string) => {
      setImportResult({ status: 'failure', fileName: file.name, format, cause, hint })
    }
    if (!/\.(json|geojson|gpx|kml|csv)$/i.test(file.name)) {
      fail('対応していないファイル形式です', '拡張子が .json / .geojson / .gpx / .kml / .csv のファイルを選択してください。ZIPファイルの場合は展開してから中のファイルを選んでください')
      return
    }
    if (file.size === 0) {
      fail('ファイルが空です（0バイト）', 'エクスポートが完了したファイルを選び直してください')
      return
    }
    if (file.size > 100 * 1024 * 1024) {
      fail(`ファイルが大きすぎます（${(file.size / 1024 / 1024).toFixed(1)}MB。上限は100MB）`, '期間を区切ってエクスポートするか、ファイルを分割してから取り込んでください')
      return
    }

    setImportingTimeline(true)
    setImportResult(null)
    setMessage('')
    try {
      let text: string
      try {
        text = await file.text()
      } catch {
        fail('ファイルを開けませんでした', 'クラウド上にしかないファイルの場合は、端末にダウンロードしてから選択してください')
        return
      }

      const { points: importedPoints, format, skipped } = parseLocationFile(file.name, text)
      const pointKey = (point: TrackPoint) => (
        `${point.recordedAt}|${point.latitude.toFixed(7)}|${point.longitude.toFixed(7)}`
      )
      const existingKeys = new Set(data.points.map(pointKey))
      const newPoints = importedPoints.filter((point) => !existingKeys.has(pointKey(point)))
      const summary = {
        fileName: file.name,
        format,
        total: importedPoints.length,
        added: newPoints.length,
        duplicates: importedPoints.length - newPoints.length,
        skipped,
        firstAt: importedPoints[0]?.recordedAt,
        lastAt: importedPoints[importedPoints.length - 1]?.recordedAt,
      }
      if (!newPoints.length) {
        setImportResult({ ...summary, status: 'nothing-new' })
        return
      }

      const nextData: AppData = {
        ...data,
        points: [...data.points, ...newPoints].sort(
          (left, right) => Date.parse(left.recordedAt) - Date.parse(right.recordedAt),
        ),
      }
      setData(nextData)
      const latestImportedPoint = newPoints[newPoints.length - 1]
      setCenterRequest([latestImportedPoint.latitude, latestImportedPoint.longitude])
      // Reflect the imported points in the account spreadsheet right away.
      const syncError = await syncData(nextData)
      setMessage('')
      setImportResult(syncError
        ? { ...summary, status: 'partial', syncError }
        : { ...summary, status: 'success' })
    } catch (error) {
      console.error('位置情報ファイルを読み込めませんでした。', error)
      if (error instanceof LocationImportError) {
        fail(error.message, error.hint)
      } else {
        fail(
          `予期しないエラーが発生しました（${error instanceof Error ? error.message : String(error)}）`,
          'ページを再読み込みしてからもう一度お試しください。解決しない場合は、このメッセージを管理者に伝えてください',
        )
      }
    } finally {
      setImportingTimeline(false)
    }
  }

  if (!authReady) {
    return (
      <main className="auth-shell">
        <section className="auth-card" aria-live="polite">
          <div className="auth-brand"><Footprints size={25} /><span>ashiato</span></div>
          <p className="auth-description">ログイン状態を確認しています…</p>
        </section>
      </main>
    )
  }

  if (!account) {
    return (
      <main className="auth-shell">
        <section className="auth-card">
          <div className="auth-brand"><Footprints size={25} /><span>ashiato</span></div>
          <div className="section-kicker">MY TRAVEL ALBUM</div>
          <h1>{authMode === 'login' ? 'ログイン' : authMode === 'register' ? 'アカウントを作成' : 'パスワードの再設定'}</h1>
          <p className="auth-description">
            {authMode === 'login'
              ? '旅の足跡とお気に入りスポットを開きます。'
              : authMode === 'register'
                ? 'メールアドレスとパスワードで利用者登録します。'
                : resetStep === 'request'
                  ? '登録したメールアドレスにワンタイムパスワードを送信します。'
                  : 'メールに届いたワンタイムパスワードと新しいパスワードを入力してください。'}
          </p>
          <form className="auth-form" onSubmit={submitAuthentication}>
            {authMode === 'register' && (
              <>
                <label className="field-label" htmlFor="auth-name">表示名</label>
                <input
                  id="auth-name"
                  className="text-field"
                  value={authName}
                  onChange={(event) => setAuthName(event.target.value)}
                  autoComplete="name"
                  maxLength={80}
                  required
                />
              </>
            )}
            <label className="field-label" htmlFor="auth-email">メールアドレス</label>
            <input
              id="auth-email"
              className="text-field"
              type="email"
              value={authEmail}
              onChange={(event) => setAuthEmail(event.target.value)}
              autoComplete="email"
              maxLength={254}
              readOnly={authMode === 'reset' && resetStep === 'confirm'}
              required
            />
            {authMode === 'reset' && resetStep === 'confirm' && (
              <>
                <label className="field-label" htmlFor="auth-reset-code">ワンタイムパスワード（6桁）</label>
                <input
                  id="auth-reset-code"
                  className="text-field"
                  value={resetCode}
                  onChange={(event) => setResetCode(event.target.value.replace(/[^0-9]/g, '').slice(0, 6))}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  required
                />
              </>
            )}
            {(authMode !== 'reset' || resetStep === 'confirm') && (
            <>
            <label className="field-label" htmlFor="auth-password">{authMode === 'reset' ? '新しいパスワード' : 'パスワード'}</label>
            <div className="password-field">
              <input
                id="auth-password"
                className="text-field"
                type={showPassword ? 'text' : 'password'}
                value={authPassword}
                onChange={(event) => setAuthPassword(event.target.value)}
                autoComplete={authMode === 'login' ? 'current-password' : 'new-password'}
                minLength={authMode === 'login' ? 1 : 12}
                maxLength={128}
                required
              />
              <button
                type="button"
                className="password-toggle"
                onClick={() => setShowPassword((visible) => !visible)}
                aria-label={showPassword ? 'パスワードを隠す' : 'パスワードを表示'}
              >
                {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
              </button>
            </div>
            </>
            )}
            {(authMode === 'register' || (authMode === 'reset' && resetStep === 'confirm')) && (
              <>
                <label className="field-label" htmlFor="auth-password-confirm">{authMode === 'reset' ? '新しいパスワード（確認）' : 'パスワード（確認）'}</label>
                <input
                  id="auth-password-confirm"
                  className="text-field"
                  type={showPassword ? 'text' : 'password'}
                  value={authPasswordConfirm}
                  onChange={(event) => setAuthPasswordConfirm(event.target.value)}
                  autoComplete="new-password"
                  minLength={12}
                  maxLength={128}
                  required
                />
              </>
            )}
            {authMode === 'register' && (
              <>
                <label className="auth-consent">
                  <input
                    type="checkbox"
                    checked={privacyAccepted}
                    onChange={(event) => setPrivacyAccepted(event.target.checked)}
                    required
                  />
                  <span>足跡・スポット情報が端末とアカウント用スプレッドシートに保存されることを確認しました。</span>
                </label>
              </>
            )}
            {authNotice && <p className="auth-notice" role="status">{authNotice}</p>}
            {authError && <p className="auth-error" role="alert">{authError}</p>}
            <button className="primary-button full-button auth-submit" type="submit" disabled={authBusy}>
              {authBusy
                ? '処理中…'
                : authMode === 'login'
                  ? 'ログイン'
                  : authMode === 'register'
                    ? '登録して開始'
                    : resetStep === 'request'
                      ? 'ワンタイムパスワードを送信'
                      : 'パスワードを変更してログイン'}
            </button>
          </form>
          {authMode === 'reset' && resetStep === 'confirm' && (
            <button className="auth-mode-toggle" type="button" disabled={authBusy} onClick={() => void requestPasswordReset()}>
              メールが届かない場合は再送信
            </button>
          )}
          {authMode === 'login' && (
            <button className="auth-mode-toggle" type="button" disabled={authBusy} onClick={() => switchAuthMode('reset')}>
              パスワードを忘れた方はこちら
            </button>
          )}
          <button
            className="auth-mode-toggle"
            type="button"
            disabled={authBusy}
            onClick={() => switchAuthMode(authMode === 'login' ? 'register' : 'login')}
          >
            {authMode === 'login' ? '初めて利用する方はこちら（新規登録）' : '登録済みの方はこちら（ログイン）'}
          </button>
          <p className="auth-footnote">パスワードは暗号学的ハッシュとして保存されます。</p>
        </section>
      </main>
    )
  }

  if (adminOpen && account.isAdmin) {
    return <AdminPage onClose={() => setAdminOpen(false)} />
  }

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
            <div className="section-kicker">IMPORT LOCATION FILE</div>
            <h2>位置情報ファイルをインポート</h2>
            <p className="muted-copy">GoogleマップのタイムラインJSON、GPX、KML、GeoJSON、CSV（緯度・経度・日時の列）からGPS地点を追加します。既存の地点は重複登録されません。</p>
            <input
              ref={timelineInputRef}
              className="visually-hidden"
              type="file"
              accept={LOCATION_FILE_ACCEPT}
              onChange={(event) => void importTimeline(event)}
              aria-label="位置情報ファイル"
            />
            <button
              className="secondary-button full-button"
              onClick={() => timelineInputRef.current?.click()}
              disabled={importingTimeline}
            >
              <FileUp size={17} />{importingTimeline ? '読み込み・同期中…' : 'ファイルを選択'}
            </button>
            <p className="small-muted">読み込んだ地点は端末に保存され、続けてアカウント（スプレッドシート）へ自動で同期されます。</p>
            <details className="import-guide">
              <summary>スマートフォンからタイムラインを書き出すには</summary>
              <p><strong>Android</strong>：端末の「設定」→「位置情報」→「位置情報サービス」→「タイムライン」→「タイムラインのデータをエクスポート」で保存したJSONファイルを選びます。</p>
              <p><strong>iPhone</strong>：Googleマップアプリのプロフィールアイコン →「設定」→「個人的なコンテンツ」→「タイムラインのデータをエクスポート」で「ファイル」に保存したJSONファイルを選びます。</p>
              <p>メニュー名は端末やアプリのバージョンによって異なる場合があります。ファイルが大きい場合は、端末に保存してから選択してください。</p>
            </details>
            <div className="settings-divider" />
            <div className="section-kicker">ACCOUNT & SYNC</div>
            <h2>ログイン中のアカウント</h2>
            <p className="account-details"><strong>{account.name}</strong><span>{account.email}</span></p>
            {account.isAdmin && (
              <button className="secondary-button full-button" onClick={() => { setAdminOpen(true); setMobileMenuOpen(false) }}>
                <ShieldCheck size={17} />管理者ページを開く
              </button>
            )}
            <button className="secondary-button full-button" onClick={() => void syncData()} disabled={syncing}>
              <Cloud size={17} />{syncing ? '同期中…' : 'アカウントに同期'}
            </button>
            <p className="small-muted">{hasSynced ? 'スプレッドシートに同期済み' : 'まだ同期されていません'}</p>
            <div className="privacy-note"><CircleHelp size={17} /><span>写真・動画ファイルはGoogle Driveに保存します。Drive連携はアカウントログインとは別に許可が必要です。</span></div>
            {Capacitor.isNativePlatform() && (
              <button className="secondary-button full-button" onClick={signIn}><Cloud size={17} />Google Driveを連携</button>
            )}
            <button className="text-button full-button" onClick={() => void logout()} disabled={authBusy}>
              {authBusy ? '処理中…' : 'ログアウト'}
            </button>
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
                <div className="list-filter" role="group" aria-label="リストで絞り込み">
                  <button type="button" className={listFilter === 'all' ? 'selected' : ''} aria-pressed={listFilter === 'all'} onClick={() => setListFilter('all')}>
                    すべて<span className="chip-count">{data.memories.length}</span>
                  </button>
                  {activeLists.map((list) => (
                    <button type="button" key={list.id} className={listFilter === list.id ? 'selected' : ''} aria-pressed={listFilter === list.id} onClick={() => setListFilter(list.id)}>
                      <MarkBadge mark={list.mark} size={18} />{list.name}<span className="chip-count">{listCounts.get(list.id) ?? 0}</span>
                    </button>
                  ))}
                  {(listCounts.get('none') ?? 0) > 0 && activeLists.length > 0 && (
                    <button type="button" className={listFilter === 'none' ? 'selected' : ''} aria-pressed={listFilter === 'none'} onClick={() => setListFilter('none')}>
                      未分類<span className="chip-count">{listCounts.get('none')}</span>
                    </button>
                  )}
                  <button type="button" className="list-add" onClick={() => setListEditor({ list: null })}><Plus size={13} />リスト</button>
                </div>
                {selectedList && (
                  <div className="list-header">
                    <MarkBadge mark={selectedList.mark} size={30} />
                    <span><strong>{selectedList.name}</strong><small>{listCounts.get(selectedList.id) ?? 0}件のお気に入り</small></span>
                    <button type="button" className="secondary-button" onClick={() => setListEditor({ list: selectedList })}>編集</button>
                  </div>
                )}
                {recentMemories.map((memory) => {
                  const mark = effectiveMark(memory, listsById)
                  const list = isInActiveList(memory) ? listsById.get(memory.listId ?? '') : undefined
                  return (
                  <button className="memory-card" key={memory.id} onClick={() => onSelectMemory(memory)}>
                    <MarkBadge mark={mark} size={34} />
                    <span className="memory-card-text"><strong>{memory.title}</strong>{list && listFilter === 'all' && <small className="memory-card-list">{list.name}</small>}<small>{memory.address || memory.note || `${memory.latitude.toFixed(4)}, ${memory.longitude.toFixed(4)}`}</small><small>{memory.isPublic ? 'おすすめとして公開中' : memory.driveFiles.length ? `写真・動画 ${memory.driveFiles.length}件` : '思い出を追加できます'}</small></span>
                    <ChevronDown size={16} className="memory-chevron" />
                  </button>
                  )
                })}
                {!recentMemories.length && (listFilter === 'all'
                  ? <div className="empty-points"><div className="empty-icon"><Heart size={22} /></div><strong>とっておきの場所を残そう</strong><span>記録した地点から、好きな場所をスポットにできます。</span></div>
                  : <div className="empty-points"><div className="empty-icon"><Heart size={22} /></div><strong>このリストはまだ空です</strong><span>お気に入りの詳細画面で、リストを選んで追加できます。</span></div>)}
              </div>
            )}
            <div className="sidebar-spacer" />
            <div className="sync-card">
              <div className="sync-card-icon"><Cloud size={18} /></div>
              <div><strong>思い出を同期</strong><span>{account.email}</span></div>
              <button onClick={() => void syncData()} disabled={syncing} aria-label="同期する"><Upload size={17} /></button>
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
            <button className="avatar-button" onClick={() => setTab('settings')} aria-label="アカウント設定">{account.name.slice(0, 1)}</button>
          </div>
        </header>
        <MapView
          points={data.points}
          memories={mapMemories}
          lists={data.lists}
          recommendations={recommendations}
          active={active}
          onSelect={onSelectMemory}
          onSelectRecommendation={onSelectRecommendation}
          onAddPoint={onAddPoint}
          centerRequest={centerRequest}
          searchResults={searchResults}
          selectedSearchResult={selectedSearchResult}
          searching={searching}
          searchError={searchError}
          onSearch={searchPlaces}
          onChooseSearchResult={setSelectedSearchResult}
        />
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
            <form className="spot-detail-form" onSubmit={saveMemoryDetails}>
              <label className="field-label">スポット名
                <input className="text-field" value={editSpotTitle} maxLength={200} onChange={(event) => setEditSpotTitle(event.target.value)} required />
              </label>
              <label className="field-label">住所
                <input className="text-field" value={editSpotAddress} maxLength={300} onChange={(event) => setEditSpotAddress(event.target.value)} placeholder="住所を入力" />
              </label>
              <label className="field-label">説明
                <textarea className="text-field note-field" value={editSpotNote} maxLength={2000} onChange={(event) => setEditSpotNote(event.target.value)} rows={3} />
              </label>
              <label className="visibility-option">
                <input type="checkbox" checked={editSpotIsPublic} onChange={(event) => setEditSpotIsPublic(event.target.checked)} />
                <span><strong>おすすめスポットとして公開</strong><small>公開すると、他のユーザーの地図に表示されます</small></span>
              </label>
              <label className="field-label">リスト
                <select className="text-field" value={editSpotListId} onChange={(event) => setEditSpotListId(event.target.value)}>
                  <option value="">未分類</option>
                  {activeLists.map((list) => <option key={list.id} value={list.id}>{list.mark.symbol} {list.name}</option>)}
                </select>
              </label>
              <span className="field-label">マーク</span>
              <MarkPicker value={editSpotMark} onChange={setEditSpotMark} inheritFrom={listMarkFor(editSpotListId)} />
              <button className="primary-button full-button" type="submit" disabled={syncing}><Check size={16} />変更を保存</button>
            </form>
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
        {selectedRecommendation && (
          <div className="memory-detail">
            <button className="detail-close icon-button" onClick={() => setSelectedRecommendation(null)} aria-label="閉じる"><X size={18} /></button>
            <div className="detail-kicker recommendation-kicker"><MapPin size={14} /> USER RECOMMENDATION</div>
            <h2>{selectedRecommendation.title}</h2>
            {selectedRecommendation.address && <p>{selectedRecommendation.address}</p>}
            {selectedRecommendation.note && <p>{selectedRecommendation.note}</p>}
            <div className="detail-coordinate">{selectedRecommendation.latitude.toFixed(5)}°, {selectedRecommendation.longitude.toFixed(5)}°</div>
            <p className="recommendation-owner">おすすめした人：{selectedRecommendation.ownerName}</p>
          </div>
        )}
        {selectedSearchResult && (
          <div className="memory-detail search-place-detail">
            <button className="detail-close icon-button" onClick={() => {
              setSelectedSearchResult(null)
              setSearchResults([])
              setSearchError('')
            }} aria-label="閉じる"><X size={18} /></button>
            <div className="detail-kicker search-place-kicker"><MapPin size={14} /> SEARCH RESULT</div>
            <h2>{selectedSearchResult.name}</h2>
            <p>{selectedSearchResult.address}</p>
            {selectedSearchResult.category && <p>場所の種類：{selectedSearchResult.category}</p>}
            <div className="detail-coordinate">
              {selectedSearchResult.latitude.toFixed(5)}°, {selectedSearchResult.longitude.toFixed(5)}°
            </div>
            <p className="search-place-source">場所情報：OpenStreetMap contributors</p>
          </div>
        )}
      </section>

      {importResult && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setImportResult(null) }}>
          <section className={`save-dialog import-result ${importResult.status}`} role="alertdialog" aria-labelledby="import-result-title">
            <button type="button" className="dialog-close icon-button" onClick={() => setImportResult(null)} aria-label="閉じる"><X size={18} /></button>
            <div className="dialog-icon">{importResult.status === 'failure' ? <X size={20} /> : importResult.status === 'partial' ? <CircleHelp size={20} /> : <Check size={20} />}</div>
            <div className="section-kicker">IMPORT RESULT</div>
            <h2 id="import-result-title">
              {importResult.status === 'success' && 'インポートに成功しました'}
              {importResult.status === 'partial' && '端末には追加しましたが、同期に失敗しました'}
              {importResult.status === 'nothing-new' && '追加する新しい地点はありませんでした'}
              {importResult.status === 'failure' && 'インポートに失敗しました'}
            </h2>
            <p className="import-file">{importResult.fileName}{importResult.format ? `（${importResult.format}）` : ''}</p>
            {importResult.status !== 'failure' && (
              <dl className="import-stats">
                <div><dt>ファイル内の地点</dt><dd>{(importResult.total ?? 0).toLocaleString()} 件</dd></div>
                <div><dt>新しく追加</dt><dd><strong>{(importResult.added ?? 0).toLocaleString()} 件</strong></dd></div>
                <div><dt>登録済みのためスキップ</dt><dd>{(importResult.duplicates ?? 0).toLocaleString()} 件</dd></div>
                {!!importResult.skipped && <div><dt>日時がないため除外</dt><dd>{importResult.skipped.toLocaleString()} 件</dd></div>}
                {importResult.firstAt && importResult.lastAt && (
                  <div className="wide"><dt>記録の期間</dt><dd>{new Date(importResult.firstAt).toLocaleString('ja-JP')} 〜 {new Date(importResult.lastAt).toLocaleString('ja-JP')}</dd></div>
                )}
                {(importResult.added ?? 0) > 0 && (
                  <div className="wide"><dt>アカウントへの同期</dt><dd>{importResult.syncError ? '失敗' : '完了（スプレッドシートに反映済み）'}</dd></div>
                )}
              </dl>
            )}
            {importResult.status === 'failure' && (
              <div className="import-cause">
                <strong>原因</strong>
                <p>{importResult.cause}</p>
                {importResult.hint && (<><strong>対処方法</strong><p>{importResult.hint}</p></>)}
              </div>
            )}
            {importResult.status === 'partial' && (
              <div className="import-cause">
                <strong>同期できなかった原因</strong>
                <p>{importResult.syncError}</p>
                <strong>対処方法</strong>
                <p>取り込んだ地点は端末に保存されています。通信状態を確認し、「アカウントに同期」を押して再度同期してください。</p>
              </div>
            )}
            {importResult.status === 'nothing-new' && (
              <p className="import-note">ファイル内の地点はすべて登録済みです。同じファイルを再度取り込んだ可能性があります。</p>
            )}
            <div className="import-actions">
              {importResult.status === 'partial' && (
                <button type="button" className="secondary-button" onClick={() => { setImportResult(null); void syncData() }} disabled={syncing}><Cloud size={16} />もう一度同期</button>
              )}
              {importResult.status === 'failure' && (
                <button type="button" className="secondary-button" onClick={() => { setImportResult(null); timelineInputRef.current?.click() }}><FileUp size={16} />別のファイルを選ぶ</button>
              )}
              {(importResult.added ?? 0) > 0 ? (
                <button type="button" className="primary-button" onClick={() => { setImportResult(null); setTab('map'); setMobileMenuOpen(false) }}><MapPin size={16} />地図で見る</button>
              ) : (
                <button type="button" className="primary-button" onClick={() => setImportResult(null)}>閉じる</button>
              )}
            </div>
          </section>
        </div>
      )}
      {listEditor && (
        <ListEditorDialog
          key={listEditor.list?.id ?? 'new'}
          list={listEditor.list}
          favoriteCount={listEditor.list ? listCounts.get(listEditor.list.id) ?? 0 : 0}
          onSave={saveList}
          onDelete={() => { if (listEditor.list) deleteList(listEditor.list) }}
          onClose={() => setListEditor(null)}
        />
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
            <input id="spot-title" className="text-field" value={spotTitle} maxLength={200} onChange={(event) => setSpotTitle(event.target.value)} placeholder="例：夕焼けがきれいな丘" required autoFocus />
            <label className="field-label" htmlFor="spot-address">住所 <span>任意</span></label>
            <input id="spot-address" className="text-field" value={spotAddress} maxLength={300} onChange={(event) => setSpotAddress(event.target.value)} placeholder="住所を入力" />
            <label className="field-label" htmlFor="spot-note">説明 <span>任意</span></label>
            <textarea id="spot-note" className="text-field note-field" value={spotNote} maxLength={2000} onChange={(event) => setSpotNote(event.target.value)} placeholder="場所のおすすめポイントや思い出" rows={3} />
            <label className="visibility-option">
                <input type="checkbox" checked={spotIsPublic} onChange={(event) => setSpotIsPublic(event.target.checked)} />
              <span><strong>おすすめスポットとして公開</strong><small>公開すると、他のユーザーの地図に表示されます</small></span>
            </label>
            <label className="field-label" htmlFor="spot-list">リスト</label>
            <select id="spot-list" className="text-field" value={spotListId} onChange={(event) => setSpotListId(event.target.value)}>
              <option value="">未分類</option>
              {activeLists.map((list) => <option key={list.id} value={list.id}>{list.mark.symbol} {list.name}</option>)}
            </select>
            <span className="field-label">マーク</span>
            <MarkPicker value={spotMark} onChange={setSpotMark} inheritFrom={listMarkFor(spotListId)} />
            <button className="primary-button full-button" type="submit" disabled={syncing}><Heart size={17} />スポットに保存</button>
          </form>
        </div>
      )}
    </main>
  )
}

export default App
