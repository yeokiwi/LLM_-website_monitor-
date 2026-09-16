/**
 * Email templates.
 *
 * Plain template literals rather than a templating engine — there is one
 * message and no designer workflow to support. It returns `{ subject, html }`
 * ready for mailer.send().
 */

const { appUrl } = require('./mailer');

const BRAND = 'Website Monitor';

/** Shared chrome so every message looks like it came from the same product. */
function layout(heading, bodyHtml) {
  return `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
            max-width:560px;margin:0 auto;padding:24px;color:#1a1a1a;line-height:1.6">
  <p style="font-size:18px;font-weight:600;margin:0 0 20px">🔍 ${BRAND}</p>
  <h1 style="font-size:20px;margin:0 0 16px">${heading}</h1>
  ${bodyHtml}
  <hr style="border:none;border-top:1px solid #e5e5e5;margin:28px 0 16px">
  <p style="font-size:12px;color:#767676;margin:0">
    You are receiving this because ${BRAND} is watching this page for you.
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
// Change alerts
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

module.exports = {
  layout,
  button,
  escapeHtml,
  changeDetected,
};

// ---------------------------------------------------------------------------

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
