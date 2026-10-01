/**
 * Website groups — a named, saved set of websites.
 *
 * A group is scanned by hand (the dashboard selects its members and runs the
 * ordinary scan) or on a schedule (the scheduler scans its members and emails
 * one digest to the group's recipients).
 *
 *   GET    /api/groups               — the caller's groups, members and schedules
 *   POST   /api/groups               — { name, websiteIds, notifyEmails?, notifyOn? }
 *   PATCH  /api/groups/:id           — any of the above
 *   DELETE /api/groups/:id           — the grouping only; websites and history stay
 *   PUT    /api/groups/:id/schedule  — { frequency, periodDays?, isEnabled? }
 *   DELETE /api/groups/:id/schedule
 */

const express = require('express');

const groupRepo = require('../repositories/groupRepo');
const groupScheduleRepo = require('../repositories/groupScheduleRepo');
const scheduleRepo = require('../repositories/scheduleRepo');
const websiteRepo = require('../repositories/websiteRepo');
const { parseEmails, InvalidEmailError } = require('../services/notifications');

const router = express.Router();

const NAME_MAX = 100;
const NOTIFY_MODES = ['always', 'changes'];

class BadRequest extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/**
 * Validate the fields of a create or update body. Only keys present in the body
 * come back, so a PATCH changes exactly what it names.
 */
function readGroupFields(ownerId, body, { requireName, existingId = null }) {
  const fields = {};

  if (body.name !== undefined || requireName) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) throw new BadRequest('Give the group a name');
    if (name.length > NAME_MAX) {
      throw new BadRequest(`Group names are at most ${NAME_MAX} characters`);
    }
    const clash = groupRepo.findByName(ownerId, name);
    if (clash && clash.id !== existingId) {
      throw new BadRequest(`There is already a group called "${name}"`, 409);
    }
    fields.name = name;
  }

  if (body.websiteIds !== undefined) {
    if (!Array.isArray(body.websiteIds)) {
      throw new BadRequest('websiteIds must be an array');
    }
    const ids = [...new Set(body.websiteIds.map((x) => Number(x)))];
    if (ids.some((id) => !Number.isInteger(id))) {
      throw new BadRequest('websiteIds must be website ids');
    }

    // Unknown ids are an error, not something to drop quietly: a group saved
    // with fewer sites than were picked is a monitoring gap nobody would notice.
    const found = new Set(websiteRepo.findActiveByIds(ownerId, ids).map((w) => w.id));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length > 0) {
      throw new BadRequest(`Unknown website id(s): ${missing.join(', ')}`);
    }
    fields.websiteIds = ids;
  }

  if (body.notifyEmails !== undefined) {
    fields.notifyEmails = parseEmails(body.notifyEmails);
  }

  if (body.notifyOn !== undefined) {
    if (!NOTIFY_MODES.includes(body.notifyOn)) {
      throw new BadRequest(`notifyOn must be one of: ${NOTIFY_MODES.join(', ')}`);
    }
    fields.notifyOn = body.notifyOn;
  }

  return fields;
}

/** Turn a validation error into its response; let anything else propagate. */
function handle(fn) {
  return (req, res, next) => {
    try {
      fn(req, res);
    } catch (err) {
      if (err instanceof BadRequest || err instanceof InvalidEmailError) {
        return res.status(err.status).json({ error: err.message });
      }
      next(err);
    }
  };
}

// ---------------------------------------------------------------------------

router.get('/', (req, res) => {
  res.json({
    groups: groupRepo.listForOwner(req.user.userId),
    allowedFrequencies: scheduleRepo.FREQUENCIES,
  });
});

router.post(
  '/',
  handle((req, res) => {
    const fields = readGroupFields(req.user.userId, req.body, { requireName: true });
    const group = groupRepo.create(req.user.userId, {
      websiteIds: [],
      ...fields,
    });
    res.status(201).json(group);
  })
);

router.patch(
  '/:id',
  handle((req, res) => {
    const id = Number(req.params.id);
    if (!groupRepo.findById(req.user.userId, id)) {
      return res.status(404).json({ error: 'Group not found' });
    }

    const fields = readGroupFields(req.user.userId, req.body, {
      requireName: false,
      existingId: id,
    });
    res.json(groupRepo.update(req.user.userId, id, fields));
  })
);

router.delete('/:id', (req, res) => {
  const removed = groupRepo.remove(req.user.userId, Number(req.params.id));
  if (removed === 0) return res.status(404).json({ error: 'Group not found' });
  res.json({ message: 'Group deleted' });
});

// ---------------------------------------------------------------------------
// Schedule — validation matches routes/schedules.js so the two kinds of
// schedule accept exactly the same cadences and periods.
// ---------------------------------------------------------------------------

router.put('/:id/schedule', (req, res) => {
  const id = Number(req.params.id);
  const group = groupRepo.findById(req.user.userId, id);
  if (!group) return res.status(404).json({ error: 'Group not found' });

  const { frequency, periodDays, isEnabled } = req.body;

  if (!scheduleRepo.FREQUENCIES.includes(frequency)) {
    return res.status(400).json({
      error: `frequency must be one of: ${scheduleRepo.FREQUENCIES.join(', ')}`,
    });
  }

  const period = parseInt(periodDays, 10) || 30;
  if (period < 1 || period > 3650) {
    return res.status(400).json({ error: 'periodDays must be between 1 and 3650' });
  }

  groupScheduleRepo.upsert(req.user.userId, id, {
    frequency,
    periodDays: period,
    isEnabled: isEnabled === undefined ? true : Boolean(isEnabled),
  });

  res.json(groupRepo.findById(req.user.userId, id));
});

router.delete('/:id/schedule', (req, res) => {
  const removed = groupScheduleRepo.remove(req.user.userId, Number(req.params.id));
  if (removed === 0) return res.status(404).json({ error: 'Schedule not found' });
  res.json({ message: 'Schedule removed' });
});

module.exports = router;
