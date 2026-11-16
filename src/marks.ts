import type { FavoriteList, Mark, Memory, Visibility } from './types'

export const VISIBILITY_LABELS: Record<Visibility, string> = {
  private: '非公開',
  followers: 'フォロワー限定',
  public: '全体公開',
}

export const MARK_SYMBOLS = ['♥', '★', '⚑', '☕', '🍴', '🏨', '⛰', '🏖', '📷', '🛍', '⛩', '✈', '🚃', '♨', '🌸', '🎡']

export const MARK_COLORS = ['#d78072', '#e0a03a', '#5c9e6e', '#397a69', '#4f86b8', '#7d6bb3', '#c46a9a', '#6f7d75']

export const DEFAULT_MARK: Mark = { symbol: '♥', color: '#d78072' }

/** Accepts only a short symbol and a #rrggbb colour; anything else becomes null. */
export function sanitizeMark(value: unknown): Mark | null {
  if (!value || typeof value !== 'object') return null
  const { symbol, color } = value as Record<string, unknown>
  if (typeof symbol !== 'string' || !symbol || [...symbol].length > 4) return null
  if (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) return null
  return { symbol, color }
}

/** The favorite's own mark, else its list's mark, else the default heart. */
export function effectiveMark(memory: Memory, listsById: Map<string, FavoriteList>): Mark {
  const own = sanitizeMark(memory.mark)
  if (own) return own
  const list = memory.listId ? listsById.get(memory.listId) : undefined
  return (list && !list.deletedAt && sanitizeMark(list.mark)) || DEFAULT_MARK
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character)
}
