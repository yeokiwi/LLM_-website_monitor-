/**
 * Transactional email.
 *
 * SMTP is configured through standard environment variables, so this works with
 * Resend, SendGrid, SES, Postmark, Mailgun or a plain mail server without a
 * provider-specific SDK.
 *
 * When SMTP is not configured the message is logged instead of sent. That keeps
 * local development and the existing self-hosted deployments working: a missing
 * mail server must never break signup or a scan.
 */

const nodemailer = require('nodemailer');

let transporter;
let transporterChecked = false;

function isConfigured() {
  return Boolean(process.env.SMTP_HOST);
}

function getTransporter() {
  if (transporterChecked) return transporter;
  transporterChecked = true;

  if (!isConfigured()) {
    transporter = null;
    return null;
  }

  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT, 10) || 587,
    secure: /^(1|true|yes)$/i.test(process.env.SMTP_SECURE || '')
      || parseInt(process.env.SMTP_PORT, 10) === 465,
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
  });

  return transporter;
}

/** Public base URL of the app, used to build links in emails. */
function appUrl() {
  return (process.env.APP_URL || 'http://localhost:5173').replace(/\/+$/, '');
}

/**
 * Send one message. Never throws — a mail failure is logged and swallowed so it
 * cannot fail the request that triggered it.
 *
 * @param {{ to: string, subject: string, html: string, text?: string }} message
 * @returns {Promise<boolean>} whether the message was actually handed to SMTP
 */
async function send({ to, subject, html, text }) {
  const tx = getTransporter();

  if (!tx) {
    console.log(`📧 [mail not configured] To: ${to} — ${subject}`);
    return false;
  }

  try {
    await tx.sendMail({
      from: process.env.SMTP_FROM || 'Website Monitor <no-reply@localhost>',
      to,
      subject,
      html,
      text: text || stripHtml(html),
    });
    return true;
  } catch (err) {
    console.error(`Failed to send "${subject}" to ${to}:`, err.message);
    return false;
  }
}

function stripHtml(html) {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

module.exports = { send, isConfigured, appUrl, stripHtml };
