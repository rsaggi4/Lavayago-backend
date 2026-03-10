const express = require('express');
const { body, validationResult } = require('express-validator');
const supabase = require('../db/supabase');
const { authenticate } = require('../middleware/auth');
const emailService = require('../services/email');

const router = express.Router();

// ── POST /api/auth/register ──
router.post('/register', [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
  body('full_name').trim().isLength({ min: 2 }),
  body('role').optional().isIn(['customer', 'provider']),
  body('preferred_lang').optional().isIn(['en', 'es']),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { email, password, full_name, role = 'customer', preferred_lang = 'en', phone } = req.body;

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: { full_name, role, preferred_lang, phone },
      emailRedirectTo: `${process.env.API_URL}/auth/confirm`,
    },
  });

  if (error) return res.status(400).json({ error: error.message });

  // Update profile with extra fields
  if (data.user) {
    await supabase.from('profiles').update({ phone, preferred_lang }).eq('id', data.user.id);
    // If provider, create provider record
    if (role === 'provider') {
      await supabase.from('providers').insert({ id: data.user.id, services: [], coverage_areas: [] });
    }
    // Welcome email
    await emailService.sendWelcome({ email, full_name, lang: preferred_lang });
  }

  res.status(201).json({
    message: 'Registration successful. Please verify your email.',
    user: { id: data.user?.id, email, full_name, role },
  });
});

// ── POST /api/auth/login ──
router.post('/login', [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { email, password } = req.body;
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) return res.status(401).json({ error: 'Invalid email or password' });

  const { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', data.user.id)
    .single();

  res.json({
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
    expires_at: data.session.expires_at,
    user: profile,
  });
});

// ── POST /api/auth/google ── (Google OAuth token from Flutter)
router.post('/google', [
  body('id_token').notEmpty(),
], async (req, res) => {
  const { id_token } = req.body;

  const { data, error } = await supabase.auth.signInWithIdToken({
    provider: 'google',
    token: id_token,
  });

  if (error) return res.status(401).json({ error: error.message });

  const { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', data.user.id)
    .single();

  res.json({
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
    expires_at: data.session.expires_at,
    user: profile,
    is_new: !profile?.is_verified,
  });
});

// ── POST /api/auth/apple ── (Apple Sign In token from Flutter)
router.post('/apple', [
  body('id_token').notEmpty(),
], async (req, res) => {
  const { id_token, nonce } = req.body;

  const { data, error } = await supabase.auth.signInWithIdToken({
    provider: 'apple',
    token: id_token,
    nonce,
  });

  if (error) return res.status(401).json({ error: error.message });

  const { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', data.user.id)
    .single();

  res.json({
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
    expires_at: data.session.expires_at,
    user: profile,
  });
});

// ── POST /api/auth/refresh ──
router.post('/refresh', [body('refresh_token').notEmpty()], async (req, res) => {
  const { refresh_token } = req.body;
  const { data, error } = await supabase.auth.refreshSession({ refresh_token });

  if (error) return res.status(401).json({ error: 'Invalid refresh token' });

  res.json({
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
    expires_at: data.session.expires_at,
  });
});

// ── POST /api/auth/logout ──
router.post('/logout', authenticate, async (req, res) => {
  await supabase.auth.signOut();
  res.json({ message: 'Logged out successfully' });
});

// ── POST /api/auth/forgot-password ──
router.post('/forgot-password', [body('email').isEmail()], async (req, res) => {
  const { email } = req.body;
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: 'lavayago://reset-password',
  });
  // Always return 200 to avoid email enumeration
  res.json({ message: 'If this email exists, a reset link has been sent.' });
});

// ── POST /api/auth/reset-password ──
router.post('/reset-password', authenticate, [
  body('password').isLength({ min: 8 }),
], async (req, res) => {
  const { password } = req.body;
  const { error } = await supabase.auth.updateUser({ password });
  if (error) return res.status(400).json({ error: error.message });
  res.json({ message: 'Password updated successfully' });
});

// ── GET /api/auth/me ──
router.get('/me', authenticate, async (req, res) => {
  const { data: profile } = await supabase
    .from('profiles')
    .select('*, addresses(*)')
    .eq('id', req.user.id)
    .single();
  res.json(profile);
});

// ── PATCH /api/auth/me ──
router.patch('/me', authenticate, async (req, res) => {
  const { full_name, phone, avatar_url, preferred_lang, push_token } = req.body;
  const updates = {};
  if (full_name) updates.full_name = full_name;
  if (phone) updates.phone = phone;
  if (avatar_url) updates.avatar_url = avatar_url;
  if (preferred_lang) updates.preferred_lang = preferred_lang;
  if (push_token) updates.push_token = push_token;

  const { data, error } = await supabase
    .from('profiles')
    .update(updates)
    .eq('id', req.user.id)
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

module.exports = router;
