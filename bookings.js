const express = require('express');
const { body, query, validationResult } = require('express-validator');
const supabase = require('../db/supabase');
const { authenticate, requireAdmin } = require('../middleware/auth');
const notificationService = require('../services/notifications');

const router = express.Router();
const PLATFORM_FEE = parseFloat(process.env.PLATFORM_FEE_PERCENT || 15) / 100;

// ── GET /api/bookings ── (customer's bookings)
router.get('/', authenticate, async (req, res) => {
  const { status, page = 1, limit = 20 } = req.query;
  const offset = (page - 1) * limit;

  let q = supabase
    .from('bookings')
    .select(`
      *, 
      services(name_en, name_es, icon_emoji),
      profiles!bookings_customer_id_fkey(full_name, avatar_url),
      providers!bookings_provider_id_fkey(profiles(full_name, avatar_url), avg_rating)
    `, { count: 'exact' })
    .eq('customer_id', req.user.id)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (status) q = q.eq('status', status);

  const { data, error, count } = await q;
  if (error) return res.status(400).json({ error: error.message });

  res.json({ bookings: data, total: count, page: parseInt(page), limit: parseInt(limit) });
});

// ── POST /api/bookings ── (create booking)
router.post('/', authenticate, [
  body('service_id').isUUID(),
  body('scheduled_date').isDate(),
  body('scheduled_time').matches(/^\d{2}:\d{2}$/),
  body('address_id').optional().isUUID(),
  body('address').optional().isObject(),
  body('notes').optional().isString().isLength({ max: 500 }),
  body('provider_id').optional().isUUID(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { service_id, scheduled_date, scheduled_time, address_id, address, notes, provider_id } = req.body;

  // Fetch service pricing
  const { data: service } = await supabase.from('services').select('*').eq('id', service_id).single();
  if (!service) return res.status(404).json({ error: 'Service not found' });

  // Fetch provider rate if specified
  let hourlyRate = service.base_price_eur;
  if (provider_id) {
    const { data: provider } = await supabase.from('providers').select('hourly_rate_eur').eq('id', provider_id).single();
    if (provider?.hourly_rate_eur) hourlyRate = provider.hourly_rate_eur;
  }

  const subtotal = hourlyRate;
  const platformFee = parseFloat((subtotal * PLATFORM_FEE).toFixed(2));
  const providerPayout = parseFloat((subtotal - platformFee).toFixed(2));

  // Address snapshot
  let addressSnapshot = null;
  if (address_id) {
    const { data: addr } = await supabase.from('addresses').select('*').eq('id', address_id).single();
    addressSnapshot = addr;
  } else if (address) {
    addressSnapshot = address;
  }

  const { data: booking, error } = await supabase
    .from('bookings')
    .insert({
      customer_id: req.user.id,
      provider_id: provider_id || null,
      service_id,
      address_id: address_id || null,
      address_snapshot: addressSnapshot,
      scheduled_date,
      scheduled_time,
      duration_mins: service.duration_mins,
      notes,
      subtotal_eur: subtotal,
      platform_fee_eur: platformFee,
      provider_payout_eur: providerPayout,
      total_eur: subtotal,
    })
    .select(`*, services(*)`)
    .single();

  if (error) return res.status(400).json({ error: error.message });

  // Notify provider if assigned
  if (provider_id) {
    await notificationService.send(provider_id, 'booking_new', {
      title_en: 'New Booking Request',
      title_es: 'Nueva Solicitud de Reserva',
      body_en: `You have a new ${service.name_en} booking for ${scheduled_date}`,
      body_es: `Tienes una nueva reserva de ${service.name_es} para ${scheduled_date}`,
      data: { booking_id: booking.id, booking_ref: booking.ref },
    });
  }

  res.status(201).json(booking);
});

// ── GET /api/bookings/:id ──
router.get('/:id', authenticate, async (req, res) => {
  const { data: booking, error } = await supabase
    .from('bookings')
    .select(`
      *,
      services(*),
      profiles!bookings_customer_id_fkey(full_name, avatar_url, phone, email),
      providers!bookings_provider_id_fkey(
        id,
        hourly_rate_eur,
        avg_rating,
        total_jobs,
        profiles(full_name, avatar_url, phone)
      ),
      reviews(*)
    `)
    .eq('id', req.params.id)
    .single();

  if (error || !booking) return res.status(404).json({ error: 'Booking not found' });

  // Ensure user is customer or assigned provider
  const isCustomer = booking.customer_id === req.user.id;
  const isProvider = booking.provider_id === req.user.id;
  const isAdmin = req.user.profile?.role === 'admin';

  if (!isCustomer && !isProvider && !isAdmin) {
    return res.status(403).json({ error: 'Not authorized' });
  }

  res.json(booking);
});

// ── PATCH /api/bookings/:id/status ── (status machine)
router.patch('/:id/status', authenticate, [
  body('status').isIn(['confirmed', 'in_progress', 'completed', 'cancelled']),
  body('cancel_reason').optional().isString(),
], async (req, res) => {
  const { status, cancel_reason } = req.body;
  const { data: booking } = await supabase.from('bookings').select('*, services(name_en, name_es)').eq('id', req.params.id).single();

  if (!booking) return res.status(404).json({ error: 'Booking not found' });

  const isCustomer = booking.customer_id === req.user.id;
  const isProvider = booking.provider_id === req.user.id;
  const isAdmin = req.user.profile?.role === 'admin';

  // State machine validation
  const transitions = {
    pending: ['confirmed', 'cancelled'],
    confirmed: ['in_progress', 'cancelled'],
    in_progress: ['completed'],
    completed: [],
    cancelled: [],
  };

  if (!transitions[booking.status]?.includes(status)) {
    return res.status(400).json({ error: `Cannot transition from ${booking.status} to ${status}` });
  }

  // Role-based transition guards
  if (status === 'confirmed' && !isProvider && !isAdmin)
    return res.status(403).json({ error: 'Only the assigned provider can confirm' });
  if (status === 'in_progress' && !isProvider && !isAdmin)
    return res.status(403).json({ error: 'Only the provider can start the job' });
  if (status === 'completed' && !isProvider && !isAdmin)
    return res.status(403).json({ error: 'Only the provider can complete the job' });

  const updates = {
    status,
    ...(status === 'confirmed' && { confirmed_at: new Date().toISOString() }),
    ...(status === 'in_progress' && { started_at: new Date().toISOString() }),
    ...(status === 'completed' && { completed_at: new Date().toISOString() }),
    ...(status === 'cancelled' && { cancelled_at: new Date().toISOString(), cancel_reason }),
  };

  const { data: updated, error } = await supabase
    .from('bookings')
    .update(updates)
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });

  // Notifications
  const notifyMap = {
    confirmed: {
      userId: booking.customer_id,
      type: 'booking_confirmed',
      title_en: 'Booking Confirmed! ✓',
      title_es: '¡Reserva Confirmada! ✓',
      body_en: `Your ${booking.services.name_en} on ${booking.scheduled_date} has been confirmed.`,
      body_es: `Tu reserva de ${booking.services.name_es} el ${booking.scheduled_date} ha sido confirmada.`,
    },
    cancelled: {
      userId: isCustomer ? booking.provider_id : booking.customer_id,
      type: 'booking_cancelled',
      title_en: 'Booking Cancelled',
      title_es: 'Reserva Cancelada',
      body_en: `Booking ${booking.ref} has been cancelled.`,
      body_es: `La reserva ${booking.ref} ha sido cancelada.`,
    },
    completed: {
      userId: booking.customer_id,
      type: 'booking_completed',
      title_en: 'Service Completed ✓',
      title_es: 'Servicio Completado ✓',
      body_en: `How was your ${booking.services.name_en}? Leave a review!`,
      body_es: `¿Qué te pareció el servicio? ¡Deja una reseña!`,
    },
  };

  if (notifyMap[status]) {
    const n = notifyMap[status];
    await notificationService.send(n.userId, n.type, {
      title_en: n.title_en, title_es: n.title_es,
      body_en: n.body_en, body_es: n.body_es,
      data: { booking_id: booking.id, booking_ref: booking.ref },
    });
  }

  res.json(updated);
});

// ── DELETE /api/bookings/:id ── (cancel by customer, within 24h)
router.delete('/:id', authenticate, async (req, res) => {
  const { data: booking } = await supabase.from('bookings').select('*').eq('id', req.params.id).eq('customer_id', req.user.id).single();

  if (!booking) return res.status(404).json({ error: 'Booking not found or not yours' });
  if (!['pending', 'confirmed'].includes(booking.status))
    return res.status(400).json({ error: 'Cannot cancel a booking that is in progress or completed' });

  await supabase.from('bookings').update({ status: 'cancelled', cancelled_at: new Date().toISOString(), cancel_reason: 'Cancelled by customer' }).eq('id', req.params.id);

  res.json({ message: 'Booking cancelled successfully' });
});

module.exports = router;
