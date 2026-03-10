const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const supabase = require('../db/supabase');
const { authenticate } = require('../middleware/auth');
const notificationService = require('../services/notifications');

const router = express.Router();

// ═══════════════════════════════════
//  STRIPE
// ═══════════════════════════════════

// ── POST /api/payments/stripe/intent ──
router.post('/stripe/intent', authenticate, async (req, res) => {
  const { booking_id } = req.body;

  const { data: booking } = await supabase
    .from('bookings')
    .select('*, profiles!bookings_customer_id_fkey(email, stripe_customer_id)')
    .eq('id', booking_id)
    .eq('customer_id', req.user.id)
    .single();

  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  if (booking.payment_status === 'paid') return res.status(400).json({ error: 'Already paid' });

  // Get or create Stripe customer
  let stripeCustomerId = booking.profiles?.stripe_customer_id;
  if (!stripeCustomerId) {
    const customer = await stripe.customers.create({
      email: booking.profiles.email,
      metadata: { supabase_user_id: req.user.id },
    });
    stripeCustomerId = customer.id;
    await supabase.from('profiles').update({ stripe_customer_id: stripeCustomerId }).eq('id', req.user.id);
  }

  const paymentIntent = await stripe.paymentIntents.create({
    amount: Math.round(booking.total_eur * 100), // cents
    currency: 'eur',
    customer: stripeCustomerId,
    metadata: {
      booking_id: booking.id,
      booking_ref: booking.ref,
      customer_id: req.user.id,
    },
    description: `LaVayaGo Booking ${booking.ref}`,
    receipt_email: booking.profiles.email,
  });

  // Save intent ID to booking
  await supabase.from('bookings').update({
    stripe_payment_intent: paymentIntent.id,
    payment_method: 'stripe',
  }).eq('id', booking_id);

  res.json({
    client_secret: paymentIntent.client_secret,
    payment_intent_id: paymentIntent.id,
    amount: booking.total_eur,
    currency: 'EUR',
  });
});

// ── POST /api/payments/webhook/stripe ── (raw body required)
router.post('/webhook/stripe', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  switch (event.type) {
    case 'payment_intent.succeeded': {
      const pi = event.data.object;
      const bookingId = pi.metadata.booking_id;

      await supabase.from('bookings').update({
        payment_status: 'paid',
        status: 'confirmed',
        confirmed_at: new Date().toISOString(),
      }).eq('id', bookingId);

      // Notify customer
      const { data: booking } = await supabase.from('bookings').select('customer_id, provider_id, ref').eq('id', bookingId).single();
      if (booking) {
        await notificationService.send(booking.customer_id, 'booking_confirmed', {
          title_en: 'Payment Successful ✓',
          title_es: 'Pago Exitoso ✓',
          body_en: `Booking ${booking.ref} is confirmed and paid.`,
          body_es: `La reserva ${booking.ref} está confirmada y pagada.`,
          data: { booking_id: bookingId },
        });
      }
      break;
    }

    case 'payment_intent.payment_failed': {
      const pi = event.data.object;
      await supabase.from('bookings').update({ payment_status: 'failed' }).eq('stripe_payment_intent', pi.id);
      break;
    }

    case 'charge.dispute.created': {
      const dispute = event.data.object;
      // Flag booking as disputed
      await supabase.from('bookings').update({ status: 'disputed' }).eq('stripe_payment_intent', dispute.payment_intent);
      break;
    }
  }

  res.json({ received: true });
});

// ── POST /api/payments/stripe/refund ──
router.post('/stripe/refund', authenticate, async (req, res) => {
  const { booking_id, reason } = req.body;

  const { data: booking } = await supabase
    .from('bookings')
    .select('*')
    .eq('id', booking_id)
    .eq('customer_id', req.user.id)
    .single();

  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  if (!booking.stripe_payment_intent) return res.status(400).json({ error: 'No Stripe payment found' });

  const refund = await stripe.refunds.create({
    payment_intent: booking.stripe_payment_intent,
    reason: 'requested_by_customer',
    metadata: { booking_id, reason },
  });

  await supabase.from('bookings').update({ payment_status: 'refunded', status: 'cancelled' }).eq('id', booking_id);

  res.json({ refund_id: refund.id, status: refund.status, amount: refund.amount / 100 });
});

// ═══════════════════════════════════
//  PAYPAL
// ═══════════════════════════════════

const PAYPAL_BASE = process.env.PAYPAL_MODE === 'live'
  ? 'https://api-m.paypal.com'
  : 'https://api-m.sandbox.paypal.com';

async function getPayPalToken() {
  const res = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64')}`,
    },
    body: 'grant_type=client_credentials',
  });
  const data = await res.json();
  return data.access_token;
}

// ── POST /api/payments/paypal/order ──
router.post('/paypal/order', authenticate, async (req, res) => {
  const { booking_id } = req.body;

  const { data: booking } = await supabase
    .from('bookings')
    .select('*, services(name_en)')
    .eq('id', booking_id)
    .eq('customer_id', req.user.id)
    .single();

  if (!booking) return res.status(404).json({ error: 'Booking not found' });

  const token = await getPayPalToken();

  const order = await fetch(`${PAYPAL_BASE}/v2/checkout/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [{
        amount: { currency_code: 'EUR', value: booking.total_eur.toFixed(2) },
        description: `LaVayaGo ${booking.services.name_en} - ${booking.ref}`,
        custom_id: booking.id,
        soft_descriptor: 'LaVayaGo',
      }],
      application_context: {
        brand_name: 'LaVayaGo',
        return_url: `lavayago://payment/success?booking_id=${booking_id}`,
        cancel_url: `lavayago://payment/cancel?booking_id=${booking_id}`,
      },
    }),
  }).then(r => r.json());

  // Save PayPal order ID
  await supabase.from('bookings').update({
    paypal_order_id: order.id,
    payment_method: 'paypal',
  }).eq('id', booking_id);

  res.json({ order_id: order.id, approve_url: order.links?.find(l => l.rel === 'approve')?.href });
});

// ── POST /api/payments/paypal/capture ──
router.post('/paypal/capture', authenticate, async (req, res) => {
  const { order_id, booking_id } = req.body;
  const token = await getPayPalToken();

  const capture = await fetch(`${PAYPAL_BASE}/v2/checkout/orders/${order_id}/capture`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  }).then(r => r.json());

  if (capture.status === 'COMPLETED') {
    await supabase.from('bookings').update({
      payment_status: 'paid',
      status: 'confirmed',
      confirmed_at: new Date().toISOString(),
    }).eq('id', booking_id);

    const { data: booking } = await supabase.from('bookings').select('customer_id, ref').eq('id', booking_id).single();
    await notificationService.send(booking.customer_id, 'booking_confirmed', {
      title_en: 'Payment Successful ✓',
      title_es: 'Pago Exitoso ✓',
      body_en: `Booking ${booking.ref} is confirmed and paid.`,
      body_es: `La reserva ${booking.ref} está confirmada y pagada.`,
      data: { booking_id },
    });

    res.json({ status: 'paid', capture_id: capture.purchase_units?.[0]?.payments?.captures?.[0]?.id });
  } else {
    res.status(400).json({ error: 'Payment not completed', status: capture.status });
  }
});

module.exports = router;
