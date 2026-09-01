// Data access for pensar_boards.
// RLS scopes every row to auth.uid(); user_id defaults to auth.uid() on insert,
// so nothing here needs to pass it explicitly.

import { supabase } from './supabaseClient'

const COLUMNS = 'id, name, position, archived_at, created_at'

/** Active boards, in display order. */
export async function listBoards() {
  const { data, error } = await supabase
    .from('pensar_boards')
    .select(COLUMNS)
    .is('archived_at', null)
    .order('position', { ascending: true })
    .order('created_at', { ascending: true })

  if (error) throw error
  return data ?? []
}

/** One board by id, archived or not. Null when it doesn't exist. */
export async function getBoard(id) {
  const { data, error } = await supabase
    .from('pensar_boards')
    .select(COLUMNS)
    .eq('id', id)
    .maybeSingle()

  if (error) throw error
  return data
}

/** Archived boards, most recently archived first. */
export async function listArchivedBoards() {
  const { data, error } = await supabase
    .from('pensar_boards')
    .select(COLUMNS)
    .not('archived_at', 'is', null)
    .order('archived_at', { ascending: false })

  if (error) throw error
  return data ?? []
}

export async function countArchivedBoards() {
  const { count, error } = await supabase
    .from('pensar_boards')
    .select('id', { count: 'exact', head: true })
    .not('archived_at', 'is', null)

  if (error) throw error
  return count ?? 0
}

/** Highest position in use, across active and archived. -1 when there are none. */
async function lastPosition() {
  const { data, error } = await supabase
    .from('pensar_boards')
    .select('position')
    .order('position', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) throw error
  return data?.position ?? -1
}

export async function createBoard(name) {
  const position = (await lastPosition()) + 1

  const { data, error } = await supabase
    .from('pensar_boards')
    .insert({ name, position })
    .select(COLUMNS)
    .single()

  if (error) throw error
  return data
}

export async function renameBoard(id, name) {
  const { data, error } = await supabase
    .from('pensar_boards')
    .update({ name })
    .eq('id', id)
    .select(COLUMNS)
    .single()

  if (error) throw error
  return data
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
