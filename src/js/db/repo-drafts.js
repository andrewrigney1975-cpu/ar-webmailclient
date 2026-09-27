/** Local drafts and the outbox (migration 4). */

export async function saveDraft(db, { id, accountId, data, remoteUid = null }) {
  await db.run(
    `INSERT INTO drafts (id, account_id, data_json, remote_uid, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET account_id = excluded.account_id, data_json = excluded.data_json,
       remote_uid = COALESCE(excluded.remote_uid, drafts.remote_uid), updated_at = excluded.updated_at`,
    [id, accountId, JSON.stringify(data), remoteUid, Date.now()],
  );
}

export async function setDraftRemoteUid(db, id, remoteUid) {
  await db.run('UPDATE drafts SET remote_uid = ? WHERE id = ?', [remoteUid, id]);
}

export async function getDraft(db, id) {
  const row = await db.get('SELECT * FROM drafts WHERE id = ?', [id]);
  return row && { id: row.id, accountId: row.account_id, data: JSON.parse(row.data_json), remoteUid: row.remote_uid };
}

export async function deleteDraft(db, id) {
  await db.run('DELETE FROM drafts WHERE id = ?', [id]);
}

// --- Outbox ---------------------------------------------------------------------------------------

function toItem(row) {
  return {
    id: row.id,
    accountId: row.account_id,
    data: JSON.parse(row.data_json),
    sendAfter: row.send_after,
    attempts: row.attempts,
    lastError: row.last_error ? JSON.parse(row.last_error) : null,
    createdAt: row.created_at,
  };
}

export async function enqueue(db, { id, accountId, data, sendAfter }) {
  await db.run(
    'INSERT INTO outbox (id, account_id, data_json, send_after, created_at) VALUES (?, ?, ?, ?, ?)',
    [id, accountId, JSON.stringify(data), sendAfter, Date.now()],
  );
}

export async function listOutbox(db) {
  return (await db.all('SELECT * FROM outbox ORDER BY created_at')).map(toItem);
}

export async function getOutboxItem(db, id) {
  const row = await db.get('SELECT * FROM outbox WHERE id = ?', [id]);
  return row && toItem(row);
}

export async function recordFailure(db, id, error, retryAt) {
  await db.run('UPDATE outbox SET attempts = attempts + 1, last_error = ?, send_after = ? WHERE id = ?', [
    JSON.stringify(error),
    retryAt,
    id,
  ]);
}

export async function rescheduleOutbox(db, id, sendAfter) {
  await db.run('UPDATE outbox SET send_after = ? WHERE id = ?', [sendAfter, id]);
}

export async function removeFromOutbox(db, id) {
  await db.run('DELETE FROM outbox WHERE id = ?', [id]);
}
