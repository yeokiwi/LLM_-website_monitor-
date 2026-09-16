/**
 * The account that owns the data.
 *
 * There is one shared login (see routes/auth.js) and therefore one row here.
 * It exists so `websites.owner_id`, `scan_results.owner_id` and
 * `schedules.owner_id` have something to reference; the signup, verification
 * and password-recovery helpers that used to live here went with the accounts
 * they served.
 */

const db = require('../db');

function findById(id) {
  return db.prepare(`SELECT * FROM users WHERE id = ?`).get(id);
}

function findByEmail(email) {
  if (!email) return undefined;
  return db.prepare(`SELECT * FROM users WHERE email = ?`).get(String(email).trim());
}

/**
 * @param {{ email: string, passwordHash: string, name?: string }} fields
 * @returns {object} the created user row
 */
function create({ email, passwordHash, name = null }) {
  const result = db
    .prepare(`INSERT INTO users (email, password_hash, name) VALUES (?, ?, ?)`)
    .run(String(email).trim(), passwordHash, name);

  return findById(result.lastInsertRowid);
}

function touchLogin(userId) {
  db.prepare(`UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?`).run(userId);
}

/** Every account, oldest first. Retention pruning walks this. */
function listAll(limit = 100, offset = 0) {
  return db
    .prepare(`SELECT * FROM users ORDER BY id ASC LIMIT ? OFFSET ?`)
    .all(limit, offset);
}

module.exports = {
  findById,
  findByEmail,
  create,
  touchLogin,
  listAll,
};
