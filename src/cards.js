// Data access for pensar_cards.
// RLS scopes every row to auth.uid(); user_id defaults to auth.uid() on insert,
// so nothing here needs to pass it explicitly.
//
// A card's placement is its `drawer_id`, and nothing else: null means it's
// sitting in Quick notes. `board_id` is filled in by a database trigger from
// whatever drawer the card lands in (see the 20260901230500 migration), which
// is why nothing below ever writes it — it exists so "the cards on this board"
// stays a single-table query.
//
// "Live" cards are those neither archived nor trashed — everything the boards
// and the home screen show. Delete is a soft delete (deleted_at), so the trash
// can still recover it.

import { supabase } from './supabaseClient'
import { computeRemindAt } from './format'

export const PRIORITIES = ['low', 'medium', 'high']

export const PRIORITY_LABELS = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
}

const COLUMNS =
  'id, board_id, drawer_id, position, title, body_markdown, due_date, due_time, priority, done, created_at, updated_at'

const live = (query) => query.is('archived_at', null).is('deleted_at', null)

/** Every live card on a board, ordered within each drawer. */
export async function listCards(boardId) {
  const { data, error } = await live(
    supabase.from('pensar_cards').select(COLUMNS).eq('board_id', boardId)
  )
    .order('position', { ascending: true })
    .order('created_at', { ascending: true })

  if (error) throw error
  return data ?? []
}

/** Live cards not in any drawer — Quick notes. Newest capture first. */
export async function listQuickNotes() {
  const { data, error } = await live(
    supabase.from('pensar_cards').select(COLUMNS).is('drawer_id', null)
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

/** Highest position in a drawer. -1 when it's empty. */
async function lastPosition(drawerId) {
  const query = supabase.from('pensar_cards').select('position')

  const { data, error } = await live(
    drawerId ? query.eq('drawer_id', drawerId) : query.is('drawer_id', null)
  )
    .order('position', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) throw error
  return data?.position ?? -1
}

/**
 * Keep only the fields a card owns, and only the ones actually being set —
 * the note editor saves as you type, and a save that carries just the title
 * shouldn't blank the note underneath it.
 */
const EDITABLE = ['title', 'body_markdown', 'due_date', 'due_time', 'priority', 'done']

/**
 * `remind_at` is never set directly — it's `due_date` + `due_time` (see
 * computeRemindAt), recomputed here whenever either travels through this
 * patch, which every caller that touches one already sends both of (the
 * editor's due-date row saves as one field; `mergeCards` below does too). A
 * reminder that already fired arms itself again the moment the due date
 * moves, with nothing needing to notice and reset it — see the reminders
 * migration's own note on `reminder_fired_for`.
 */
function cardPatch(fields) {
  const patch = {}
  for (const key of EDITABLE) {
    if (!(key in fields)) continue
    const value = fields[key]
    if (key === 'title') patch.title = String(value ?? '').trim()
    else if (key === 'body_markdown') patch.body_markdown = String(value ?? '')
    else if (key === 'done') patch.done = Boolean(value)
    else patch[key] = value || null
  }

  if ('due_date' in fields) patch.remind_at = computeRemindAt(fields.due_date, fields.due_time)

  return patch
}

/** Add a card to the end of a drawer, or to Quick notes when `drawerId` is null. */
export async function createCard(drawerId, fields = {}) {
  const position = (await lastPosition(drawerId)) + 1

  const { data, error } = await supabase
    .from('pensar_cards')
    .insert({ drawer_id: drawerId ?? null, position, title: '', ...cardPatch(fields) })
    .select(COLUMNS)
    .single()

  if (error) throw error
  return data
}

/**
 * Quick capture: a line of text, straight into Quick notes.
 *
 * The line becomes the note, not a title for one. A title is for a long note
 * that needs a heading to stay scannable — putting a captured line there as
 * well would mean it appearing twice in anything that shows both.
 */
export async function createQuickNote(text) {
  return createCard(null, { body_markdown: text })
}

export async function updateCard(id, fields) {
  const { data, error } = await supabase
    .from('pensar_cards')
    .update(cardPatch(fields))
    .eq('id', id)
    .select(COLUMNS)
    .single()

  if (error) throw error
  return data
}

/** Tick a card off, or un-tick it. Its own call because a tick box saves the
 *  moment it's tapped, with no editor open around it. */
export async function setCardDone(id, done) {
  const { error } = await supabase.from('pensar_cards').update({ done }).eq('id', id)
  if (error) throw error
}

/** Soft delete — the row stays put until the trash's scheduled purge. */
export async function trashCard(id) {
  const { error } = await supabase
    .from('pensar_cards')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id)

  if (error) throw error
}

/** Archive a card — off the board, but recoverable, unlike delete. */
export async function archiveCard(id) {
  const { error } = await supabase
    .from('pensar_cards')
    .update({ archived_at: new Date().toISOString() })
    .eq('id', id)

  if (error) throw error
}

/** Put an archived card back where it was — what Undo calls, and what
 *  Restore calls on the Archive page. A card whose drawer has been deleted
 *  since comes back to Quick notes: `drawer_id` is `on delete set null`. */
export async function unarchiveCard(id) {
  const { error } = await supabase.from('pensar_cards').update({ archived_at: null }).eq('id', id)
  if (error) throw error
}

/** Archived, non-trashed cards, most recently archived first, with the board
 *  they were on (null when it was a quick note) — the Archive page says where
 *  each one came from, the same way the Trash does. */
export async function listArchivedCards() {
  const { data, error } = await supabase
    .from('pensar_cards')
    .select(`${COLUMNS}, archived_at, board:pensar_boards(name)`)
    .not('archived_at', 'is', null)
    .is('deleted_at', null)
    .order('archived_at', { ascending: false })

  if (error) throw error
  return data ?? []
}

export async function countArchivedCards() {
  const { count, error } = await supabase
    .from('pensar_cards')
    .select('id', { count: 'exact', head: true })
    .not('archived_at', 'is', null)
    .is('deleted_at', null)

  if (error) throw error
  return count ?? 0
}

/**
 * Trash every live card sitting in a drawer, in one statement — what deleting
 * a drawer does to its contents (see `deleteDrawer`). Archived cards are left
 * alone: they already left the board on their own terms.
 */
export async function trashCardsInDrawer(drawerId) {
  const { error } = await supabase
    .from('pensar_cards')
    .update({ deleted_at: new Date().toISOString() })
    .eq('drawer_id', drawerId)
    .is('deleted_at', null)

  if (error) throw error
}

/**
 * Pull cards back out of the trash and put them somewhere — `moves` is
 * `[{ id, drawer_id, position }]`. Undoing a drawer delete uses this to land
 * its cards back in the drawer it just re-made, in the order they were in.
 */
export async function restoreCards(moves) {
  const results = await Promise.all(
    moves.map(({ id, drawer_id, position }) =>
      supabase
        .from('pensar_cards')
        .update({ deleted_at: null, drawer_id: drawer_id ?? null, position })
        .eq('id', id)
    )
  )

  const failed = results.find((result) => result.error)
  if (failed) throw failed.error
}

/** Delete a card outright, skipping the trash. Only used to tidy away a note
 *  that was opened and left empty — there is nothing in it to recover. */
export async function deleteCard(id) {
  const { error } = await supabase.from('pensar_cards').delete().eq('id', id)
  if (error) throw error
}

/** Trashed cards, most recently deleted first, with the board they belonged
 *  to (null when it was a quick note). */
export async function listTrashedCards() {
  const { data, error } = await supabase
    .from('pensar_cards')
    .select(`${COLUMNS}, deleted_at, board:pensar_boards(name)`)
    .not('deleted_at', 'is', null)
    .order('deleted_at', { ascending: false })

  if (error) throw error
  return data ?? []
}

export async function countTrashedCards() {
  const { count, error } = await supabase
    .from('pensar_cards')
    .select('id', { count: 'exact', head: true })
    .not('deleted_at', 'is', null)

  if (error) throw error
  return count ?? 0
}

/** Restore a trashed card back to wherever it was. A card whose drawer has
 *  since been deleted comes back to Quick notes, which is the same place the
 *  drawer's other cards went. */
export async function restoreCard(id) {
  const { error } = await supabase.from('pensar_cards').update({ deleted_at: null }).eq('id', id)
  if (error) throw error
}

/** Move a card to the end of a drawer — or to Quick notes, with a null drawer. */
export async function moveCardToDrawer(id, drawerId) {
  const position = (await lastPosition(drawerId)) + 1

  const { error } = await supabase
    .from('pensar_cards')
    .update({ drawer_id: drawerId ?? null, position })
    .eq('id', id)

  if (error) throw error
}

/**
 * Persist a drag: `moves` is `[{ id, drawer_id, position }]`, already narrowed
 * to the rows that actually shifted. Positions stay dense (0..n-1 per drawer).
 */
export async function saveOrder(moves) {
  const results = await Promise.all(
    moves.map(({ id, drawer_id, position }) =>
      supabase.from('pensar_cards').update({ drawer_id, position }).eq('id', id)
    )
  )

  const failed = results.find((result) => result.error)
  if (failed) throw failed.error
}

/* ---------------------------------------------------------------
   Merging
   --------------------------------------------------------------- */

const PRIORITY_RANK = { low: 1, medium: 2, high: 3 }

/** The stronger of two priorities, either of which may be missing. */
function strongerPriority(a, b) {
  if (!a) return b ?? null
  if (!b) return a
  return (PRIORITY_RANK[a] ?? 0) >= (PRIORITY_RANK[b] ?? 0) ? a : b
}

/** The sooner of two due dates, either of which may be missing — carrying
 *  its own due_time along, since a date without its time is a different
 *  reminder. */
function soonerDue(a, b) {
  if (!a.due_date) return { due_date: b.due_date ?? null, due_time: b.due_date ? b.due_time ?? null : null }
  if (!b.due_date) return { due_date: a.due_date, due_time: a.due_time ?? null }
  return a.due_date <= b.due_date
    ? { due_date: a.due_date, due_time: a.due_time ?? null }
    : { due_date: b.due_date, due_time: b.due_time ?? null }
}

/**
 * Fold `sourceId` into `targetId` — the card that was dropped goes into the
 * card it was dropped on. The target keeps its title and gains the source's
 * note underneath its own, with the source's title as a heading above it so
 * nothing is lost silently.
 *
 * The source is trashed rather than deleted, which is what makes this safe to
 * do on a gesture — and what lets the whole thing be undone: putting the
 * target's old fields back and lifting the source out of the trash restores
 * both cards exactly. That pair comes back as `{ target, sourceId }`, which is
 * what `undoMerge` wants.
 */
export async function mergeCards(targetId, sourceId) {
  const { data, error } = await supabase
    .from('pensar_cards')
    .select(COLUMNS)
    .in('id', [targetId, sourceId])

  if (error) throw error

  const target = data?.find((card) => card.id === targetId)
  const source = data?.find((card) => card.id === sourceId)
  if (!target || !source) throw new Error('One of those cards is no longer there.')

  const sourceTitle = source.title.trim()
  const keepsSourceTitle = Boolean(sourceTitle) && Boolean(target.title.trim())

  const body = [
    target.body_markdown.trim(),
    keepsSourceTitle ? `**${sourceTitle}**` : '',
    source.body_markdown.trim(),
  ]
    .filter(Boolean)
    .join('\n\n')

  const before = {
    title: target.title,
    body_markdown: target.body_markdown,
    due_date: target.due_date ?? null,
    due_time: target.due_time ?? null,
    priority: target.priority ?? null,
  }

  const due = soonerDue(target, source)

  await updateCard(targetId, {
    title: target.title.trim() || sourceTitle,
    body_markdown: body,
    due_date: due.due_date,
    due_time: due.due_time,
    priority: strongerPriority(target.priority, source.priority),
  })

  await trashCard(sourceId)

  return { targetId, sourceId, target: before, sourceTitle: sourceTitle || null }
}

/** Take a merge back apart, from whatever `mergeCards` handed back. */
export async function undoMerge({ targetId, sourceId, target }) {
  await updateCard(targetId, target)
  await restoreCard(sourceId)
}
