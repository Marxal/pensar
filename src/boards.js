// Data access for pensar_boards.
// RLS scopes every row to auth.uid(); user_id defaults to auth.uid() on insert,
// so nothing here needs to pass it explicitly.

import { supabase } from './supabaseClient'
import { createDrawer, FIRST_DRAWER } from './drawers'

const COLUMNS =
  'id, name, colour, emoji, icon_path, swipe_drawers, position, archived_at, deleted_at, created_at'

/** Active boards, in display order. */
export async function listBoards() {
  const { data, error } = await supabase
    .from('pensar_boards')
    .select(COLUMNS)
    .is('archived_at', null)
    .is('deleted_at', null)
    .order('position', { ascending: true })
    .order('created_at', { ascending: true })

  if (error) throw error
  return data ?? []
}

/** One board by id, in any state. Null when it doesn't exist. */
export async function getBoard(id) {
  const { data, error } = await supabase
    .from('pensar_boards')
    .select(COLUMNS)
    .eq('id', id)
    .maybeSingle()

  if (error) throw error
  return data
}

/** Archived, non-trashed boards, most recently archived first. */
export async function listArchivedBoards() {
  const { data, error } = await supabase
    .from('pensar_boards')
    .select(COLUMNS)
    .not('archived_at', 'is', null)
    .is('deleted_at', null)
    .order('archived_at', { ascending: false })

  if (error) throw error
  return data ?? []
}

export async function countArchivedBoards() {
  const { count, error } = await supabase
    .from('pensar_boards')
    .select('id', { count: 'exact', head: true })
    .not('archived_at', 'is', null)
    .is('deleted_at', null)

  if (error) throw error
  return count ?? 0
}

/** Trashed boards, most recently deleted first. */
export async function listTrashedBoards() {
  const { data, error } = await supabase
    .from('pensar_boards')
    .select(COLUMNS)
    .not('deleted_at', 'is', null)
    .order('deleted_at', { ascending: false })

  if (error) throw error
  return data ?? []
}

export async function countTrashedBoards() {
  const { count, error } = await supabase
    .from('pensar_boards')
    .select('id', { count: 'exact', head: true })
    .not('deleted_at', 'is', null)

  if (error) throw error
  return count ?? 0
}

/** Highest position in use, across active and archived (not trashed). -1 when there are none. */
async function lastPosition() {
  const { data, error } = await supabase
    .from('pensar_boards')
    .select('position')
    .is('deleted_at', null)
    .order('position', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) throw error
  return data?.position ?? -1
}

/** Create a board, with the one drawer it starts life with. */
export async function createBoard(name, style = {}) {
  const position = (await lastPosition()) + 1

  const { data, error } = await supabase
    .from('pensar_boards')
    .insert({ name: name.trim(), position, ...boardStylePatch(style) })
    .select(COLUMNS)
    .single()

  if (error) throw error

  await createDrawer(data.id, FIRST_DRAWER)
  return data
}

export async function renameBoard(id, name) {
  const { data, error } = await supabase
    .from('pensar_boards')
    .update({ name: name.trim() })
    .eq('id', id)
    .select(COLUMNS)
    .single()

  if (error) throw error
  return data
}

/** Only the look-and-feel fields, and only the ones being set. An icon image
 *  beats an emoji, so picking one clears the other rather than leaving a board
 *  with two icons and a rule about which wins. */
function boardStylePatch(style) {
  const patch = {}
  if ('colour' in style) patch.colour = style.colour
  if ('emoji' in style) {
    patch.emoji = style.emoji || null
    if (patch.emoji) patch.icon_path = null
  }
  if ('icon_path' in style) {
    patch.icon_path = style.icon_path || null
    if (patch.icon_path) patch.emoji = null
  }
  return patch
}

export async function setBoardStyle(id, style) {
  const { data, error } = await supabase
    .from('pensar_boards')
    .update(boardStylePatch(style))
    .eq('id', id)
    .select(COLUMNS)
    .single()

  if (error) throw error
  return data
}

/** Whether a phone swipes between this board's drawers instead of stacking
 *  them — a property of the project, kept beside colour and emoji rather than
 *  in localStorage, since it's a decision about the board, not the screen. */
export async function setBoardSwipeDrawers(id, swipeDrawers) {
  const { data, error } = await supabase
    .from('pensar_boards')
    .update({ swipe_drawers: swipeDrawers })
    .eq('id', id)
    .select(COLUMNS)
    .single()

  if (error) throw error
  return data
}

/**
 * Write the whole active board order down, `ids` being them in the order
 * they should show. Same shape as drawers.js's saveDrawerOrder — renumbered
 * from zero rather than trading two positions, since only the order matters.
 */
export async function saveBoardOrder(ids) {
  const results = await Promise.all(
    ids.map((id, position) => supabase.from('pensar_boards').update({ position }).eq('id', id))
  )

  const failed = results.find((result) => result.error)
  if (failed) throw failed.error
}

export async function archiveBoard(id) {
  const { error } = await supabase
    .from('pensar_boards')
    .update({ archived_at: new Date().toISOString() })
    .eq('id', id)

  if (error) throw error
}

/** Un-archive, dropping the board back at the end of the active list. */
export async function restoreBoard(id) {
  const position = (await lastPosition()) + 1

  const { error } = await supabase
    .from('pensar_boards')
    .update({ archived_at: null, position })
    .eq('id', id)

  if (error) throw error
}

/** Soft delete — the row stays put until the trash's scheduled purge. */
export async function trashBoard(id) {
  const { error } = await supabase
    .from('pensar_boards')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id)

  if (error) throw error
}

/** Restore out of the trash, back to wherever it was — active or archived. */
export async function restoreTrashedBoard(id) {
  const board = await getBoard(id)
  if (!board) return

  const updates = { deleted_at: null }
  // Only a board headed back to the active list needs a fresh spot at the
  // end; an archived board's position doesn't matter until it's restored.
  if (!board.archived_at) updates.position = (await lastPosition()) + 1

  const { error } = await supabase.from('pensar_boards').update(updates).eq('id', id)

  if (error) throw error
}
