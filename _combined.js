// services.js
const express = require('express');
const supabase = require('../db/supabase');
const { authenticate, requireAdmin } = require('../middleware/auth');

const servicesRouter = express.Router();

servicesRouter.get('/', async (req, res) => {
  const { data } = await supabase.from('services').select('*').eq('is_active', true).order('base_price_eur');
  res.json(data);
});

servicesRouter.patch('/:id', authenticate, requireAdmin, async (req, res) => {
  const { data, error } = await supabase.from('services').update(req.body).eq('id', req.params.id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// reviews.js
const reviewsRouter = express.Router();

reviewsRouter.post('/', authenticate, async (req, res) => {
  const { booking_id, rating, comment } = req.body;
  if (!booking_id || !rating) return res.status(400).json({ error: 'booking_id and rating required' });

  const { data: booking } = await supabase.from('bookings').select('*').eq('id', booking_id).eq('customer_id', req.user.id).single();
  if (!booking) return res.status(404).json({ error: 'Booking not found or not yours' });
  if (booking.status !== 'completed') return res.status(400).json({ error: 'Can only review completed bookings' });

  const { data, error } = await supabase.from('reviews').insert({
    booking_id,
    customer_id: req.user.id,
    provider_id: booking.provider_id,
    rating,
    comment,
  }).select().single();

  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

reviewsRouter.get('/provider/:providerId', async (req, res) => {
  const { data } = await supabase
    .from('reviews')
    .select('*, profiles!reviews_customer_id_fkey(full_name, avatar_url)')
    .eq('provider_id', req.params.providerId)
    .order('created_at', { ascending: false });
  res.json(data);
});

// messages.js
const messagesRouter = express.Router();

messagesRouter.get('/:bookingId', authenticate, async (req, res) => {
  const { data } = await supabase
    .from('messages')
    .select('*, profiles!messages_sender_id_fkey(full_name, avatar_url)')
    .eq('booking_id', req.params.bookingId)
    .order('created_at');
  res.json(data);
});

messagesRouter.post('/:bookingId', authenticate, async (req, res) => {
  const { body } = req.body;
  const { data, error } = await supabase.from('messages').insert({
    booking_id: req.params.bookingId,
    sender_id: req.user.id,
    body,
  }).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

// admin.js
const adminRouter = express.Router();

adminRouter.use(authenticate, requireAdmin);

adminRouter.get('/stats', async (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const monthStart = today.slice(0, 7) + '-01';

  const [{ count: totalBookings }, { count: todayBookings }, { data: revenueData }, { count: totalProviders }, { count: pendingProviders }] = await Promise.all([
    supabase.from('bookings').select('*', { count: 'exact', head: true }),
    supabase.from('bookings').select('*', { count: 'exact', head: true }).gte('created_at', today),
    supabase.from('bookings').select('total_eur').eq('payment_status', 'paid').gte('created_at', monthStart),
    supabase.from('providers').select('*', { count: 'exact', head: true }).eq('status', 'active'),
    supabase.from('providers').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
  ]);

  const monthRevenue = revenueData?.reduce((sum, b) => sum + parseFloat(b.total_eur), 0) || 0;
  const platformRevenue = monthRevenue * (parseFloat(process.env.PLATFORM_FEE_PERCENT || 15) / 100);

  res.json({
    total_bookings: totalBookings,
    today_bookings: todayBookings,
    month_revenue_eur: monthRevenue.toFixed(2),
    platform_revenue_eur: platformRevenue.toFixed(2),
    active_providers: totalProviders,
    pending_providers: pendingProviders,
  });
});

adminRouter.get('/bookings', async (req, res) => {
  const { status, page = 1, limit = 50 } = req.query;
  const offset = (page - 1) * limit;

  let q = supabase
    .from('bookings')
    .select(`*, services(name_en, icon_emoji), profiles!bookings_customer_id_fkey(full_name, email), providers!bookings_provider_id_fkey(profiles(full_name))`, { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (status) q = q.eq('status', status);
  const { data, error, count } = await q;
  if (error) return res.status(400).json({ error: error.message });
  res.json({ bookings: data, total: count });
});

adminRouter.patch('/providers/:id/status', async (req, res) => {
  const { status } = req.body;
  const { data, error } = await supabase.from('providers').update({ status }).eq('id', req.params.id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

adminRouter.get('/providers', async (req, res) => {
  const { data } = await supabase
    .from('providers')
    .select('*, profiles(full_name, email, phone, avatar_url)')
    .order('created_at', { ascending: false });
  res.json(data);
});

// notifications.js
const notificationsRouter = express.Router();
notificationsRouter.use(authenticate);

notificationsRouter.get('/', async (req, res) => {
  const { data } = await supabase
    .from('notifications')
    .select('*')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false })
    .limit(50);
  res.json(data);
});

notificationsRouter.patch('/read-all', async (req, res) => {
  await supabase.from('notifications').update({ read: true }).eq('user_id', req.user.id);
  res.json({ message: 'All notifications marked as read' });
});

notificationsRouter.patch('/:id/read', async (req, res) => {
  await supabase.from('notifications').update({ read: true }).eq('id', req.params.id).eq('user_id', req.user.id);
  res.json({ message: 'Notification marked as read' });
});

// users.js
const usersRouter = express.Router();
usersRouter.use(authenticate);

usersRouter.get('/addresses', async (req, res) => {
  const { data } = await supabase.from('addresses').select('*').eq('user_id', req.user.id).order('is_default', { ascending: false });
  res.json(data);
});

usersRouter.post('/addresses', async (req, res) => {
  const { label, line1, line2, city, postcode, lat, lng, is_default } = req.body;
  if (is_default) await supabase.from('addresses').update({ is_default: false }).eq('user_id', req.user.id);
  const { data, error } = await supabase.from('addresses').insert({ user_id: req.user.id, label, line1, line2, city, postcode, lat, lng, is_default }).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

usersRouter.delete('/addresses/:id', async (req, res) => {
  await supabase.from('addresses').delete().eq('id', req.params.id).eq('user_id', req.user.id);
  res.json({ message: 'Address deleted' });
});

module.exports = { servicesRouter, reviewsRouter, messagesRouter, adminRouter, notificationsRouter, usersRouter };
