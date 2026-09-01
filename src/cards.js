// Data access for pensar_cards.
// RLS scopes every row to auth.uid(); user_id defaults to auth.uid() on insert,
// so nothing here needs to pass it explicitly.
//
// "Live" cards are those neither archived nor trashed — everything the board
// view shows. Delete is a soft delete (deleted_at), so Phase 4's trash can
// still recover it.

import { supabase } from './supabaseClient'

export const STATUSES = ['todo', 'doing', 'done']

export const STATUS_LABELS = {
  todo: 'To do',
  doing: 'Doing',
  done: 'Done',
}

export const PRIORITY_LABELS = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
}

const COLUMNS =
  'id, board_id, status, position, title, body_markdown, cover_image_url, due_date, priority, created_at, updated_at'

const live = (query) => query.is('archived_at', null).is('deleted_at', null)

/** Every live card on a board, ordered within each column. */
export async function listCards(boardId) {
  const { data, error } = await live(
    supabase.from('pensar_cards').select(COLUMNS).eq('board_id', boardId)
  )
    .order('position', { ascending: true })
    .order('created_at', { ascending: true })

  if (error) throw error
  return data ?? []
}

/** Live cards not yet assigned to a board — the Inbox. Newest capture first. */
export async function listInboxCards() {
  const { data, error } = await live(
    supabase.from('pensar_cards').select(COLUMNS).is('board_id', null)
  ).order('created_at', { ascending: false })

  if (error) throw error
  return data ?? []
}

/** Live card counts per board, as a Map of board_id → count. */
export async function countCardsByBoard() {
  const { data, error } = await live(
    supabase.from('pensar_cards').select('board_id').not('board_id', 'is', null)
  )

  if (error) throw error

  const counts = new Map()
  for (const row of data ?? []) {
    counts.set(row.board_id, (counts.get(row.board_id) ?? 0) + 1)
  }
  return counts
}

/** Highest position in a board's column. -1 when the column is empty. */
async function lastPosition(boardId, status) {
  const { data, error } = await live(
    supabase.from('pensar_cards').select('position').eq('board_id', boardId).eq('status', status)
  )
    .order('position', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) throw error
  return data?.position ?? -1
}

/** Keep only the fields a card owns, and normalise blanks to null. */
function cardFields({ title, body_markdown, due_date, priority }) {
  return {
    title: title.trim(),
    body_markdown: body_markdown ?? '',
    due_date: due_date || null,
    priority: priority || null,
  }
}

/** Add a card to the end of a column. */
export async function createCard(boardId, status, fields) {
  const position = (await lastPosition(boardId, status)) + 1

  const { data, error } = await supabase
    .from('pensar_cards')
    .insert({ board_id: boardId, status, position, ...cardFields(fields) })
    .select(COLUMNS)
    .single()

  if (error) throw error
  return data
}

/** Quick-capture: title only, sitting in the Inbox until assigned to a board. */
export async function createInboxCard(title) {
  const { data, error } = await supabase
    .from('pensar_cards')
    .insert({ title: title.trim(), body_markdown: '' })
    .select(COLUMNS)
    .single()

  if (error) throw error
  return data
}

export async function updateCard(id, fields) {
  const { data, error } = await supabase
    .from('pensar_cards')
    .update(cardFields(fields))
    .eq('id', id)
    .select(COLUMNS)
    .single()

  if (error) throw error
  return data
}

/** Soft delete — the row stays put until trash gets built out. */
export async function trashCard(id) {
  const { error } = await supabase
    .from('pensar_cards')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id)

  if (error) throw error
}

/** Archive a card — off the Inbox/board, but recoverable, unlike delete. */
export async function archiveCard(id) {
  const { error } = await supabase
    .from('pensar_cards')
    .update({ archived_at: new Date().toISOString() })
    .eq('id', id)

  if (error) throw error
}

/** Send a card to the bottom of another column. */
export async function moveCard(id, boardId, status) {
  const position = (await lastPosition(boardId, status)) + 1

  const { error } = await supabase.from('pensar_cards').update({ status, position }).eq('id', id)

  if (error) throw error
}

/** Move an inbox card onto a board's column, at the end. */
export async function assignCardToBoard(id, boardId, status) {
  const position = (await lastPosition(boardId, status)) + 1

  const { error } = await supabase
    .from('pensar_cards')
    .update({ board_id: boardId, status, position })
    .eq('id', id)

  if (error) throw error
}

/**
 * Persist a drag: `moves` is `[{ id, status, position }]`, already narrowed to
 * the rows that actually shifted. Positions stay dense (0..n-1 per column).
 */
export async function saveOrder(moves) {
  const results = await Promise.all(
    moves.map(({ id, status, position }) =>
      supabase.from('pensar_cards').update({ status, position }).eq('id', id)
    )
  )

  const failed = results.find((result) => result.error)
  if (failed) throw failed.error
}
