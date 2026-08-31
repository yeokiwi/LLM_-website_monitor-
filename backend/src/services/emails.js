/**
 * Email templates.
 *
 * Plain template literals rather than a templating engine — there are a dozen
 * short messages and no designer workflow to support. Each function returns
 * `{ subject, html }` ready for mailer.send().
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
    You are receiving this because you have a ${BRAND} account.
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
// Account
// ---------------------------------------------------------------------------

function verifyEmail({ name, token }) {
  const href = `${appUrl()}/verify-email?token=${encodeURIComponent(token)}`;
  return {
    subject: `Confirm your ${BRAND} email address`,
    html: layout(
      `Welcome${name ? `, ${escapeHtml(name)}` : ''}`,
      `<p>Confirm your email address to activate your account. This link expires in 48 hours.</p>
       ${button(href, 'Confirm email address')}`
    ),
  };
}

function passwordReset({ token }) {
  const href = `${appUrl()}/reset-password?token=${encodeURIComponent(token)}`;
  return {
    subject: `Reset your ${BRAND} password`,
    html: layout(
      'Reset your password',
      `<p>Use the link below to choose a new password. It expires in one hour.</p>
       ${button(href, 'Choose a new password')}
       <p style="font-size:13px;color:#767676">
         If you did not request this, you can ignore this email — your password will not change.
       </p>`
    ),
  };
}

function passwordChanged() {
  return {
    subject: `Your ${BRAND} password was changed`,
    html: layout(
      'Your password was changed',
      `<p>The password on your account was just changed.</p>
       <p>If this was not you, reset your password immediately and contact support.</p>`
    ),
  };
}

// ---------------------------------------------------------------------------
// Billing
// ---------------------------------------------------------------------------

function formatMoney(cents, currency) {
  const amount = Math.abs(cents) / 100;
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: (currency || 'usd').toUpperCase(),
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${(currency || 'usd').toUpperCase()}`;
  }
}

function paymentReceipt({ amountCents, currency, invoiceUrl }) {
  return {
    subject: `Your ${BRAND} receipt`,
    html: layout(
      'Payment received',
      `<p>Thanks — we have received your payment of
         <strong>${formatMoney(amountCents, currency)}</strong>.</p>
       ${invoiceUrl ? button(invoiceUrl, 'View invoice') : ''}`
    ),
  };
}

function paymentFailed({ amountCents, currency }) {
  const href = `${appUrl()}/account/billing`;
  return {
    subject: `Action needed: payment failed`,
    html: layout(
      'We could not take your payment',
      `<p>The charge of <strong>${formatMoney(amountCents, currency)}</strong> did not go
         through. Your plan stays active for a short grace period while you update
         your payment details.</p>
       ${button(href, 'Update payment details')}`
    ),
  };
}

function planDowngraded({ parked, stopped }) {
  const href = `${appUrl()}/account/billing`;
  const parts = [];
  if (parked > 0) {
    parts.push(
      `<li><strong>${parked}</strong> website${parked === 1 ? ' was' : 's were'} paused
       to fit your plan's limit. Nothing was deleted — their history is intact.</li>`
    );
  }
  if (stopped > 0) {
    parts.push(
      `<li><strong>${stopped}</strong> scheduled scan${stopped === 1 ? '' : 's'}
       ${stopped === 1 ? 'was' : 'were'} switched off.</li>`
    );
  }

  return {
    subject: `Your ${BRAND} plan changed`,
    html: layout(
      'Your plan changed',
      `<p>Following a change to your subscription, we adjusted your account:</p>
       <ul>${parts.join('')}</ul>
       <p>Upgrading again restores the limits, and you can choose which sites to
          reactivate.</p>
       ${button(href, 'Review your plan')}`
    ),
  };
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

function quotaWarning({ used, limit, periodEnd }) {
  const href = `${appUrl()}/pricing`;
  return {
    subject: `You have used ${Math.round((used / limit) * 100)}% of your scans`,
    html: layout(
      'Approaching your scan limit',
      `<p>You have used <strong>${used}</strong> of <strong>${limit}</strong> scans
         included in your plan. The allowance resets on ${escapeHtml(periodEnd)}.</p>
       ${button(href, 'See plans')}`
    ),
  };
}

function quotaExhausted({ limit, periodEnd }) {
  const href = `${appUrl()}/pricing`;
  return {
    subject: `You have used all ${limit} scans in your plan`,
    html: layout(
      'Scan limit reached',
      `<p>All <strong>${limit}</strong> scans included in your plan have been used.
         Scheduled scans are paused until the allowance resets on
         ${escapeHtml(periodEnd)}.</p>
       ${button(href, 'Upgrade for more scans')}`
    ),
  };
}

// ---------------------------------------------------------------------------
// Product
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
  formatMoney,
  verifyEmail,
  passwordReset,
  passwordChanged,
  paymentReceipt,
  paymentFailed,
  planDowngraded,
  quotaWarning,
  quotaExhausted,
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
