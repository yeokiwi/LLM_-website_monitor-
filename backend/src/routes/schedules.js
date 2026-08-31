/**
 * Scheduled scans.
 *
 * A schedule is per-website and plan-gated: which cadences a customer may pick
 * comes from their entitlements, and is re-checked when the scheduler fires so
 * a downgrade cannot leave an hourly schedule running.
 */

const express = require('express');

const scheduleRepo = require('../repositories/scheduleRepo');
const websiteRepo = require('../repositories/websiteRepo');
const entitlements = require('../services/entitlements');
const { suggestPlanFor } = require('../middleware/entitlements');

const router = express.Router();

// ---------------------------------------------------------------------------
// GET /api/schedules — the caller's schedules and the cadences they may use
// ---------------------------------------------------------------------------
router.get('/', (req, res) => {
  res.json({
    schedules: scheduleRepo.listForOwner(req.user.userId),
    allowedFrequencies: entitlements.allowedSchedules(req.user.userId),
  });
});

// ---------------------------------------------------------------------------
// PUT /api/schedules/:websiteId — create or update a website's schedule
// Body: { frequency: 'hourly'|'daily'|'weekly', periodDays?: number, isEnabled?: boolean }
// ---------------------------------------------------------------------------
router.put('/:websiteId', (req, res) => {
  const { frequency, periodDays, isEnabled } = req.body;

  const website = websiteRepo.findActiveById(req.user.userId, req.params.websiteId);
  if (!website) return res.status(404).json({ error: 'Website not found' });

  if (!scheduleRepo.FREQUENCIES.includes(frequency)) {
    return res.status(400).json({
      error: `frequency must be one of: ${scheduleRepo.FREQUENCIES.join(', ')}`,
    });
  }

  const allowed = entitlements.allowedSchedules(req.user.userId);
  if (!allowed.includes(frequency)) {
    return res.status(402).json({
      error:
        allowed.length === 0
          ? 'Scheduled scans are not included in your current plan'
          : `Your plan supports ${allowed.join(' and ')} schedules`,
      code: 'FEATURE_LOCKED',
      feature: 'schedules',
      allowedFrequencies: allowed,
      upgradeTo: suggestPlanFor((e) => (e.schedules || []).includes(frequency)),
    });
  }

  const period = parseInt(periodDays, 10) || 30;
  if (period < 1 || period > 3650) {
    return res.status(400).json({ error: 'periodDays must be between 1 and 3650' });
  }

  const schedule = scheduleRepo.upsert(req.user.userId, website.id, {
    frequency,
    periodDays: period,
    isEnabled: isEnabled === undefined ? true : Boolean(isEnabled),
  });

  res.json(schedule);
});

// ---------------------------------------------------------------------------
// DELETE /api/schedules/:websiteId — stop scanning a website automatically
// ---------------------------------------------------------------------------
router.delete('/:websiteId', (req, res) => {
  const removed = scheduleRepo.remove(req.user.userId, req.params.websiteId);
  if (removed === 0) return res.status(404).json({ error: 'Schedule not found' });
  res.json({ message: 'Schedule removed' });
});

module.exports = router;
