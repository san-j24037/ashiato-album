import { emptyAppData, type AppData } from './types'

const STORAGE_KEY = 'ashiato-album-data-v1'
const DATABASE_NAME = 'ashiato-album'
const STORE_NAME = 'app-state'
const ACTIVE_ACCOUNT_KEY = 'active-account'

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Could not open local storage'))
  })
}

function readValue<T>(database: IDBDatabase, key: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const request = database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(key)
    request.onsuccess = () => resolve(request.result as T | undefined)
    request.onerror = () => reject(request.error ?? new Error('Could not read local data'))
  })
}

export async function loadAppState(): Promise<{ data: AppData; accountSub: string | null }> {
  const database = await openDatabase()
  const accountSub = await readValue<string>(database, ACTIVE_ACCOUNT_KEY) ?? null
  const stored = await readValue<AppData>(database, dataKey(accountSub))
  database.close()
  if (stored) return { data: stored, accountSub }

  const legacy = localStorage.getItem(STORAGE_KEY)
  if (!legacy) return { data: emptyAppData, accountSub: null }
  const parsed: unknown = JSON.parse(legacy)
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    'points' in parsed &&
    Array.isArray(parsed.points) &&
    'memories' in parsed &&
    Array.isArray(parsed.memories)
  ) {
    await saveAppData(parsed as AppData, null)
    localStorage.removeItem(STORAGE_KEY)
    return { data: parsed as AppData, accountSub: null }
  }
  return { data: emptyAppData, accountSub: null }
}

export async function loadAccountData(accountSub: string): Promise<AppData> {
  const database = await openDatabase()
  const data = await readValue<AppData>(database, dataKey(accountSub))
  database.close()
  return data ?? emptyAppData
}

export async function setActiveAccount(accountSub: string | null): Promise<void> {
  const database = await openDatabase()
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite')
    transaction.objectStore(STORE_NAME).put(accountSub, ACTIVE_ACCOUNT_KEY)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('Could not save account selection'))
    transaction.onabort = () => reject(transaction.error ?? new Error('Account selection save was aborted'))
  })
  database.close()
}

export async function saveAppData(data: AppData, accountSub: string | null): Promise<void> {
  const database = await openDatabase()
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite')
    transaction.objectStore(STORE_NAME).put(data, dataKey(accountSub))
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('Could not save local data'))
    transaction.onabort = () => reject(transaction.error ?? new Error('Local data save was aborted'))
  })
  database.close()
}

function dataKey(accountSub: string | null) {
  return accountSub ? `account:${accountSub}` : 'guest'
}
