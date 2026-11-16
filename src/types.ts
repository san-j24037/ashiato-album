export type TrackPoint = {
  id: string
  latitude: number
  longitude: number
  accuracy: number
  recordedAt: string
}

/** A symbol and colour shown on the map and in lists. */
export type Mark = { symbol: string; color: string }

/** A user-defined group of favorites. Deleted lists keep a tombstone (deletedAt) so sync can propagate the deletion. */
export type FavoriteList = {
  id: string
  name: string
  mark: Mark
  createdAt: string
  updatedAt: string
  deletedAt?: string
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
  /** Id of the FavoriteList this favorite belongs to; '' = not in a list. */
  listId?: string
  /** Own mark; null/undefined = use the list's mark (or the default). */
  mark?: Mark | null
}

export type PublicMemory = Memory & { ownerName: string }

export type AppData = {
  points: TrackPoint[]
  memories: Memory[]
  lists: FavoriteList[]
}

export const emptyAppData: AppData = { points: [], memories: [], lists: [] }
