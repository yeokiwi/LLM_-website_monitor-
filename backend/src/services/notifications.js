/**
 * Who gets told about a scheduled scan.
 *
 * Before this existed, every alert went to the login account's address — and
 * with the shared login that is `admin@local` unless AUTH_USERNAME happens to be
 * an email address. With SMTP configured, alerts were handed to an address that
 * cannot receive mail and nothing anywhere said so.
 *
 * Recipients now resolve in order: the group's own list, then the instance's
 * default list, then the account address — but only if it is a real one. When
 * nothing is left, nothing is sent and the log says where to fix it.
 */

const settingsRepo = require('../repositories/settingsRepo');
const userRepo = require('../repositories/userRepo');

const DEFAULT_EMAILS_KEY = 'default_notify_emails';

/** Upper bound on one list, so a pasted spreadsheet column cannot fan out. */
const MAX_RECIPIENTS = 50;

/**
 * Deliberately loose: one `@`, a dot in the domain, no whitespace. It exists to
 * catch typos and the `admin@local` placeholder, not to second-guess the mail
 * server.
 */
const EMAIL_SHAPE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

class InvalidEmailError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

function isDeliverable(address) {
  return typeof address === 'string' && EMAIL_SHAPE.test(address.trim());
}

/**
 * Normalise a recipient list from an array or free text (commas, semicolons,
 * newlines). Lower-cased, de-duplicated, order kept.
 *
 * @throws {InvalidEmailError} naming the first address that is not an address
 */
function parseEmails(input) {
  if (input === undefined || input === null || input === '') return [];

  const parts = Array.isArray(input) ? input : String(input).split(/[\s,;]+/);
  const seen = new Set();
  const out = [];

  for (const raw of parts) {
    if (typeof raw !== 'string') {
      throw new InvalidEmailError('Recipients must be email addresses');
    }
    const address = raw.trim().toLowerCase();
    if (!address) continue;
    if (!isDeliverable(address)) {
      throw new InvalidEmailError(`"${raw.trim()}" is not a valid email address`);
    }
    if (!seen.has(address)) {
      seen.add(address);
      out.push(address);
    }
  }

  if (out.length > MAX_RECIPIENTS) {
    throw new InvalidEmailError(`At most ${MAX_RECIPIENTS} recipients are allowed`);
  }
  return out;
}

function defaultEmails() {
  const stored = settingsRepo.get(DEFAULT_EMAILS_KEY, []);
  return Array.isArray(stored) ? stored : [];
}

function setDefaultEmails(list) {
  settingsRepo.set(DEFAULT_EMAILS_KEY, list);
}

/**
 * Resolve the recipients for a scheduled scan.
 *
 * @param {{ ownerId: number, groupEmails?: string[] }} params
 * @returns {{ recipients: string[], source: 'group'|'default'|'account'|'none' }}
 */
function recipientsFor({ ownerId, groupEmails = [] }) {
  if (groupEmails.length > 0) return { recipients: groupEmails, source: 'group' };

  const defaults = defaultEmails();
  if (defaults.length > 0) return { recipients: defaults, source: 'default' };

  const account = ownerId ? userRepo.findById(ownerId) : null;
  if (account && isDeliverable(account.email)) {
    return { recipients: [account.email], source: 'account' };
  }

  return { recipients: [], source: 'none' };
}

module.exports = {
  parseEmails,
  isDeliverable,
  defaultEmails,
  setDefaultEmails,
  recipientsFor,
  InvalidEmailError,
  MAX_RECIPIENTS,
};
