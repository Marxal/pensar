// Data access for pensar_drawers — the columns inside a board, which the user
// names and shapes rather than inheriting from a fixed To do / Doing / Done.
// RLS scopes every row to auth.uid(); user_id defaults to auth.uid() on
// insert, so nothing here needs to pass it explicitly.

import { supabase } from './supabaseClient'

const COLUMNS = 'id, board_id, name, kind, position, created_at'

/** A drawer's kind decides how its cards are drawn, never what they are — the
 *  same card is a tick-box line in one and a picture in another, and switching
 *  a drawer over doesn't touch a single card. */
export const DRAWER_KINDS = ['list', 'notes', 'gallery']

export const DRAWER_KIND_LABELS = {
  list: 'Tick list',
  notes: 'Notes',
  gallery: 'Gallery',
}

export const DRAWER_KIND_HINTS = {
  list: 'Each card is a line with a tick box.',
  notes: 'Cards you can open out and read in place.',
  gallery: 'Big pictures first, words second.',
}

/** What a board gets when it's created: one drawer, ready to be renamed. */
export const FIRST_DRAWER = { name: 'To do', kind: 'list' }

/**
 * Every drawer you own, across every board.
 *
 * There is no per-board version on purpose: both screens that show drawers
 * also offer "move this somewhere else", which needs every board's drawers
 * anyway, and one small query beats two.
 */
export async function listAllDrawers() {
  const { data, error } = await supabase
    .from('pensar_drawers')
    .select(COLUMNS)
    .order('position', { ascending: true })
    .order('created_at', { ascending: true })

  if (error) throw error
  return data ?? []
}

/** Highest position in a board's drawers. -1 when it has none. */
async function lastPosition(boardId) {
  const { data, error } = await supabase
    .from('pensar_drawers')
    .select('position')
    .eq('board_id', boardId)
    .order('position', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) throw error
  return data?.position ?? -1
}

export async function createDrawer(boardId, { name, kind = 'notes' }) {
  const position = (await lastPosition(boardId)) + 1

  const { data, error } = await supabase
    .from('pensar_drawers')
    .insert({ board_id: boardId, name: name.trim(), kind, position })
    .select(COLUMNS)
    .single()

  if (error) throw error
  return data
}

export async function updateDrawer(id, fields) {
  const patch = {}
  if ('name' in fields) patch.name = fields.name.trim()
  if ('kind' in fields) patch.kind = fields.kind

  const { data, error } = await supabase
    .from('pensar_drawers')
    .update(patch)
    .eq('id', id)
    .select(COLUMNS)
    .single()

  if (error) throw error
  return data
}

/**
 * Delete a drawer for good. Cards are not deleted with it: the foreign key is
 * `on delete set null`, and the trigger that keeps board_id in step with
 * drawer_id clears the board too — so whatever was inside lands back in Quick
 * notes rather than disappearing.
 */
export async function deleteDrawer(id) {
  const { error } = await supabase.from('pensar_drawers').delete().eq('id', id)
  if (error) throw error
}

/** Swap a drawer with its neighbour. `direction` is -1 (left) or 1 (right). */
export async function moveDrawer(drawers, id, direction) {
  const ordered = [...drawers].sort((a, b) => a.position - b.position)
  const index = ordered.findIndex((drawer) => drawer.id === id)
  const swapWith = index + direction
  if (index < 0 || swapWith < 0 || swapWith >= ordered.length) return

  // Positions can arrive uneven (a deleted drawer leaves a gap), so the whole
  // row is renumbered rather than the two swapped positions being traded.
  const reordered = [...ordered]
  ;[reordered[index], reordered[swapWith]] = [reordered[swapWith], reordered[index]]

  const results = await Promise.all(
    reordered.map((drawer, position) =>
      drawer.position === position
        ? { error: null }
        : supabase.from('pensar_drawers').update({ position }).eq('id', drawer.id)
    )
  )

  const failed = results.find((result) => result.error)
  if (failed) throw failed.error
}
