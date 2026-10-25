/**
 * Instance settings.
 *
 *   GET  /api/settings/notifications       — default recipients and mail status
 *   PUT  /api/settings/notifications       — { defaultEmails }
 *   POST /api/settings/notifications/test  — { emails? } send a test message
 *
 * The test endpoint is the point of this file as much as the settings are: a
 * broken mail setup used to be invisible until someone noticed that alerts had
 * never arrived.
 */

const express = require('express');

const mailer = require('../services/mailer');
const emails = require('../services/emails');
const notifications = require('../services/notifications');

const router = express.Router();

function currentSettings(user) {
  return {
    defaultEmails: notifications.defaultEmails(),
    smtpConfigured: mailer.isConfigured(),
    accountEmail: user.email,
    accountEmailUsable: notifications.isDeliverable(user.email),
  };
}

router.get('/notifications', (req, res) => {
  res.json(currentSettings(req.user));
});

router.put('/notifications', (req, res) => {
  let list;
  try {
    list = notifications.parseEmails(req.body.defaultEmails);
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }

  notifications.setDefaultEmails(list);
  res.json(currentSettings(req.user));
});

router.post('/notifications/test', async (req, res) => {
  let list;
  try {
    list = req.body.emails !== undefined
      ? notifications.parseEmails(req.body.emails)
      : notifications.defaultEmails();
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }

  if (list.length === 0) {
    return res.status(400).json({ error: 'Add at least one recipient first' });
  }

  if (!mailer.isConfigured()) {
    return res.status(409).json({
      error:
        'Email delivery is not configured on the server (SMTP_HOST is unset), ' +
        'so messages are written to the server log instead of being sent.',
      code: 'SMTP_NOT_CONFIGURED',
    });
  }

  const message = emails.testMessage();
  const results = [];
  // One message per address, as real alerts are sent: recipients do not see
  // each other, and one rejected address does not hide whether the rest worked.
  for (const to of list) {
    results.push({ to, sent: await mailer.send({ to, ...message }) });
  }

  res.json({ results, allSent: results.every((r) => r.sent) });
});

module.exports = router;
