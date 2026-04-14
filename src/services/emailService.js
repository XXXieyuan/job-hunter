'use strict';

const nodemailer = require('nodemailer');
const config = require('../config');
const { getLogger } = require('../logger');

const logger = getLogger('emailService');

let transport = null;
let enabled = false;

/**
 * Replace the 5 dangerous HTML characters with entities.
 */
function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

/**
 * Initialise the nodemailer transport from config.
 * Called once at module load time.
 */
function initTransport() {
  if (!config.EMAIL_ENABLED) {
    enabled = false;
    logger.warn('Email disabled (EMAIL_ENABLED=false)');
    return;
  }

  try {
    transport = nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_SECURE,
      auth: {
        user: config.SMTP_USER,
        pass: config.SMTP_PASS,
      },
    });
    enabled = true;
  } catch (err) {
    logger.warn('Failed to create email transport', { error: err.message });
    enabled = false;
  }
}

initTransport();

/**
 * Verify SMTP connection. Gracefully degrades on failure.
 */
async function verifyConnection() {
  if (!transport) {
    enabled = false;
    return;
  }
  try {
    await transport.verify();
    logger.info('SMTP connection verified');
  } catch (err) {
    logger.warn('SMTP connection failed, email disabled', { error: err.message });
    enabled = false;
  }
}

/**
 * Check if email sending is enabled and transport is ready.
 */
function isEnabled() {
  return enabled;
}

/**
 * Get the score colour for HTML email badge.
 */
function scoreColour(score) {
  if (score >= 75) return '#e67e22';
  if (score >= 60) return '#1abc9c';
  return '#3498db';
}

/**
 * Get visa status display text.
 */
function visaText(visaMatch) {
  if (visaMatch === 1) return 'Visa holders welcome';
  if (visaMatch === 0) return 'Citizenship/PR required';
  return '';
}

/**
 * Build the HTML body for a single alert email.
 */
function buildAlertHtml(user, notification, job, unsubscribeToken) {
  const baseUrl = config.APP_BASE_URL;
  const title = escapeHtml(job.title || job.job_title || '');
  const company = escapeHtml(job.company_name || '');
  const location = escapeHtml(job.location || '');
  const score = notification.score;
  const colour = scoreColour(score);

  let skills = [];
  try {
    skills = typeof notification.top_matched_skills === 'string'
      ? JSON.parse(notification.top_matched_skills)
      : notification.top_matched_skills || [];
  } catch { skills = []; }

  const skillsHtml = skills.map(s => escapeHtml(s)).join(', ');
  const visa = visaText(notification.visa_match);
  const jobUrl = `${baseUrl}/jobs/${job.id || job.job_id}?alert_read=${notification.read_token}`;
  const unsubUrl = `${baseUrl}/alerts/unsubscribe/${unsubscribeToken}`;
  const settingsUrl = `${baseUrl}/settings`;

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:24px 0">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:8px;overflow:hidden">
  <tr><td style="background:#2c3e50;padding:20px 24px;color:#ffffff;font-size:18px;font-weight:600">Job Hunter</td></tr>
  <tr><td style="padding:24px">
    <p style="margin:0 0 8px;font-size:14px;color:#666">New high-match job found!</p>
    <h2 style="margin:0 0 4px;font-size:20px;color:#2c3e50">${title}</h2>
    <p style="margin:0 0 16px;font-size:15px;color:#555">${company}${location ? ' &mdash; ' + location : ''}</p>
    <table cellpadding="0" cellspacing="0" style="margin-bottom:16px"><tr>
      <td style="background:${colour};color:#fff;font-weight:700;font-size:16px;padding:6px 14px;border-radius:4px">${score}% match</td>
      ${visa ? `<td style="padding-left:12px;font-size:14px;color:#555">${escapeHtml(visa)}</td>` : ''}
    </tr></table>
    ${skillsHtml ? `<p style="margin:0 0 16px;font-size:14px;color:#555">Top matched skills: ${skillsHtml}</p>` : ''}
    <table cellpadding="0" cellspacing="0"><tr><td>
      <a href="${escapeHtml(jobUrl)}" style="display:inline-block;background:#3498db;color:#ffffff;font-weight:600;font-size:15px;padding:10px 24px;border-radius:4px;text-decoration:none">View Job Details</a>
    </td></tr></table>
  </td></tr>
  <tr><td style="padding:16px 24px;background:#f9f9f9;font-size:12px;color:#999;border-top:1px solid #eee">
    You&#x27;re receiving this because you have job alerts enabled.<br>
    <a href="${escapeHtml(settingsUrl)}" style="color:#999">Adjust preferences</a> &middot;
    <a href="${escapeHtml(unsubUrl)}" style="color:#999">Unsubscribe from all alerts</a>
  </td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

/**
 * Build the plain-text body for a single alert email.
 */
function buildAlertText(user, notification, job, unsubscribeToken) {
  const baseUrl = config.APP_BASE_URL;
  const title = job.title || job.job_title || '';
  const company = job.company_name || '';
  const score = notification.score;
  const visa = visaText(notification.visa_match);

  let skills = [];
  try {
    skills = typeof notification.top_matched_skills === 'string'
      ? JSON.parse(notification.top_matched_skills)
      : notification.top_matched_skills || [];
  } catch { skills = []; }

  const jobUrl = `${baseUrl}/jobs/${job.id || job.job_id}?alert_read=${notification.read_token}`;
  const unsubUrl = `${baseUrl}/alerts/unsubscribe/${unsubscribeToken}`;

  let text = `New high-match job found!\n\n`;
  text += `${title} at ${company}\n`;
  text += `Match: ${score}%`;
  if (visa) text += ` | ${visa}`;
  text += '\n';
  if (skills.length > 0) text += `\nTop matched skills: ${skills.join(', ')}\n`;
  text += `\nView job details: ${jobUrl}\n`;
  text += `\n---\n`;
  text += `You're receiving this because you have job alerts enabled.\n`;
  text += `Adjust your alert preferences: ${baseUrl}/settings\n`;
  text += `Unsubscribe from all alerts: ${unsubUrl}\n`;
  return text;
}

/**
 * Send an immediate alert email for a single job notification.
 *
 * @param {object} user - { id, email, display_name }
 * @param {object} notification - notification row with score, top_matched_skills, visa_match, read_token
 * @param {object} job - job row with id, title/job_title, company_name, location
 * @param {string} unsubscribeToken - 64-char hex unsubscribe token
 */
async function sendAlertEmail(user, notification, job, unsubscribeToken) {
  if (!isEnabled()) return;

  const baseUrl = config.APP_BASE_URL;
  const title = job.title || job.job_title || '';
  const company = job.company_name || '';
  const unsubUrl = `${baseUrl}/alerts/unsubscribe/${unsubscribeToken}`;

  const mailOptions = {
    from: config.EMAIL_FROM || 'Job Hunter <noreply@jobhunter.local>',
    to: user.email,
    subject: `New match: ${title} at ${company} (Score: ${notification.score}%)`,
    html: buildAlertHtml(user, notification, job, unsubscribeToken),
    text: buildAlertText(user, notification, job, unsubscribeToken),
    headers: {
      'Precedence': 'bulk',
      'List-Unsubscribe': `<${unsubUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  };

  await transport.sendMail(mailOptions);
}

/**
 * Build HTML for a digest email with multiple job notifications.
 */
function buildDigestHtml(user, notifications, jobs, unsubscribeToken) {
  const baseUrl = config.APP_BASE_URL;
  const unsubUrl = `${baseUrl}/alerts/unsubscribe/${unsubscribeToken}`;
  const settingsUrl = `${baseUrl}/settings`;

  const capped = notifications.slice(0, 20);

  const jobCardsHtml = capped.map(n => {
    const job = jobs.find(j => (j.id || j.job_id) === (n.job_id)) || {};
    const title = escapeHtml(job.title || job.job_title || '');
    const company = escapeHtml(job.company_name || '');
    const colour = scoreColour(n.score);
    const jobUrl = `${baseUrl}/jobs/${n.job_id}?alert_read=${n.read_token}`;

    let skills = [];
    try {
      skills = typeof n.top_matched_skills === 'string'
        ? JSON.parse(n.top_matched_skills)
        : n.top_matched_skills || [];
    } catch { skills = []; }

    return `<tr><td style="padding:12px 0;border-bottom:1px solid #eee">
      <table cellpadding="0" cellspacing="0" width="100%"><tr>
        <td>
          <a href="${escapeHtml(jobUrl)}" style="font-size:15px;font-weight:600;color:#2c3e50;text-decoration:none">${title}</a>
          <br><span style="font-size:13px;color:#555">${company}</span>
          ${skills.length > 0 ? `<br><span style="font-size:12px;color:#888">Skills: ${skills.map(s => escapeHtml(s)).join(', ')}</span>` : ''}
        </td>
        <td width="80" align="right" style="vertical-align:top">
          <span style="background:${colour};color:#fff;font-weight:700;font-size:13px;padding:4px 10px;border-radius:4px">${n.score}%</span>
        </td>
      </tr></table>
    </td></tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:24px 0">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:8px;overflow:hidden">
  <tr><td style="background:#2c3e50;padding:20px 24px;color:#ffffff;font-size:18px;font-weight:600">Job Hunter</td></tr>
  <tr><td style="padding:24px">
    <h2 style="margin:0 0 16px;font-size:18px;color:#2c3e50">Daily digest: ${capped.length} new job match${capped.length !== 1 ? 'es' : ''}</h2>
    <table cellpadding="0" cellspacing="0" width="100%">
      ${jobCardsHtml}
    </table>
  </td></tr>
  <tr><td style="padding:16px 24px;background:#f9f9f9;font-size:12px;color:#999;border-top:1px solid #eee">
    You&#x27;re receiving this because you have job alerts enabled.<br>
    <a href="${escapeHtml(settingsUrl)}" style="color:#999">Adjust preferences</a> &middot;
    <a href="${escapeHtml(unsubUrl)}" style="color:#999">Unsubscribe from all alerts</a>
  </td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

/**
 * Build plain-text for a digest email.
 */
function buildDigestText(user, notifications, jobs, unsubscribeToken) {
  const baseUrl = config.APP_BASE_URL;
  const unsubUrl = `${baseUrl}/alerts/unsubscribe/${unsubscribeToken}`;
  const capped = notifications.slice(0, 20);

  let text = `Daily digest: ${capped.length} new job match${capped.length !== 1 ? 'es' : ''}\n\n`;

  for (const n of capped) {
    const job = jobs.find(j => (j.id || j.job_id) === (n.job_id)) || {};
    const title = job.title || job.job_title || '';
    const company = job.company_name || '';
    const jobUrl = `${baseUrl}/jobs/${n.job_id}?alert_read=${n.read_token}`;
    text += `${title} at ${company} — ${n.score}% match\n`;
    text += `  ${jobUrl}\n\n`;
  }

  text += `---\n`;
  text += `You're receiving this because you have job alerts enabled.\n`;
  text += `Adjust your alert preferences: ${baseUrl}/settings\n`;
  text += `Unsubscribe from all alerts: ${unsubUrl}\n`;
  return text;
}

/**
 * Send a daily digest email with multiple job notifications.
 *
 * @param {object} user - { id, email, display_name }
 * @param {Array} notifications - notification rows
 * @param {Array} jobs - job rows corresponding to notifications
 * @param {string} unsubscribeToken - 64-char hex unsubscribe token
 */
async function sendDigestEmail(user, notifications, jobs, unsubscribeToken) {
  if (!isEnabled()) return;
  if (!notifications || notifications.length === 0) return;

  const baseUrl = config.APP_BASE_URL;
  const unsubUrl = `${baseUrl}/alerts/unsubscribe/${unsubscribeToken}`;
  const capped = notifications.slice(0, 20);

  const mailOptions = {
    from: config.EMAIL_FROM || 'Job Hunter <noreply@jobhunter.local>',
    to: user.email,
    subject: `Daily digest: ${capped.length} new job matches`,
    html: buildDigestHtml(user, notifications, jobs, unsubscribeToken),
    text: buildDigestText(user, notifications, jobs, unsubscribeToken),
    headers: {
      'Precedence': 'bulk',
      'List-Unsubscribe': `<${unsubUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  };

  await transport.sendMail(mailOptions);
}

/**
 * Replace the transport instance (for testing).
 */
function _setTransport(t) {
  transport = t;
}

/**
 * Override the enabled flag (for testing).
 */
function _setEnabled(val) {
  enabled = val;
}

module.exports = {
  escapeHtml,
  verifyConnection,
  isEnabled,
  sendAlertEmail,
  sendDigestEmail,
  _setTransport,
  _setEnabled,
};
