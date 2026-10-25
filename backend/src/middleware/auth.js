const jwt = require('jsonwebtoken');

const userRepo = require('../repositories/userRepo');
const { jwtSecret } = require('../services/accountService');

/**
 * Verifies the Bearer JWT and loads the account behind it.
 *
 * There is one shared login, but the token still names the account row that
 * owns the data, and that row is re-read on every request rather than trusted
 * from the token body — so a database restored without it rejects stale tokens
 * instead of serving them against nothing.
 *
 * On success `req.user` is `{ userId, email, record }`.
 */
function requireAuth(req, res, next) {
  const header = req.headers.authorization;

  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const token = header.slice(7);

  let payload;
  try {
    payload = jwt.verify(token, jwtSecret());
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  const user = payload.userId ? userRepo.findById(payload.userId) : null;

  if (!user) {
    return res.status(401).json({ error: 'Session is no longer valid — sign in again' });
  }

  req.user = {
    userId: user.id,
    email: user.email,
    record: user,
  };

  next();
}

module.exports = { requireAuth };
