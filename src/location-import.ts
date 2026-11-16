import {
  finalizePoints,
  isValidLatLng,
  parseTimelinePoints,
  parseTimestamp,
  pushLocation,
  type TimedLocation,
} from './timeline-import'
import type { TrackPoint } from './types'

/** File extensions accepted by the location import. */
export const LOCATION_FILE_ACCEPT = '.json,.geojson,.gpx,.kml,.csv,application/json,application/geo+json,application/gpx+xml,application/vnd.google-earth.kml+xml,text/csv'

export type LocationImportResult = { points: TrackPoint[]; format: string; skipped: number }

type Collector = { points: TimedLocation[]; skipped: number }

const NO_TIME_MESSAGE = '日時が記録されていない地点は取り込めません'

/** Parses a location history / track file by its extension (falling back to its content). */
export function parseLocationFile(fileName: string, text: string): LocationImportResult {
  const extension = fileName.toLowerCase().split('.').pop() ?? ''
  const trimmed = text.replace(/^﻿/, '').trimStart()

  if (extension === 'gpx' || (extension !== 'kml' && /^<\?xml[\s\S]{0,500}<gpx[\s>]/i.test(trimmed))) {
    return finish(parseGpx(trimmed), 'GPX')
  }
  if (extension === 'kml' || /^<\?xml[\s\S]{0,500}<kml[\s>]/i.test(trimmed)) {
    return finish(parseKml(trimmed), 'KML')
  }
  if (extension === 'csv') {
    return finish(parseCsv(trimmed), 'CSV')
  }

  let json: unknown
  try {
    json = JSON.parse(trimmed) as unknown
  } catch {
    throw new Error('ファイルを読み取れません。JSON・GeoJSON・GPX・KML・CSVのいずれかを選択してください')
  }
  if (isGeoJson(json)) return finish(parseGeoJson(json), 'GeoJSON')
  return { points: parseTimelinePoints(json), format: 'Googleタイムライン', skipped: 0 }
}

function finish(collector: Collector, format: string): LocationImportResult {
  if (!collector.points.length) {
    throw new Error(collector.skipped
      ? `${format}ファイルに${collector.skipped.toLocaleString()}件の地点がありましたが、${NO_TIME_MESSAGE}`
      : `${format}ファイルにGPS地点が見つかりません`)
  }
  return { points: finalizePoints(collector.points), format, skipped: collector.skipped }
}

function add(collector: Collector, latitude: number, longitude: number, time: number | null, accuracy = 0) {
  if (!isValidLatLng(latitude, longitude)) return
  if (time === null) {
    collector.skipped += 1
    return
  }
  pushLocation(collector.points, latitude, longitude, time, accuracy)
}

// ---------- XML (GPX / KML) ----------

function parseXml(text: string, label: string): Document {
  const document = new DOMParser().parseFromString(text, 'application/xml')
  if (document.getElementsByTagName('parsererror').length) {
    throw new Error(`${label}ファイルを読み取れません。ファイルの内容を確認してください`)
  }
  return document
}

function elements(root: Document | Element, localName: string): Element[] {
  return Array.from(root.getElementsByTagNameNS('*', localName))
}

function childText(element: Element, localName: string): string | null {
  for (const child of Array.from(element.children)) {
    if (child.localName === localName) return child.textContent?.trim() ?? null
  }
  return null
}

function parseGpx(text: string): Collector {
  const document = parseXml(text, 'GPX')
  const collector: Collector = { points: [], skipped: 0 }
  for (const tag of ['trkpt', 'rtept', 'wpt']) {
    for (const point of elements(document, tag)) {
      const latitude = Number(point.getAttribute('lat'))
      const longitude = Number(point.getAttribute('lon'))
      const hdop = Number(childText(point, 'hdop'))
      add(collector, latitude, longitude, parseTimestamp(childText(point, 'time')), Number.isFinite(hdop) && hdop > 0 ? hdop * 5 : 0)
    }
  }
  return collector
}

/** KML coordinates are "lon,lat[,alt]" tuples separated by whitespace. */
function kmlCoordinates(text: string | null): [number, number][] {
  if (!text) return []
  return text.trim().split(/\s+/).map((tuple) => {
    const [longitude, latitude] = tuple.split(',').map(Number)
    return [latitude, longitude] as [number, number]
  }).filter(([latitude, longitude]) => isValidLatLng(latitude, longitude))
}

function parseKml(text: string): Collector {
  const document = parseXml(text, 'KML')
  const collector: Collector = { points: [], skipped: 0 }

  // gx:Track — parallel <when> and <gx:coord> ("lon lat alt") lists.
  for (const track of elements(document, 'Track')) {
    const whens = Array.from(track.children).filter((child) => child.localName === 'when')
    const coords = Array.from(track.children).filter((child) => child.localName === 'coord')
    coords.forEach((coord, index) => {
      const [longitude, latitude] = (coord.textContent ?? '').trim().split(/\s+/).map(Number)
      add(collector, latitude, longitude, parseTimestamp(whens[index]?.textContent ?? null))
    })
  }

  for (const placemark of elements(document, 'Placemark')) {
    if (elements(placemark, 'Track').length) continue
    const timeStamp = elements(placemark, 'TimeStamp')[0]
    const timeSpan = elements(placemark, 'TimeSpan')[0]
    const when = timeStamp ? parseTimestamp(childText(timeStamp, 'when')) : null
    const begin = timeSpan ? parseTimestamp(childText(timeSpan, 'begin')) : null
    const end = timeSpan ? parseTimestamp(childText(timeSpan, 'end')) : null

    for (const point of elements(placemark, 'Point')) {
      for (const [latitude, longitude] of kmlCoordinates(childText(point, 'coordinates'))) {
        add(collector, latitude, longitude, when ?? begin)
      }
    }
    for (const line of elements(placemark, 'LineString')) {
      const coordinates = kmlCoordinates(childText(line, 'coordinates'))
      coordinates.forEach(([latitude, longitude], index) => {
        const time = begin !== null && end !== null
          ? begin + (end - begin) * (coordinates.length === 1 ? 0 : index / (coordinates.length - 1))
          : when
        add(collector, latitude, longitude, time)
      })
    }
  }
  return collector
}

// ---------- GeoJSON ----------

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isGeoJson(value: unknown): value is JsonRecord {
  return isRecord(value) && ['FeatureCollection', 'Feature', 'Point', 'LineString', 'MultiLineString', 'MultiPoint'].includes(String(value.type))
}

function propertyTime(properties: JsonRecord): number | null {
  for (const key of ['time', 'timestamp', 'datetime', 'date', 'recordedAt', 'when']) {
    const time = parseTimestamp(properties[key])
    if (time !== null) return time
  }
  return null
}

function parseGeoJson(root: JsonRecord): Collector {
  const collector: Collector = { points: [], skipped: 0 }
  const features: JsonRecord[] = root.type === 'FeatureCollection' && Array.isArray(root.features)
    ? root.features.filter(isRecord)
    : root.type === 'Feature' ? [root] : [{ type: 'Feature', geometry: root, properties: {} }]

  for (const feature of features) {
    const geometry = isRecord(feature.geometry) ? feature.geometry : null
    const properties = isRecord(feature.properties) ? feature.properties : {}
    if (!geometry || !Array.isArray(geometry.coordinates)) continue
    const featureTime = propertyTime(properties)
    const accuracyValue = Number(properties.accuracy)
    const accuracy = Number.isFinite(accuracyValue) && accuracyValue >= 0 ? accuracyValue : 0

    const addPosition = (position: unknown, time: number | null) => {
      if (!Array.isArray(position)) return
      const [longitude, latitude, , fourth] = position.map(Number)
      // A 4th coordinate is sometimes a UNIX timestamp.
      const embedded = Number.isFinite(fourth) && fourth > 1_000_000_000 ? parseTimestamp(fourth) : null
      add(collector, latitude, longitude, time ?? embedded, accuracy)
    }
    const addLine = (line: unknown, times: unknown) => {
      if (!Array.isArray(line)) return
      line.forEach((position, index) => {
        const time = Array.isArray(times) ? parseTimestamp(times[index]) : featureTime
        addPosition(position, time)
      })
    }

    const coordTimes = properties.coordTimes ?? properties.times
    if (geometry.type === 'Point') addPosition(geometry.coordinates, featureTime)
    else if (geometry.type === 'MultiPoint') addLine(geometry.coordinates, coordTimes)
    else if (geometry.type === 'LineString') addLine(geometry.coordinates, coordTimes)
    else if (geometry.type === 'MultiLineString') {
      geometry.coordinates.forEach((line, index) => {
        addLine(line, Array.isArray(coordTimes) && Array.isArray(coordTimes[index]) ? coordTimes[index] : coordTimes)
      })
    }
  }
  return collector
}

// ---------- CSV ----------

function splitCsvLine(line: string, delimiter: string): string[] {
  const cells: string[] = []
  let current = ''
  let quoted = false
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]
    if (quoted) {
      if (character === '"' && line[index + 1] === '"') {
        current += '"'
        index += 1
      } else if (character === '"') {
        quoted = false
      } else {
        current += character
      }
    } else if (character === '"') {
      quoted = true
    } else if (character === delimiter) {
      cells.push(current.trim())
      current = ''
    } else {
      current += character
    }
  }
  cells.push(current.trim())
  return cells
}

/** "2024/5/1 9:05:00" → "2024-05-01T09:05:00" (local time); other formats pass through. */
function normalizeDateText(value: string | undefined): string | null {
  if (!value) return null
  const match = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(\.\d+)?)?)?(.*)$/.exec(value.trim())
  if (!match) return value
  const [, year, month, day, hour = '0', minute = '00', second = '00', fraction = '', rest] = match
  const pad = (part: string) => part.padStart(2, '0')
  return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${minute}:${second}${fraction}${rest.trim()}`
}

function findColumn(headers: string[], names: string[]): number {
  return headers.findIndex((header) => names.includes(header))
}

function parseCsv(text: string): Collector {
  const lines = text.split(/\r?\n/).filter((line) => line.trim())
  if (lines.length < 2) throw new Error('CSVファイルにデータ行がありません')
  const delimiter = lines[0].includes('\t') ? '\t' : lines[0].includes(';') && !lines[0].includes(',') ? ';' : ','
  const headers = splitCsvLine(lines[0], delimiter).map((header) => header.toLowerCase().replace(/[\s_()（）]/g, ''))

  const latitudeColumn = findColumn(headers, ['latitude', 'lat', '緯度'])
  const longitudeColumn = findColumn(headers, ['longitude', 'lon', 'lng', 'long', '経度'])
  const timeColumn = findColumn(headers, ['time', 'timestamp', 'datetime', 'recordedat', 'date', '日時', '記録日時', '時刻', '日付'])
  const dateColumn = findColumn(headers, ['date', '日付'])
  const clockColumn = findColumn(headers, ['time', '時刻'])
  const accuracyColumn = findColumn(headers, ['accuracy', 'accuracym', '精度', 'hdop'])
  if (latitudeColumn < 0 || longitudeColumn < 0) {
    throw new Error('CSVの1行目に緯度・経度の列名（latitude / longitude、または 緯度 / 経度）が必要です')
  }
  if (timeColumn < 0) {
    throw new Error('CSVの1行目に日時の列名（time / timestamp / 日時 など）が必要です')
  }

  const collector: Collector = { points: [], skipped: 0 }
  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line, delimiter)
    // A separate date column + time-of-day column ("2024-05-01" + "10:00:00") is joined.
    const timeText = dateColumn >= 0 && clockColumn >= 0 && dateColumn !== clockColumn && /^\d{1,2}:\d{2}/.test(cells[clockColumn] ?? '')
      ? `${cells[dateColumn]} ${cells[clockColumn]}`
      : cells[timeColumn]
    const accuracy = accuracyColumn >= 0 ? Number(cells[accuracyColumn]) : 0
    add(
      collector,
      Number(cells[latitudeColumn]),
      Number(cells[longitudeColumn]),
      parseTimestamp(normalizeDateText(timeText)),
      Number.isFinite(accuracy) && accuracy >= 0 ? accuracy : 0,
    )
  }
  return collector
}
