const supabase = require('../db/supabase');
const logger = require('../utils/logger');

// Send push notification via Firebase Cloud Messaging
async function sendFCMPush(pushToken, title, body, data = {}) {
  if (!pushToken || !process.env.FIREBASE_PROJECT_ID) return;

  try {
    const { GoogleAuth } = require('google-auth-library');
    const auth = new GoogleAuth({
      credentials: {
        project_id: process.env.FIREBASE_PROJECT_ID,
        private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        client_email: process.env.FIREBASE_CLIENT_EMAIL,
      },
      scopes: ['https://www.googleapis.com/auth/firebase.messaging'],
    });

    const client = await auth.getClient();
    const token = await client.getAccessToken();

    await fetch(
      `https://fcm.googleapis.com/v1/projects/${process.env.FIREBASE_PROJECT_ID}/messages:send`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token.token}`,
        },
        body: JSON.stringify({
          message: {
            token: pushToken,
            notification: { title, body },
            data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
            android: { priority: 'high', notification: { sound: 'default', click_action: 'FLUTTER_NOTIFICATION_CLICK' } },
            apns: { payload: { aps: { sound: 'default', badge: 1 } } },
          },
        }),
      }
    );
  } catch (err) {
    logger.error('FCM push error:', err.message);
  }
}

// Main send function — saves to DB and sends push
async function send(userId, type, { title_en, title_es, body_en, body_es, data = {} }) {
  if (!userId) return;

  try {
    // Insert notification record
    await supabase.from('notifications').insert({
      user_id: userId,
      type,
      title_en,
      title_es,
      body_en,
      body_es,
      data,
    });

    // Get user's push token and preferred language
    const { data: profile } = await supabase
      .from('profiles')
      .select('push_token, preferred_lang')
      .eq('id', userId)
      .single();

    if (profile?.push_token) {
      const lang = profile.preferred_lang || 'en';
      const title = lang === 'es' ? title_es : title_en;
      const body = lang === 'es' ? body_es : body_en;
      await sendFCMPush(profile.push_token, title, body, data);
    }
  } catch (err) {
    logger.error('Notification error:', err.message);
  }
}

module.exports = { send, sendFCMPush };
