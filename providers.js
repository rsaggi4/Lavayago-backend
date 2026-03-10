// ═══════════════════════════════════════════════════════
//  providers.js
// ═══════════════════════════════════════════════════════
const express = require('express');
const supabase = require('../db/supabase');
const { authenticate, requireAdmin } = require('../middleware/auth');
const router = express.Router();

// GET /api/providers — list active providers
router.get('/', async (req, res) => {
  const { service, area, page = 1, limit = 20 } = req.query;
  const offset = (page - 1) * limit;

  let q = supabase
    .from('providers')
    .select(`
      *, 
      profiles(full_name, avatar_url, phone),
      reviews(rating)
    `, { count: 'exact' })
    .eq('status', 'active')
    .order('avg_rating', { ascending: false })
    .range(offset, offset + limit - 1);

  if (service) q = q.contains('services', [service]);
  if (area) q = q.contains('coverage_areas', [area]);

  const { data, error, count } = await q;
  if (error) return res.status(400).json({ error: error.message });
  res.json({ providers: data, total: count });
});

// GET /api/providers/:id
router.get('/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('providers')
    .select(`*, profiles(full_name, avatar_url, phone, email), reviews(*, profiles!reviews_customer_id_fkey(full_name, avatar_url))`)
    .eq('id', req.params.id)
    .single();
  if (error || !data) return res.status(404).json({ error: 'Provider not found' });
  res.json(data);
});

// PATCH /api/providers/me — provider updates own profile
router.patch('/me', authenticate, async (req, res) => {
  const { bio_en, bio_es, services, coverage_areas, hourly_rate_eur } = req.body;
  const { data, error } = await supabase
    .from('providers')
    .update({ bio_en, bio_es, services, coverage_areas, hourly_rate_eur })
    .eq('id', req.user.id)
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// GET /api/providers/:id/availability
router.get('/:id/availability', async (req, res) => {
  const { date } = req.query;
  const { data: slots } = await supabase.from('provider_availability').select('*').eq('provider_id', req.params.id).eq('is_active', true);
  const { data: blocked } = await supabase.from('provider_blocked_dates').select('*').eq('provider_id', req.params.id);
  const { data: bookings } = await supabase.from('bookings').select('scheduled_time, duration_mins').eq('provider_id', req.params.id).eq('scheduled_date', date).neq('status', 'cancelled');
  res.json({ available_slots: slots, blocked_dates: blocked, booked_times: bookings });
});

module.exports = router;
