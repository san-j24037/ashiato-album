import { Check, Trash2, X } from 'lucide-react'
import { useState } from 'react'
import { DEFAULT_MARK, MARK_COLORS, MARK_SYMBOLS, VISIBILITY_LABELS } from './marks'
import type { FavoriteList, Mark, Visibility } from './types'

const VISIBILITY_HINTS: Record<Visibility, string> = {
  private: '自分だけが見られます',
  followers: 'あなたをフォローしている人が見られます',
  public: 'ログインしている全員が見られ、地図のおすすめにも表示されます',
}

/** Three-way sharing scope picker for favorites and lists. */
export function VisibilitySelect({ value, onChange, id }: { value: Visibility; onChange(value: Visibility): void; id?: string }) {
  return (
    <div className="visibility-select">
      <div className="visibility-options" role="radiogroup" aria-labelledby={id}>
        {(Object.keys(VISIBILITY_LABELS) as Visibility[]).map((option) => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={value === option}
            className={value === option ? 'selected' : ''}
            onClick={() => onChange(option)}
          >
            {VISIBILITY_LABELS[option]}
          </button>
        ))}
      </div>
      <small>{VISIBILITY_HINTS[value]}</small>
    </div>
  )
}

/** Round badge showing a mark (symbol on its colour). */
export function MarkBadge({ mark, size = 28 }: { mark: Mark; size?: number }) {
  return (
    <span className="mark-badge" style={{ background: mark.color, width: size, height: size, fontSize: size * 0.5 }} aria-hidden="true">
      {mark.symbol}
    </span>
  )
}

/**
 * Picks a symbol and a colour. When `inheritFrom` is given, the value may also be null,
 * meaning "use the list's mark" (shown with that inherited mark).
 */
export function MarkPicker({
  value,
  onChange,
  inheritFrom,
}: {
  value: Mark | null
  onChange(mark: Mark | null): void
  inheritFrom?: Mark
}) {
  const shown = value ?? inheritFrom ?? DEFAULT_MARK
  return (
    <div className="mark-picker">
      {inheritFrom && (
        <label className="mark-inherit">
          <input type="checkbox" checked={value === null} onChange={(event) => onChange(event.target.checked ? null : { ...inheritFrom })} />
          <MarkBadge mark={inheritFrom} size={22} />
          <span>リストのマークを使う</span>
        </label>
      )}
      <div className="mark-symbols" role="group" aria-label="記号">
        {MARK_SYMBOLS.map((symbol) => (
          <button
            key={symbol}
            type="button"
            className={shown.symbol === symbol ? 'selected' : ''}
            aria-pressed={shown.symbol === symbol}
            onClick={() => onChange({ symbol, color: shown.color })}
          >
            {symbol}
          </button>
        ))}
      </div>
      <div className="mark-colors" role="group" aria-label="色">
        {MARK_COLORS.map((color) => (
          <button
            key={color}
            type="button"
            className={shown.color === color ? 'selected' : ''}
            style={{ background: color }}
            aria-label={`色 ${color}`}
            aria-pressed={shown.color === color}
            onClick={() => onChange({ symbol: shown.symbol, color })}
          >
            {shown.color === color && <Check size={13} />}
          </button>
        ))}
      </div>
    </div>
  )
}

/** Create (list = null) or edit a favorite list. */
export function ListEditorDialog({
  list,
  favoriteCount,
  onSave,
  onDelete,
  onClose,
}: {
  list: FavoriteList | null
  favoriteCount: number
  onSave(name: string, mark: Mark, visibility: Visibility): void
  onDelete(): void
  onClose(): void
}) {
  const [name, setName] = useState(list?.name ?? '')
  const [mark, setMark] = useState<Mark>(list?.mark ?? DEFAULT_MARK)
  const [visibility, setVisibility] = useState<Visibility>(list?.visibility ?? 'private')
  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <form
        className="save-dialog list-editor"
        onSubmit={(event) => {
          event.preventDefault()
          if (name.trim()) onSave(name.trim(), mark, visibility)
        }}
      >
        <button type="button" className="dialog-close icon-button" onClick={onClose} aria-label="閉じる"><X size={18} /></button>
        <div className="dialog-icon list-editor-preview"><MarkBadge mark={mark} size={36} /></div>
        <div className="section-kicker">FAVORITE LIST</div>
        <h2>{list ? 'リストを編集' : '新しいリスト'}</h2>
        <p>お気に入りをリストに分けて、リストごとのマークで地図に表示できます。</p>
        <label className="field-label" htmlFor="list-name">リスト名</label>
        <input id="list-name" className="text-field" value={name} maxLength={80} onChange={(event) => setName(event.target.value)} placeholder="例：行きたいカフェ" required autoFocus />
        <span className="field-label">マーク</span>
        <MarkPicker value={mark} onChange={(next) => setMark(next ?? DEFAULT_MARK)} />
        <span className="field-label" id="list-visibility">公開範囲</span>
        <VisibilitySelect id="list-visibility" value={visibility} onChange={setVisibility} />
        {visibility !== 'private' && <p className="list-visibility-note">リストを公開すると、中のお気に入りも同じ範囲に公開されます。</p>}
        <div className="list-editor-actions">
          {list && (
            <button
              type="button"
              className="text-button danger"
              onClick={() => {
                const detail = favoriteCount ? `\nこのリストのお気に入り${favoriteCount}件は「未分類」に移ります（お気に入り自体は削除されません）。` : ''
                if (window.confirm(`リスト「${list.name}」を削除しますか？${detail}`)) onDelete()
              }}
            >
              <Trash2 size={15} />リストを削除
            </button>
          )}
          <button className="primary-button" type="submit"><Check size={16} />{list ? '保存' : '作成'}</button>
        </div>
      </form>
    </div>
  )
}
