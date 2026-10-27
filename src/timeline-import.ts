import type { TrackPoint } from './types'

const MAX_IMPORTED_POINTS = 200_000

type JsonRecord = Record<string, unknown>
type TimedLocation = { latitude: number; longitude: number; accuracy: number; recordedAt: string }

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value === 'number' || (typeof value === 'string' && /^\d{10,13}$/.test(value))) {
    const numeric = Number(value)
    if (!Number.isFinite(numeric)) return null
    const milliseconds = numeric < 100_000_000_000 ? numeric * 1000 : numeric
    return Number.isFinite(new Date(milliseconds).getTime()) ? milliseconds : null
  }
  if (typeof value !== 'string') return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function parseCoordinate(value: unknown): [number, number] | null {
  if (!isRecord(value)) return null
  let latitude: number
  let longitude: number
  if (typeof value.point === 'string') {
    const match = /^geo:\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/i.exec(value.point)
    if (!match) return null
    latitude = Number(match[1])
    longitude = Number(match[2])
  } else {
    const latitudeValue = value.latitude ?? value.lat ?? value.latitudeE7 ?? value.latE7
    const longitudeValue = value.longitude ?? value.lng ?? value.longitudeE7 ?? value.lngE7
    if (typeof latitudeValue !== 'number' || typeof longitudeValue !== 'number') return null
    const isE7 = 'latitudeE7' in value || 'longitudeE7' in value || 'latE7' in value || 'lngE7' in value
    latitude = isE7 ? latitudeValue / 10_000_000 : latitudeValue
    longitude = isE7 ? longitudeValue / 10_000_000 : longitudeValue
  }
  if (
    !Number.isFinite(latitude) || latitude < -90 || latitude > 90
    || !Number.isFinite(longitude) || longitude < -180 || longitude > 180
  ) return null
  return [latitude, longitude]
}

function accuracyOf(record: JsonRecord): number {
  const accuracy = record.accuracy ?? record.accuracyMeters
  return typeof accuracy === 'number' && Number.isFinite(accuracy) && accuracy >= 0 ? accuracy : 0
}

function addPoint(
  output: TimedLocation[],
  coordinate: unknown,
  timestamp: unknown,
  accuracy = 0,
) {
  const parsedCoordinate = parseCoordinate(coordinate)
  const time = parseTimestamp(timestamp)
  if (!parsedCoordinate || time === null) return
  output.push({
    latitude: parsedCoordinate[0],
    longitude: parsedCoordinate[1],
    accuracy,
    recordedAt: new Date(time).toISOString(),
  })
  if (output.length > MAX_IMPORTED_POINTS) {
    throw new Error(`読み込めるGPS地点は${MAX_IMPORTED_POINTS.toLocaleString()}件までです`)
  }
}

function addWaypointPath(
  output: TimedLocation[],
  waypoints: unknown,
  startTime: unknown,
  endTime: unknown,
) {
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

export function parseTimelinePoints(value: unknown): TrackPoint[] {
  if (!isRecord(value)) throw new Error('JSONの形式を確認してください')

  const points: TimedLocation[] = []
  if (Array.isArray(value.locations)) {
    for (const location of value.locations) {
      if (!isRecord(location)) continue
      addPoint(points, location, location.timestampMs ?? location.timestamp, accuracyOf(location))
    }
  }

  if (Array.isArray(value.semanticSegments)) {
    for (const segment of value.semanticSegments) {
      if (!isRecord(segment)) continue
      if (Array.isArray(segment.timelinePath)) {
        for (const pathPoint of segment.timelinePath) {
          if (!isRecord(pathPoint)) continue
          addPoint(points, pathPoint, pathPoint.time ?? pathPoint.timestamp, accuracyOf(pathPoint))
        }
      }
      addPoint(points, segment.startLocation, segment.startTime)
      addPoint(points, segment.endLocation, segment.endTime)
    }
  }

  if (Array.isArray(value.timelineObjects)) {
    for (const item of value.timelineObjects) parseTimelineObject(points, item)
  }

  if (!points.length) {
    throw new Error('GPS地点が見つかりません。Google MapsのタイムラインJSONを選択してください')
  }

  const uniquePoints = new Map<string, TimedLocation>()
  for (const point of points) {
    const key = `${point.recordedAt}|${point.latitude.toFixed(7)}|${point.longitude.toFixed(7)}`
    uniquePoints.set(key, point)
  }

  return [...uniquePoints.values()]
    .sort((left, right) => Date.parse(left.recordedAt) - Date.parse(right.recordedAt))
    .map((point) => ({ ...point, id: crypto.randomUUID() }))
}
