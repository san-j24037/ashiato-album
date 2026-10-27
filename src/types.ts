export type TrackPoint = {
  id: string
  latitude: number
  longitude: number
  accuracy: number
  recordedAt: string
}

export type Memory = {
  id: string
  title: string
  address: string
  note: string
  isPublic: boolean
  latitude: number
  longitude: number
  createdAt: string
  driveFiles: { id: string; name: string; url: string; mimeType: string }[]
}

export type PublicMemory = Memory & { ownerName: string }

export type AppData = {
  points: TrackPoint[]
  memories: Memory[]
}

export const emptyAppData: AppData = { points: [], memories: [] }
