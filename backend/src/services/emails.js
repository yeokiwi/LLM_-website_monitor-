/**
 * Email templates.
 *
 * Plain template literals rather than a templating engine — a few messages and
 * no designer workflow to support. Each returns `{ subject, html }` ready for
 * mailer.send(). Every interpolated value goes through escapeHtml.
 */

const { appUrl } = require('./mailer');

const BRAND = 'Website Monitor';

const DEFAULT_FOOTER = `You are receiving this because ${BRAND} is watching this page for you.`;

/** Shared chrome so every message looks like it came from the same product. */
function layout(heading, bodyHtml, footerHtml = escapeHtml(DEFAULT_FOOTER)) {
  return `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
            max-width:560px;margin:0 auto;padding:24px;color:#1a1a1a;line-height:1.6">
  <p style="font-size:18px;font-weight:600;margin:0 0 20px">🔍 ${BRAND}</p>
  <h1 style="font-size:20px;margin:0 0 16px">${heading}</h1>
  ${bodyHtml}
  <hr style="border:none;border-top:1px solid #e5e5e5;margin:28px 0 16px">
  <p style="font-size:12px;color:#767676;margin:0">
    ${footerHtml}
  </p>
</div>`.trim();
}

function button(href, label) {
  return `<p style="margin:24px 0">
    <a href="${href}" style="background:#1a1a1a;color:#fff;text-decoration:none;
       padding:11px 20px;border-radius:6px;display:inline-block;font-weight:500">${label}</a>
  </p>
  <p style="font-size:13px;color:#767676;margin:0">
    If the button does not work, paste this into your browser:<br>
    <span style="word-break:break-all">${href}</span>
  </p>`;
}

// ---------------------------------------------------------------------------
// Change alerts — a single website's schedule
// ---------------------------------------------------------------------------

/** The message that carries the product's actual value. */
function changeDetected({ websiteName, websiteUrl, scanId, summary }) {
  const href = `${appUrl()}/report/${scanId}`;
  const label = websiteName ? `${escapeHtml(websiteName)}` : escapeHtml(websiteUrl);

  return {
    subject: `Changes detected on ${label}`,
    html: layout(
      `Changes on ${label}`,
      `<p style="font-size:13px;color:#767676;margin:0 0 16px">
         <a href="${escapeHtml(websiteUrl)}" style="color:#767676">${escapeHtml(websiteUrl)}</a>
       </p>
       <div style="background:#f7f7f7;border-radius:8px;padding:14px 16px;font-size:14px">
         ${escapeHtml(summary || '').slice(0, 1200).replace(/\n/g, '<br>')}
       </div>
       ${button(href, 'Read the full report')}`
    ),
  };
}

// ---------------------------------------------------------------------------
// Group digest — one message per scheduled group run
// ---------------------------------------------------------------------------

const STATUS_LABEL = {
  completed: 'Changed',
  partial: 'Changed (one engine failed)',
  no_changes: 'No changes',
  no_history: 'First scan — baseline saved',
  error: 'Scan failed',
};

const STATUS_COLOUR = {
  changed: '#b45309',
  failed: '#b91c1c',
  quiet: '#4b5563',
};

/** How a site's result reads in a digest: changed, failed, or quiet. */
function outcomeOf(result) {
  if (result.status === 'error') return 'failed';
  if (result.changesFound) return 'changed';
  return 'quiet';
}

/**
 * Strip markdown down to a plain opening for the digest. The full report is a
 * click away; the email only has to say whether it is worth the click.
 */
function opening(markdown, max = 280) {
  const text = String(markdown || '')
    .replace(/^#+\s*Executive Summary\s*$/im, '')
    .replace(/^#+\s.*$/gm, '')
    .replace(/[*_`>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max).replace(/\s+\S*$/, '')}…` : text;
}

/**
 * One email for one scheduled run of a group.
 *
 * The subject carries the outcome, so the inbox alone says whether to open it.
 * Changed and failed sites are listed first: those are why the message exists.
 *
 * @param {object} params
 * @param {string} params.groupName
 * @param {string} params.scheduleLabel   e.g. "Every week"
 * @param {Array<{ name?: string, url: string, status: string, changesFound: boolean,
 *                 scanId?: number|null, summary?: string, error?: string }>} params.results
 */
function groupScanDigest({ groupName, scheduleLabel, results }) {
  const changed = results.filter((r) => outcomeOf(r) === 'changed');
  const failed = results.filter((r) => outcomeOf(r) === 'failed');
  const quiet = results.filter((r) => outcomeOf(r) === 'quiet');
  const total = results.length;
  const sites = `site${total === 1 ? '' : 's'}`;

  const counts = [];
  if (changed.length) counts.push(`${changed.length} changed`);
  if (failed.length) counts.push(`${failed.length} failed`);

  const subject = counts.length
    ? `${groupName}: ${counts.join(', ')} of ${total} ${sites}`
    : `${groupName}: no changes across ${total} ${sites}`;

  const rows = [...changed, ...failed, ...quiet].map((r) => digestRow(r)).join('');

  const groupsHref = `${appUrl()}/groups`;
  const footer =
    `You are receiving this because you are on the notification list for the ` +
    `<strong>${escapeHtml(groupName)}</strong> group. ` +
    `<a href="${groupsHref}" style="color:#767676">Change who gets these</a>.`;

  return {
    subject,
    html: layout(
      escapeHtml(subject),
      `<p style="font-size:14px;color:#4b5563;margin:0 0 18px">
         Scheduled scan${scheduleLabel ? ` (${escapeHtml(scheduleLabel.toLowerCase())})` : ''}
         of ${total} ${sites} in <strong>${escapeHtml(groupName)}</strong>.
       </p>
       <table role="presentation" style="width:100%;border-collapse:collapse;font-size:14px">
         ${rows}
       </table>
       ${button(`${appUrl()}/history`, 'Open scan history')}`,
      footer
    ),
  };
}

function digestRow(result) {
  const outcome = outcomeOf(result);
  const label = escapeHtml(result.name || result.url);
  const status = escapeHtml(STATUS_LABEL[result.status] || result.status);

  let detail = '';
  if (outcome === 'failed') {
    detail = escapeHtml(opening(result.error || 'The scan did not complete.', 200));
  } else if (outcome === 'changed') {
    detail = escapeHtml(opening(result.summary));
  }

  const report = result.scanId
    ? `<a href="${appUrl()}/report/${result.scanId}" style="color:#1a1a1a">Read report</a>`
    : '';

  return `
  <tr>
    <td style="padding:12px 0;border-top:1px solid #e5e5e5;vertical-align:top">
      <div style="font-weight:600">${label}</div>
      <div style="font-size:12px;color:#767676;word-break:break-all">${escapeHtml(result.url)}</div>
      ${detail ? `<div style="margin-top:6px;color:#374151">${detail}</div>` : ''}
    </td>
    <td style="padding:12px 0 12px 12px;border-top:1px solid #e5e5e5;vertical-align:top;
               text-align:right;white-space:nowrap">
      <div style="font-weight:600;color:${STATUS_COLOUR[outcome]}">${status}</div>
      ${report ? `<div style="margin-top:6px;font-size:13px">${report}</div>` : ''}
    </td>
  </tr>`;
}

// ---------------------------------------------------------------------------
// Test message
// ---------------------------------------------------------------------------

function testMessage() {
  return {
    subject: `${BRAND}: test message`,
    html: layout(
      'Email is working',
      `<p style="font-size:14px;margin:0 0 12px">
         This is a test from ${BRAND}. If you are reading it, scheduled scan
         notifications will reach this address.
       </p>
       ${button(`${appUrl()}/schedules`, 'Open schedules')}`,
      escapeHtml(`Sent because someone pressed "Send test email" in ${BRAND}.`)
    ),
  };
}

module.exports = {
  layout,
  button,
  escapeHtml,
  changeDetected,
  groupScanDigest,
  testMessage,
};

// ---------------------------------------------------------------------------

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
