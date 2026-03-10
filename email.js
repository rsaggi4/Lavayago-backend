const nodemailer = require('nodemailer');
const logger = require('../utils/logger');

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT || 587),
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

const BRAND = {
  color: '#C4704A',
  logo: '✦ LaVayaGo',
  site: 'https://lavayago.com',
};

function baseTemplate(content) {
  return `
<!DOCTYPE html><html><body style="margin:0;padding:0;background:#F7F3ED;font-family:'Helvetica Neue',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:40px 20px;">
<table width="580" cellpadding="0" cellspacing="0" style="background:#FFFFFF;border-radius:12px;overflow:hidden;border:1px solid #EAE0CC;">
  <tr><td style="background:linear-gradient(135deg,#C4704A,#A35A38);padding:32px 40px;text-align:center;">
    <div style="font-family:'Georgia',serif;font-size:28px;font-weight:400;color:#FFFFFF;letter-spacing:0.05em;">${BRAND.logo}</div>
    <div style="font-size:11px;color:rgba(255,255,255,0.7);letter-spacing:0.2em;text-transform:uppercase;margin-top:4px;">LUXURY HOME SERVICES · COSTA BLANCA</div>
  </td></tr>
  <tr><td style="padding:40px;">${content}</td></tr>
  <tr><td style="background:#F7F3ED;padding:24px 40px;text-align:center;border-top:1px solid #EAE0CC;">
    <p style="font-size:12px;color:#9B9490;margin:0;">© ${new Date().getFullYear()} LaVayaGo · <a href="${BRAND.site}" style="color:#C4704A;text-decoration:none;">lavayago.com</a></p>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}

async function send({ to, subject, html }) {
  try {
    await transporter.sendMail({
      from: `"${process.env.EMAIL_FROM_NAME}" <${process.env.EMAIL_FROM}>`,
      to, subject, html,
    });
  } catch (err) {
    logger.error('Email send error:', err.message);
  }
}

// Welcome email
async function sendWelcome({ email, full_name, lang = 'en' }) {
  const content = lang === 'es'
    ? `<h2 style="font-family:Georgia,serif;font-size:28px;font-weight:400;color:#2C2A26;margin:0 0 16px;">Bienvenido a LaVayaGo, ${full_name} 👋</h2>
       <p style="color:#6B6560;line-height:1.7;margin:0 0 24px;">Gracias por unirte a LaVayaGo, el marketplace de servicios del hogar premium de la Costa Blanca. Ahora puedes reservar servicios de lavandería, limpieza, piscina y tintorería con profesionales verificados.</p>
       <a href="${BRAND.site}" style="display:inline-block;background:#C4704A;color:#FFFFFF;padding:14px 32px;border-radius:4px;text-decoration:none;font-size:13px;letter-spacing:0.1em;text-transform:uppercase;">Explorar Servicios →</a>`
    : `<h2 style="font-family:Georgia,serif;font-size:28px;font-weight:400;color:#2C2A26;margin:0 0 16px;">Welcome to LaVayaGo, ${full_name} 👋</h2>
       <p style="color:#6B6560;line-height:1.7;margin:0 0 24px;">Thank you for joining LaVayaGo — the premium home services marketplace of the Costa Blanca. You can now book laundry, cleaning, pool & garden, and dry cleaning from verified local professionals.</p>
       <a href="${BRAND.site}" style="display:inline-block;background:#C4704A;color:#FFFFFF;padding:14px 32px;border-radius:4px;text-decoration:none;font-size:13px;letter-spacing:0.1em;text-transform:uppercase;">Explore Services →</a>`;

  await send({ to: email, subject: lang === 'es' ? 'Bienvenido a LaVayaGo ✦' : 'Welcome to LaVayaGo ✦', html: baseTemplate(content) });
}

// Booking confirmation email
async function sendBookingConfirmation({ email, full_name, booking, lang = 'en' }) {
  const dateStr = new Date(booking.scheduled_date).toLocaleDateString(lang === 'es' ? 'es-ES' : 'en-GB', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  const content = lang === 'es'
    ? `<h2 style="font-family:Georgia,serif;font-size:26px;font-weight:400;color:#2C2A26;margin:0 0 8px;">¡Reserva Confirmada! ✓</h2>
       <p style="color:#6B6560;margin:0 0 24px;">Hola ${full_name}, tu reserva ha sido confirmada y el pago procesado.</p>
       <div style="background:#F7F3ED;border-radius:8px;padding:24px;margin:0 0 24px;border-left:3px solid #C4704A;">
         <p style="margin:0 0 8px;"><strong>Ref:</strong> ${booking.ref}</p>
         <p style="margin:0 0 8px;"><strong>Servicio:</strong> ${booking.service_name_es}</p>
         <p style="margin:0 0 8px;"><strong>Fecha:</strong> ${dateStr} a las ${booking.scheduled_time}</p>
         <p style="margin:0;"><strong>Total:</strong> €${booking.total_eur}</p>
       </div>`
    : `<h2 style="font-family:Georgia,serif;font-size:26px;font-weight:400;color:#2C2A26;margin:0 0 8px;">Booking Confirmed! ✓</h2>
       <p style="color:#6B6560;margin:0 0 24px;">Hi ${full_name}, your booking is confirmed and payment has been processed.</p>
       <div style="background:#F7F3ED;border-radius:8px;padding:24px;margin:0 0 24px;border-left:3px solid #C4704A;">
         <p style="margin:0 0 8px;"><strong>Ref:</strong> ${booking.ref}</p>
         <p style="margin:0 0 8px;"><strong>Service:</strong> ${booking.service_name_en}</p>
         <p style="margin:0 0 8px;"><strong>Date:</strong> ${dateStr} at ${booking.scheduled_time}</p>
         <p style="margin:0;"><strong>Total:</strong> €${booking.total_eur}</p>
       </div>`;

  await send({ to: email, subject: `LaVayaGo — ${lang === 'es' ? 'Reserva' : 'Booking'} ${booking.ref} ✓`, html: baseTemplate(content) });
}

module.exports = { sendWelcome, sendBookingConfirmation, send };
