require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const logger = require('./utils/logger');

const authRoutes = require('./routes/auth');
const bookingsRoutes = require('./routes/bookings');
const providersRoutes = require('./routes/providers');
const servicesRoutes = require('./routes/services');
const paymentsRoutes = require('./routes/payments');
const usersRoutes = require('./routes/users');
const adminRoutes = require('./routes/admin');
const notificationsRoutes = require('./routes/notifications');
const reviewsRoutes = require('./routes/reviews');
const messagesRoutes = require('./routes/messages');

const app = express();
const PORT = process.env.PORT || 4000;

// ── Security ──
app.use(helmet());
app.use(cors({
  origin: (origin, cb) => {
    const allowed = (process.env.ALLOWED_ORIGINS || '').split(',').map(o => o.trim());
    if (!origin || allowed.includes(origin)) return cb(null, true);
    cb(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));

// ── Rate limiting ──
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100, standardHeaders: true });
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true });
app.use('/api/', limiter);
app.use('/api/auth/', authLimiter);

// ── Body parsing ──
// Stripe webhooks need raw body
app.use('/api/payments/webhook/stripe', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Logging ──
app.use(morgan('combined', { stream: { write: msg => logger.info(msg.trim()) } }));

// ── Health check ──
app.get('/health', (req, res) => res.json({
  status: 'ok',
  service: 'LaVayaGo API',
  version: '1.0.0',
  timestamp: new Date().toISOString(),
}));

// ── Routes ──
app.use('/api/auth', authRoutes);
app.use('/api/bookings', bookingsRoutes);
app.use('/api/providers', providersRoutes);
app.use('/api/services', servicesRoutes);
app.use('/api/payments', paymentsRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/reviews', reviewsRoutes);
app.use('/api/messages', messagesRoutes);

// ── 404 handler ──
app.use((req, res) => res.status(404).json({ error: 'Route not found' }));

// ── Global error handler ──
app.use((err, req, res, next) => {
  logger.error(err.stack);
  const status = err.statusCode || err.status || 500;
  res.status(status).json({
    error: err.message || 'Internal server error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
});

app.listen(PORT, () => {
  logger.info(`🚀 LaVayaGo API running on port ${PORT} [${process.env.NODE_ENV}]`);
});

module.exports = app;
