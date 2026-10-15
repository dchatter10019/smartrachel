// email-utils.js
// Shared Gmail-sending utility, extracted from server.js so any service in this
// codebase (server.js, rachel-mcp.js, etc.) can send email without duplicating
// the Gmail API / service-account integration.

const { google } = require('googleapis');

const GMAIL_SERVICE_ACCOUNT_FILE = '/home/ubuntu/config/gmail-service-account.json';
const RACHEL_SENDER_EMAIL = 'rachelai@getbevvi.com';
const SUPPORT_EMAIL = 'bevvi-support@getbevvi.com';

async function sendEmail(toList, subject, bodyText) {
  // Staging (QA_MODE=1) never sends: logged instead (ops/staging.sh).
  if (process.env.QA_MODE === '1') { console.log('[staging] QA_MODE — email NOT sent: to ' + JSON.stringify(toList) + ' | ' + subject); return; }
  const auth = new google.auth.GoogleAuth({
    keyFile: GMAIL_SERVICE_ACCOUNT_FILE,
    scopes: ['https://www.googleapis.com/auth/gmail.send'],
    clientOptions: { subject: RACHEL_SENDER_EMAIL }
  });
  const authClient = await auth.getClient();
  const gmail = google.gmail({ version: 'v1', auth: authClient });

  const toHeader = Array.isArray(toList) ? toList.join(', ') : toList;
  const encodedSubject = /[^\x00-\x7F]/.test(subject)
    ? '=?UTF-8?B?' + Buffer.from(subject, 'utf8').toString('base64') + '?='
    : subject;
  const messageParts = [
    `From: ${RACHEL_SENDER_EMAIL}`,
    `To: ${toHeader}`,
    `Subject: ${encodedSubject}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    bodyText
  ];
  const raw = Buffer.from(messageParts.join('\n'))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
}

// A plain-text email with ONE file attached (the connector's rachel_generate_proposal send_to, Oct 15).
// to / cc / bcc: arrays of addresses. attachment: { filename, path, contentType }.
async function sendEmailWithAttachment({ to, cc = [], bcc = [], subject, body, attachment }) {
  if (process.env.QA_MODE === '1') { console.log('[staging] QA_MODE — email NOT sent: to ' + JSON.stringify(to) + ' | ' + subject); return; }
  const fs = require('fs');
  const auth = new google.auth.GoogleAuth({
    keyFile: GMAIL_SERVICE_ACCOUNT_FILE,
    scopes: ['https://www.googleapis.com/auth/gmail.send'],
    clientOptions: { subject: RACHEL_SENDER_EMAIL }
  });
  const gmail = google.gmail({ version: 'v1', auth: await auth.getClient() });
  const enc = s => /[^\x00-\x7F]/.test(s) ? '=?UTF-8?B?' + Buffer.from(s, 'utf8').toString('base64') + '?=' : s;
  const boundary = 'bevvi-' + require('crypto').randomBytes(12).toString('hex');
  const fname = String(attachment.filename).replace(/"/g, '');
  const lines = [
    `From: Rachel at Bevvi <${RACHEL_SENDER_EMAIL}>`,
    `To: ${to.join(', ')}`,
    ...(cc.length ? [`Cc: ${cc.join(', ')}`] : []),
    ...(bcc.length ? [`Bcc: ${bcc.join(', ')}`] : []),
    `Subject: ${enc(subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(body, 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n'),
    `--${boundary}`,
    `Content-Type: ${attachment.contentType || 'application/pdf'}; name="${fname}"`,
    `Content-Disposition: attachment; filename="${fname}"`,
    'Content-Transfer-Encoding: base64',
    '',
    fs.readFileSync(attachment.path).toString('base64').replace(/.{76}/g, '$&\r\n'),
    `--${boundary}--`
  ];
  const raw = Buffer.from(lines.join('\r\n')).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const r = await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
  return r.data && r.data.id;
}

async function sendSupportEmail(subject, bodyText) {
  return sendEmail([SUPPORT_EMAIL], subject, bodyText);
}

module.exports = { sendEmail, sendEmailWithAttachment, sendSupportEmail, RACHEL_SENDER_EMAIL, SUPPORT_EMAIL };
