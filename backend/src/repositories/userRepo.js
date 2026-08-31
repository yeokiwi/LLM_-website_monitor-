const db = require('../db');

// Columns safe to send to the client — never includes password_hash or tokens.
const PUBLIC_COLUMNS = `
  id, email, name, role, status, email_verified_at,
  notify_changes, notify_billing, created_at, last_login_at
`;

function findById(id) {
  return db.prepare(`SELECT * FROM users WHERE id = ?`).get(id);
}

function findByEmail(email) {
  if (!email) return undefined;
  return db.prepare(`SELECT * FROM users WHERE email = ?`).get(String(email).trim());
}

function findByVerifyToken(token) {
  if (!token) return undefined;
  return db.prepare(`SELECT * FROM users WHERE verify_token = ?`).get(token);
}

function findByResetToken(token) {
  if (!token) return undefined;
  return db.prepare(`SELECT * FROM users WHERE reset_token = ?`).get(token);
}

/**
 * @param {{ email: string, passwordHash: string, name?: string, role?: string,
 *           verifyToken?: string|null, verifyExpiresAt?: string|null,
 *           emailVerifiedAt?: string|null }} fields
 * @returns {object} the created user row
 */
function create({
  email,
  passwordHash,
  name = null,
  role = 'user',
  verifyToken = null,
  verifyExpiresAt = null,
  emailVerifiedAt = null,
}) {
  const result = db
    .prepare(
      `INSERT INTO users (email, password_hash, name, role,
                          verify_token, verify_expires_at, email_verified_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      String(email).trim(),
      passwordHash,
      name,
      role,
      verifyToken,
      verifyExpiresAt,
      emailVerifiedAt
    );

  return findById(result.lastInsertRowid);
}

function setVerifyToken(userId, token, expiresAt) {
  db.prepare(
    `UPDATE users SET verify_token = ?, verify_expires_at = ? WHERE id = ?`
  ).run(token, expiresAt, userId);
}

function markVerified(userId) {
  db.prepare(
    `UPDATE users
        SET email_verified_at = CURRENT_TIMESTAMP,
            verify_token = NULL,
            verify_expires_at = NULL
      WHERE id = ?`
  ).run(userId);
}

function setResetToken(userId, token, expiresAt) {
  db.prepare(
    `UPDATE users SET reset_token = ?, reset_expires_at = ? WHERE id = ?`
  ).run(token, expiresAt, userId);
}

/** Set a new password and clear any outstanding reset token. */
function updatePassword(userId, passwordHash) {
  db.prepare(
    `UPDATE users
        SET password_hash = ?, reset_token = NULL, reset_expires_at = NULL
      WHERE id = ?`
  ).run(passwordHash, userId);
}

function touchLogin(userId) {
  db.prepare(`UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?`).run(userId);
}

function updateNotificationPrefs(userId, { notifyChanges, notifyBilling }) {
  const sets = [];
  const values = [];
  if (notifyChanges !== undefined) {
    sets.push('notify_changes = ?');
    values.push(notifyChanges ? 1 : 0);
  }
  if (notifyBilling !== undefined) {
    sets.push('notify_billing = ?');
    values.push(notifyBilling ? 1 : 0);
  }
  if (sets.length === 0) return findById(userId);

  values.push(userId);
  db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return findById(userId);
}

/** Platform oversight — superadmin only. */
function listAll(limit = 100, offset = 0) {
  return db
    .prepare(
      `SELECT ${PUBLIC_COLUMNS},
              (SELECT COUNT(*) FROM websites w WHERE w.owner_id = users.id AND w.is_active = 1)
                AS website_count
         FROM users
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?`
    )
    .all(limit, offset);
}

function countAll() {
  return db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
}

/** Strip sensitive columns before a user row crosses the API boundary. */
function toPublic(user) {
  if (!user) return null;
  const {
    password_hash, verify_token, verify_expires_at, reset_token, reset_expires_at,
    ...safe
  } = user;
  return safe;
}

module.exports = {
  findById,
  findByEmail,
  findByVerifyToken,
  findByResetToken,
  create,
  setVerifyToken,
  markVerified,
  setResetToken,
  updatePassword,
  touchLogin,
  updateNotificationPrefs,
  listAll,
  countAll,
  toPublic,
};
