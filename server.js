require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { google } = require('googleapis');
const nodemailer = require('nodemailer');

const app = express();
app.set('trust proxy', 1); // correct client IPs behind Render/Railway/Heroku
app.use(express.json({ limit: '20kb' }));

// CORS: only needed if the front-end lives on a different domain
const allowed = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
if (allowed.length) app.use(cors({ origin: allowed }));

// Serve the front-end from /public
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Google Sheets auth ----------
const auth = new google.auth.GoogleAuth({
  ...(process.env.GOOGLE_CREDENTIALS_JSON
    ? { credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON) }
    : { keyFile: path.join(__dirname, 'credentials.json') }),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_RANGE = process.env.SHEET_RANGE || 'Sheet1!A:I';

// ---------- Validation ----------
const ISSUES = ['Damp', 'Mould', 'Leak', 'Heating issue', 'Guttering issue', 'Infestation issue', 'Door and window issue'];
const LANDLORDS = ['Housing Association', 'Council'];
const POSTCODE_RE = /^[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}$/i;
const PHONE_RE = /^(?:\+44|0044|0)\d{9,10}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const clean = (v, max = 200) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function validate(body = {}) {
  const errors = [];
  const name = clean(body.name, 100);
  const phone = clean(body.phone, 20).replace(/[\s()-]/g, '');
  const email = clean(body.email, 150).toLowerCase();
  const postcode = clean(body.postcode, 10).toUpperCase();
  const landlord = clean(body.landlord, 30);
  const facingIssues = clean(body.facingIssues, 3);
  const issues = (Array.isArray(body.issues) ? body.issues : []).map(i => clean(i, 40)).filter(i => ISSUES.includes(i));

  if (name.length < 2) errors.push('Enter your full name.');
  if (!PHONE_RE.test(phone)) errors.push('Enter a valid UK phone number.');
  if (!EMAIL_RE.test(email)) errors.push('Enter a valid email address.');
  if (!POSTCODE_RE.test(postcode)) errors.push('Enter a valid UK postcode.');
  if (!LANDLORDS.includes(landlord)) errors.push('Choose your landlord type.');
  if (facingIssues !== 'Yes') errors.push('Please confirm you are facing issues.');
  if (!issues.length) errors.push('Select at least one issue.');
  if (body.consent !== true) errors.push('Please agree to be contacted.');

  return { errors, data: { name, phone, email, postcode, landlord, facingIssues, issues } };
}

// ---------- Email ----------
async function sendAdminEmail(d, timestamp) {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS || !process.env.ADMIN_EMAIL) return;
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
  });
  const rows = [
    ['Name', d.name], ['Phone', d.phone], ['Email', d.email], ['Postcode', d.postcode],
    ['Landlord', d.landlord], ['Issues', d.issues.join(', ')], ['Received', timestamp],
  ].map(([k, v]) => `<tr><td style="padding:8px 12px;color:#5b6b78;border-bottom:1px solid #e6eaed">${k}</td><td style="padding:8px 12px;font-weight:600;border-bottom:1px solid #e6eaed">${esc(v)}</td></tr>`).join('');

  await transporter.sendMail({
    from: `"Tenants Aid Website" <${process.env.EMAIL_USER}>`,
    to: process.env.ADMIN_EMAIL,
    replyTo: d.email,
    subject: `New enquiry: ${d.name} (${d.postcode})`,
    text: `Name: ${d.name}\nPhone: ${d.phone}\nEmail: ${d.email}\nPostcode: ${d.postcode}\nLandlord: ${d.landlord}\nIssues: ${d.issues.join(', ')}\nReceived: ${timestamp}`,
    html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;border:1px solid #e6eaed;border-radius:8px;overflow:hidden">
      <div style="background:#1f2e3d;color:#fff;padding:16px 20px;font-size:18px">New housing disrepair enquiry</div>
      <table style="width:100%;border-collapse:collapse;font-size:15px">${rows}</table>
      <div style="padding:14px 20px;background:#f3f4f2;font-size:13px;color:#5b6b78">Call or message the tenant promptly. Details also saved to Google Sheets.</div></div>`,
  });
}

// ---------- Route ----------
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many submissions. Please try again later.' },
});

app.post('/api/enquiries', limiter, async (req, res) => {
  try {
    // Honeypot: bots fill hidden fields. Pretend success, save nothing.
    if (req.body && req.body.website) {
      return res.status(200).json({ success: true, message: 'Enquiry submitted successfully' });
    }

    const { errors, data } = validate(req.body);
    if (errors.length) return res.status(400).json({ success: false, message: errors[0], errors });

    const timestamp = new Date().toLocaleString('en-GB', { timeZone: 'Europe/London' });

    // RAW keeps phone numbers' leading zero and stops spreadsheet formula injection
    const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: SHEET_RANGE,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: [[timestamp, data.name, data.phone, data.email, data.postcode,
                  data.facingIssues, data.issues.join(', '), data.landlord, 'New']],
      },
    });

    // Email failure should not lose the lead: it is already in the sheet
    sendAdminEmail(data, timestamp).catch(err => console.error('Email error:', err.message));

    return res.status(200).json({ success: true, message: 'Enquiry submitted successfully' });
  } catch (err) {
    console.error('Enquiry error:', err);
    return res.status(500).json({ success: false, message: 'Something went wrong. Please call or WhatsApp us instead.' });
  }
});

app.get('/health', (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Tenants Aid running on http://localhost:${PORT}`));
