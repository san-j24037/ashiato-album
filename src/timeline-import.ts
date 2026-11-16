import type { TrackPoint } from './types'

export const MAX_IMPORTED_POINTS = 200_000

type JsonRecord = Record<string, unknown>

/** An import failure with a user-facing cause (message) and what to do about it (hint). */
export class LocationImportError extends Error {
  readonly hint?: string

  constructor(message: string, hint?: string) {
    super(message)
    this.name = 'LocationImportError'
    this.hint = hint
  }
}

export type TimedLocation = { latitude: number; longitude: number; accuracy: number; recordedAt: string }

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseTimestamp(value: unknown): number | null {
  if (typeof value === 'number' || (typeof value === 'string' && /^\d{10,13}$/.test(value))) {
    const numeric = Number(value)
    if (!Number.isFinite(numeric)) return null
    const milliseconds = numeric < 100_000_000_000 ? numeric * 1000 : numeric
    return Number.isFinite(new Date(milliseconds).getTime()) ? milliseconds : null
  }
  if (typeof value !== 'string' || !value.trim()) return null
  const parsed = Date.parse(value.trim())
  return Number.isFinite(parsed) ? parsed : null
}

export function isValidLatLng(latitude: number, longitude: number): boolean {
  return Number.isFinite(latitude) && latitude >= -90 && latitude <= 90
    && Number.isFinite(longitude) && longitude >= -180 && longitude <= 180
}

/** Parses "geo:35.1,139.2", "35.1°, 139.2°" or "35.1,139.2". */
function parseCoordinateString(value: string): [number, number] | null {
  const match = /^\s*(?:geo:\s*)?(-?\d+(?:\.\d+)?)\s*°?\s*,\s*(-?\d+(?:\.\d+)?)\s*°?/i.exec(value)
  if (!match) return null
  const latitude = Number(match[1])
  const longitude = Number(match[2])
  return isValidLatLng(latitude, longitude) ? [latitude, longitude] : null
}

function parseCoordinate(value: unknown): [number, number] | null {
  if (typeof value === 'string') return parseCoordinateString(value)
  if (!isRecord(value)) return null
  for (const key of ['point', 'latLng', 'LatLng', 'placeLocation']) {
    const nested = value[key]
    if (typeof nested === 'string' || isRecord(nested)) {
      const parsed = parseCoordinate(nested)
      if (parsed) return parsed
    }
  }
  const latitudeValue = value.latitude ?? value.lat ?? value.latitudeE7 ?? value.latE7
  const longitudeValue = value.longitude ?? value.lng ?? value.longitudeE7 ?? value.lngE7
  if (typeof latitudeValue !== 'number' || typeof longitudeValue !== 'number') return null
  const isE7 = 'latitudeE7' in value || 'longitudeE7' in value || 'latE7' in value || 'lngE7' in value
  const latitude = isE7 ? latitudeValue / 10_000_000 : latitudeValue
  const longitude = isE7 ? longitudeValue / 10_000_000 : longitudeValue
  return isValidLatLng(latitude, longitude) ? [latitude, longitude] : null
}

function accuracyOf(record: JsonRecord): number {
  const accuracy = Number(record.accuracy ?? record.accuracyMeters)
  return Number.isFinite(accuracy) && accuracy >= 0 ? accuracy : 0
}

export function pushLocation(output: TimedLocation[], latitude: number, longitude: number, time: number, accuracy = 0) {
  if (!isValidLatLng(latitude, longitude) || !Number.isFinite(time)) return
  output.push({ latitude, longitude, accuracy, recordedAt: new Date(time).toISOString() })
  if (output.length > MAX_IMPORTED_POINTS) {
    throw new LocationImportError(
      `GPS地点が多すぎます（1ファイル${MAX_IMPORTED_POINTS.toLocaleString()}件まで）`,
      '期間を区切ってエクスポートするか、ファイルを分割してから取り込んでください',
    )
  }
}

function addPoint(output: TimedLocation[], coordinate: unknown, timestamp: unknown, accuracy = 0) {
  const parsedCoordinate = parseCoordinate(coordinate)
  const time = parseTimestamp(timestamp)
  if (!parsedCoordinate || time === null) return
  pushLocation(output, parsedCoordinate[0], parsedCoordinate[1], time, accuracy)
}

function addWaypointPath(output: TimedLocation[], waypoints: unknown, startTime: unknown, endTime: unknown) {
  if (!Array.isArray(waypoints) || !waypoints.length) return
  const start = parseTimestamp(startTime)
  const end = parseTimestamp(endTime)
  waypoints.forEach((waypoint, index) => {
    if (!isRecord(waypoint)) return
    const timestamp = waypoint.time ?? waypoint.timestamp ?? (
      start !== null && end !== null
        ? new Date(start + (end - start) * (waypoints.length === 1 ? 0 : index / (waypoints.length - 1))).toISOString()
        : null
    )
    addPoint(output, waypoint, timestamp, accuracyOf(waypoint))
  })
}

function parseTimelineObject(output: TimedLocation[], value: unknown) {
  if (!isRecord(value)) return
  const segment = isRecord(value.activitySegment) ? value.activitySegment : null
  const visit = isRecord(value.placeVisit) ? value.placeVisit : null

  if (segment) {
    const duration = isRecord(segment.duration) ? segment.duration : {}
    const startTime = duration.startTimestamp ?? segment.startTime
    const endTime = duration.endTimestamp ?? segment.endTime
    addWaypointPath(output, isRecord(segment.waypointPath) ? segment.waypointPath.waypoints : null, startTime, endTime)
    addWaypointPath(output, isRecord(segment.simplifiedRawPath) ? segment.simplifiedRawPath.points : null, startTime, endTime)
    addPoint(output, segment.startLocation, startTime)
    addPoint(output, segment.endLocation, endTime)
  }

  if (visit) {
    const duration = isRecord(visit.duration) ? visit.duration : {}
    const location = isRecord(visit.location) ? visit.location : null
    if (location) {
      addPoint(output, location, duration.startTimestamp ?? visit.startTime)
      addPoint(output, location, duration.endTimestamp ?? visit.endTime)
    }
  }
}

/**
 * On-device Timeline segment (Android "semanticSegments" item, or an element of the
 * top-level array exported by Google Maps for iOS).
 */
function parseSemanticSegment(output: TimedLocation[], segment: JsonRecord) {
  const startTime = segment.startTime
  const endTime = segment.endTime
  const start = parseTimestamp(startTime)

  if (Array.isArray(segment.timelinePath)) {
    for (const pathPoint of segment.timelinePath) {
      if (!isRecord(pathPoint)) continue
      let timestamp: unknown = pathPoint.time ?? pathPoint.timestamp
      const offset = Number(pathPoint.durationMinutesOffsetFromStartTime)
      if (timestamp === undefined && start !== null && Number.isFinite(offset)) {
        timestamp = start + offset * 60_000
      }
      addPoint(output, pathPoint, timestamp, accuracyOf(pathPoint))
    }
  }

  const visit = isRecord(segment.visit) ? segment.visit : null
  const visitPlace = visit && isRecord(visit.topCandidate) ? visit.topCandidate.placeLocation : null
  if (visitPlace) {
    addPoint(output, visitPlace, startTime)
    addPoint(output, visitPlace, endTime)
  }

  const activity = isRecord(segment.activity) ? segment.activity : null
  if (activity) {
    addPoint(output, activity.start, startTime)
    addPoint(output, activity.end, endTime)
  }

  addPoint(output, segment.startLocation, startTime)
  addPoint(output, segment.endLocation, endTime)
}

export function parseTimelinePoints(value: unknown): TrackPoint[] {
  const points: TimedLocation[] = []

  if (Array.isArray(value)) {
    for (const segment of value) {
      if (isRecord(segment)) parseSemanticSegment(points, segment)
    }
  } else if (isRecord(value)) {
    if (Array.isArray(value.locations)) {
      for (const location of value.locations) {
        if (!isRecord(location)) continue
        addPoint(points, location, location.timestampMs ?? location.timestamp, accuracyOf(location))
      }
    }
    if (Array.isArray(value.semanticSegments)) {
      for (const segment of value.semanticSegments) {
        if (isRecord(segment)) parseSemanticSegment(points, segment)
      }
    }
    if (Array.isArray(value.rawSignals)) {
      for (const signal of value.rawSignals) {
        if (!isRecord(signal) || !isRecord(signal.position)) continue
        const position = signal.position
        addPoint(points, position, position.timestamp, accuracyOf(position))
      }
    }
    if (Array.isArray(value.timelineObjects)) {
      for (const item of value.timelineObjects) parseTimelineObject(points, item)
    }
  } else {
    throw new LocationImportError('タイムラインJSONの形式ではありません', 'スマートフォンのGoogleマップ（タイムライン）からエクスポートしたJSONファイルか確認してください。Googleデータエクスポートの場合は「Semantic Location History」フォルダ内のJSONも選べます')
  }

  if (!points.length) {
    throw new LocationImportError(
      'ファイル内にGPS地点（緯度・経度と日時）が見つかりませんでした',
      'スマートフォンのGoogleマップ（タイムライン）からエクスポートしたJSONファイルか確認してください。Googleデータエクスポートの場合は「Semantic Location History」フォルダ内のJSONも選べます。タイムラインが空の期間をエクスポートした可能性もあります',
    )
  }
  return finalizePoints(points)
}

/** Removes duplicates, sorts by time and assigns ids. */
export function finalizePoints(points: TimedLocation[]): TrackPoint[] {
  const uniquePoints = new Map<string, TimedLocation>()
  for (const point of points) {
    const key = `${point.recordedAt}|${point.latitude.toFixed(7)}|${point.longitude.toFixed(7)}`
    uniquePoints.set(key, point)
  }
  return [...uniquePoints.values()]
    .sort((left, right) => Date.parse(left.recordedAt) - Date.parse(right.recordedAt))
    .map((point) => ({ ...point, id: crypto.randomUUID() }))
}
