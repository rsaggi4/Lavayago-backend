-- ═══════════════════════════════════════════════════════
--  LaVayaGo — Complete Database Schema
--  Run this in Supabase SQL Editor
-- ═══════════════════════════════════════════════════════

-- Enable extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";  -- for text search

-- ─────────────────────────────────────────
--  ENUMS
-- ─────────────────────────────────────────
CREATE TYPE user_role AS ENUM ('customer', 'provider', 'admin');
CREATE TYPE booking_status AS ENUM ('pending', 'confirmed', 'in_progress', 'completed', 'cancelled', 'disputed');
CREATE TYPE payment_status AS ENUM ('pending', 'paid', 'refunded', 'failed');
CREATE TYPE payment_method AS ENUM ('stripe', 'paypal');
CREATE TYPE service_type AS ENUM ('laundry', 'cleaning', 'pool_garden', 'dry_cleaning');
CREATE TYPE provider_status AS ENUM ('pending', 'active', 'suspended');
CREATE TYPE notification_type AS ENUM ('booking_new', 'booking_confirmed', 'booking_cancelled', 'booking_completed', 'payment_received', 'review_received', 'message_new');

-- ─────────────────────────────────────────
--  PROFILES (extends Supabase auth.users)
-- ─────────────────────────────────────────
CREATE TABLE profiles (
  id                UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  role              user_role NOT NULL DEFAULT 'customer',
  full_name         TEXT NOT NULL,
  email             TEXT NOT NULL UNIQUE,
  phone             TEXT,
  avatar_url        TEXT,
  preferred_lang    TEXT NOT NULL DEFAULT 'en' CHECK (preferred_lang IN ('en', 'es')),
  push_token        TEXT,         -- FCM token for Flutter push
  stripe_customer_id TEXT,
  paypal_payer_id   TEXT,
  is_verified       BOOLEAN DEFAULT FALSE,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────
--  ADDRESSES
-- ─────────────────────────────────────────
CREATE TABLE addresses (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  label       TEXT NOT NULL DEFAULT 'Home',   -- Home, Villa, Office…
  line1       TEXT NOT NULL,
  line2       TEXT,
  city        TEXT NOT NULL,
  postcode    TEXT,
  province    TEXT DEFAULT 'Alicante',
  country     TEXT DEFAULT 'ES',
  lat         NUMERIC(10,7),
  lng         NUMERIC(10,7),
  is_default  BOOLEAN DEFAULT FALSE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────
--  SERVICES (catalogue)
-- ─────────────────────────────────────────
CREATE TABLE services (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  type          service_type NOT NULL UNIQUE,
  name_en       TEXT NOT NULL,
  name_es       TEXT NOT NULL,
  description_en TEXT,
  description_es TEXT,
  icon_emoji    TEXT NOT NULL,
  base_price_eur NUMERIC(8,2) NOT NULL,
  unit_en       TEXT NOT NULL,    -- 'per load', 'per visit', etc.
  unit_es       TEXT NOT NULL,
  duration_mins INT NOT NULL DEFAULT 120,
  is_active     BOOLEAN DEFAULT TRUE,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Seed default services
INSERT INTO services (type, name_en, name_es, description_en, description_es, icon_emoji, base_price_eur, unit_en, unit_es, duration_mins) VALUES
  ('laundry',     'Laundry & Ironing',  'Lavandería y Planchado', 'Wash, dry, fold and iron delivered back to your villa.', 'Lavado, secado, doblado y planchado entregado en tu villa.', '🧺', 35.00, 'per load',    'por carga',   90),
  ('cleaning',    'Home Cleaning',      'Limpieza del Hogar',     'Deep cleans, regular maintenance, and post-rental turnovers.', 'Limpiezas profundas, mantenimiento regular y limpiezas post-alquiler.', '🧹', 60.00, 'per visit',   'por visita',  180),
  ('pool_garden', 'Pool & Garden',      'Piscina y Jardín',       'Pool maintenance, chemical balancing, and garden upkeep.', 'Mantenimiento de piscina, equilibrio químico y cuidado del jardín.', '🏊', 80.00, 'per visit',   'por visita',  120),
  ('dry_cleaning','Dry Cleaning',       'Tintorería',             'Pickup and delivery of delicate garments, suits, and linens.', 'Recogida y entrega de prendas delicadas, trajes y ropa de cama.', '👔', 12.00, 'per garment', 'por prenda',  60);

-- ─────────────────────────────────────────
--  PROVIDERS
-- ─────────────────────────────────────────
CREATE TABLE providers (
  id              UUID PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  bio_en          TEXT,
  bio_es          TEXT,
  services        service_type[] NOT NULL DEFAULT '{}',
  coverage_areas  TEXT[] DEFAULT '{}',   -- ['Jávea','Moraira','Altea']
  hourly_rate_eur NUMERIC(8,2),
  status          provider_status DEFAULT 'pending',
  id_verified     BOOLEAN DEFAULT FALSE,
  insurance_verified BOOLEAN DEFAULT FALSE,
  stripe_account_id  TEXT,               -- Stripe Connect account
  total_jobs      INT DEFAULT 0,
  avg_rating      NUMERIC(3,2) DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Provider availability slots
CREATE TABLE provider_availability (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  provider_id  UUID NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  day_of_week  INT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),  -- 0=Mon
  start_time   TIME NOT NULL,
  end_time     TIME NOT NULL,
  is_active    BOOLEAN DEFAULT TRUE
);

-- Provider blocked dates
CREATE TABLE provider_blocked_dates (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  provider_id UUID NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  blocked_date DATE NOT NULL,
  reason      TEXT
);

-- ─────────────────────────────────────────
--  BOOKINGS
-- ─────────────────────────────────────────
CREATE TABLE bookings (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  ref                 TEXT NOT NULL UNIQUE DEFAULT 'LVG-' || UPPER(SUBSTRING(gen_random_uuid()::TEXT, 1, 8)),
  customer_id         UUID NOT NULL REFERENCES profiles(id),
  provider_id         UUID REFERENCES providers(id),
  service_id          UUID NOT NULL REFERENCES services(id),
  address_id          UUID REFERENCES addresses(id),
  address_snapshot    JSONB,               -- snapshot at booking time
  scheduled_date      DATE NOT NULL,
  scheduled_time      TIME NOT NULL,
  duration_mins       INT NOT NULL DEFAULT 120,
  notes               TEXT,
  status              booking_status DEFAULT 'pending',
  payment_status      payment_status DEFAULT 'pending',
  payment_method      payment_method,
  stripe_payment_intent TEXT,
  paypal_order_id     TEXT,
  subtotal_eur        NUMERIC(8,2) NOT NULL,
  platform_fee_eur    NUMERIC(8,2) NOT NULL,
  provider_payout_eur NUMERIC(8,2) NOT NULL,
  total_eur           NUMERIC(8,2) NOT NULL,
  confirmed_at        TIMESTAMPTZ,
  started_at          TIMESTAMPTZ,
  completed_at        TIMESTAMPTZ,
  cancelled_at        TIMESTAMPTZ,
  cancel_reason       TEXT,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────
--  REVIEWS
-- ─────────────────────────────────────────
CREATE TABLE reviews (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  booking_id   UUID NOT NULL UNIQUE REFERENCES bookings(id),
  customer_id  UUID NOT NULL REFERENCES profiles(id),
  provider_id  UUID NOT NULL REFERENCES providers(id),
  rating       INT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment      TEXT,
  reply        TEXT,       -- provider reply
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────
--  MESSAGES (in-booking chat)
-- ─────────────────────────────────────────
CREATE TABLE messages (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  booking_id  UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  sender_id   UUID NOT NULL REFERENCES profiles(id),
  body        TEXT NOT NULL,
  read_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────
--  NOTIFICATIONS
-- ─────────────────────────────────────────
CREATE TABLE notifications (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  type        notification_type NOT NULL,
  title_en    TEXT NOT NULL,
  title_es    TEXT NOT NULL,
  body_en     TEXT,
  body_es     TEXT,
  data        JSONB DEFAULT '{}',
  read        BOOLEAN DEFAULT FALSE,
  sent_push   BOOLEAN DEFAULT FALSE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────
--  PAYOUTS (provider payments)
-- ─────────────────────────────────────────
CREATE TABLE payouts (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  provider_id     UUID NOT NULL REFERENCES providers(id),
  booking_id      UUID REFERENCES bookings(id),
  amount_eur      NUMERIC(8,2) NOT NULL,
  stripe_payout_id TEXT,
  status          TEXT DEFAULT 'pending',
  paid_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────
--  INDEXES
-- ─────────────────────────────────────────
CREATE INDEX idx_bookings_customer ON bookings(customer_id);
CREATE INDEX idx_bookings_provider ON bookings(provider_id);
CREATE INDEX idx_bookings_status ON bookings(status);
CREATE INDEX idx_bookings_date ON bookings(scheduled_date);
CREATE INDEX idx_reviews_provider ON reviews(provider_id);
CREATE INDEX idx_messages_booking ON messages(booking_id);
CREATE INDEX idx_notifications_user ON notifications(user_id, read);
CREATE INDEX idx_addresses_user ON addresses(user_id);

-- ─────────────────────────────────────────
--  FUNCTIONS & TRIGGERS
-- ─────────────────────────────────────────

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_profiles_updated BEFORE UPDATE ON profiles FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_bookings_updated BEFORE UPDATE ON bookings FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_providers_updated BEFORE UPDATE ON providers FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Recalculate provider avg_rating after review insert
CREATE OR REPLACE FUNCTION refresh_provider_rating()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE providers SET
    avg_rating = (SELECT ROUND(AVG(rating)::NUMERIC, 2) FROM reviews WHERE provider_id = NEW.provider_id),
    total_jobs = (SELECT COUNT(*) FROM bookings WHERE provider_id = NEW.provider_id AND status = 'completed')
  WHERE id = NEW.provider_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_refresh_rating AFTER INSERT OR UPDATE ON reviews
  FOR EACH ROW EXECUTE FUNCTION refresh_provider_rating();

-- Auto-create profile on auth.users insert
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO profiles (id, email, full_name, role)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', split_part(NEW.email, '@', 1)),
    COALESCE((NEW.raw_user_meta_data->>'role')::user_role, 'customer')
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- ─────────────────────────────────────────
--  ROW LEVEL SECURITY
-- ─────────────────────────────────────────
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE addresses ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE payouts ENABLE ROW LEVEL SECURITY;

-- Profiles: users see/edit their own; admins see all
CREATE POLICY "profiles_own" ON profiles FOR ALL USING (auth.uid() = id);
CREATE POLICY "profiles_admin" ON profiles FOR ALL USING (
  EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
);

-- Addresses: own only
CREATE POLICY "addresses_own" ON addresses FOR ALL USING (auth.uid() = user_id);

-- Bookings: customer sees own, provider sees assigned, admin sees all
CREATE POLICY "bookings_customer" ON bookings FOR ALL USING (auth.uid() = customer_id);
CREATE POLICY "bookings_provider" ON bookings FOR SELECT USING (auth.uid() = provider_id);
CREATE POLICY "bookings_provider_update" ON bookings FOR UPDATE USING (auth.uid() = provider_id);
CREATE POLICY "bookings_admin" ON bookings FOR ALL USING (
  EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
);

-- Reviews: customer writes, everyone reads
CREATE POLICY "reviews_read" ON reviews FOR SELECT USING (TRUE);
CREATE POLICY "reviews_write" ON reviews FOR INSERT WITH CHECK (auth.uid() = customer_id);
CREATE POLICY "reviews_provider_reply" ON reviews FOR UPDATE USING (auth.uid() = provider_id);

-- Messages: booking participants only
CREATE POLICY "messages_read" ON messages FOR SELECT USING (
  EXISTS (SELECT 1 FROM bookings WHERE id = booking_id AND (customer_id = auth.uid() OR provider_id = auth.uid()))
);
CREATE POLICY "messages_write" ON messages FOR INSERT WITH CHECK (auth.uid() = sender_id);

-- Notifications: own only
CREATE POLICY "notifications_own" ON notifications FOR ALL USING (auth.uid() = user_id);

-- Providers: public read, self write
CREATE POLICY "providers_public_read" ON providers FOR SELECT USING (status = 'active');
CREATE POLICY "providers_own_write" ON providers FOR ALL USING (auth.uid() = id);
CREATE POLICY "providers_admin" ON providers FOR ALL USING (
  EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
);
