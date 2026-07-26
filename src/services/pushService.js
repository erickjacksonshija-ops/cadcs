const webpush = require('web-push');
const pool = require('../config/db');
const env = require('../config/env');

// See plan: "Notification Reliability" -- a Socket.IO push only reaches an
// open, focused tab. Web Push reaches the same hospital/dispatcher alerts
// as an OS-level notification even when the tab is backgrounded or the
// browser is closed, using the same service-worker infrastructure already
// built for the installable crew PWA. This is additive, not a replacement
// for the existing Socket.IO emits -- both fire for the same event.

const isConfigured = Boolean(env.vapid.publicKey && env.vapid.privateKey);
if (isConfigured) {
  webpush.setVapidDetails(env.vapid.contactEmail, env.vapid.publicKey, env.vapid.privateKey);
}

async function subscribe(userId, subscription) {
  const { endpoint, keys } = subscription;
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    throw new Error('Invalid push subscription payload');
  }
  await pool.query(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh_key, auth_key)
     VALUES (:userId, :endpoint, :p256dh, :auth)
     ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), p256dh_key = VALUES(p256dh_key), auth_key = VALUES(auth_key)`,
    { userId, endpoint, p256dh: keys.p256dh, auth: keys.auth }
  );
}

async function unsubscribe(userId, endpoint) {
  await pool.query('DELETE FROM push_subscriptions WHERE user_id = :userId AND endpoint = :endpoint', {
    userId,
    endpoint,
  });
}

async function findSubscriptionsForUsers(userIds) {
  if (userIds.length === 0) return [];
  const [rows] = await pool.query('SELECT * FROM push_subscriptions WHERE user_id IN (:userIds)', { userIds });
  return rows;
}

// Best-effort: a push failure must never break the caller's real work (the
// notification/escalation already happened via Socket.IO and the DB write --
// this is a supplementary delivery channel, not the source of truth).
// Expired/revoked subscriptions (410 Gone, 404 Not Found) are cleaned up
// rather than retried forever.
async function sendToUsers(userIds, payload) {
  if (!isConfigured) return;
  const subscriptions = await findSubscriptionsForUsers(userIds);

  await Promise.all(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh_key, auth: sub.auth_key },
          },
          JSON.stringify(payload)
        );
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          await pool.query('DELETE FROM push_subscriptions WHERE id = :id', { id: sub.id });
        } else {
          console.error('Web Push send failed:', err.message);
        }
      }
    })
  );
}

module.exports = { subscribe, unsubscribe, sendToUsers, isConfigured };
