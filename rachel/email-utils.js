// email-utils.js
// Shared Gmail-sending utility, extracted from server.js so any service in this
// codebase (server.js, rachel-mcp.js, etc.) can send email without duplicating
// the Gmail API / service-account integration.

const { google } = require('googleapis');

const GMAIL_SERVICE_ACCOUNT_FILE = '/home/ubuntu/config/gmail-service-account.json';
const RACHEL_SENDER_EMAIL = 'rachelai@getbevvi.com';
const SUPPORT_EMAIL = 'bevvi-support@getbevvi.com';

async function sendEmail(toList, subject, bodyText) {
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

async function sendSupportEmail(subject, bodyText) {
  return sendEmail([SUPPORT_EMAIL], subject, bodyText);
}

module.exports = { sendEmail, sendSupportEmail, RACHEL_SENDER_EMAIL, SUPPORT_EMAIL };
