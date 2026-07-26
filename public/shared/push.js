// Shared Web Push subscribe/unsubscribe flow for the hospital portal and
// dispatcher dashboard (see plan: "Notification Reliability"). Not used by
// the crew PWA -- crew alerts arrive via the always-open Socket.IO
// connection instead (see src/routes/push.js for the role rationale).

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

// swPath: '/hospital/service-worker.js' or '/dispatcher/service-worker.js'.
// Returns 'enabled' | 'unsupported' | 'unavailable' (server has no VAPID
// keys configured) | 'denied' (browser permission denied).
async function enablePushNotifications(swPath) {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    return 'unsupported';
  }

  const { publicKey, configured } = await apiGet('/api/push/vapid-public-key');
  if (!configured || !publicKey) return 'unavailable';

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return 'denied';

  const registration = await navigator.serviceWorker.register(swPath);
  await navigator.serviceWorker.ready;

  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
  }

  await apiPost('/api/push/subscribe', subscription.toJSON());
  return 'enabled';
}

async function isPushEnabled(swPath) {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return false;
  const registration = await navigator.serviceWorker.getRegistration(swPath);
  if (!registration) return false;
  const subscription = await registration.pushManager.getSubscription();
  return Boolean(subscription);
}

async function disablePushNotifications(swPath) {
  const registration = await navigator.serviceWorker.getRegistration(swPath);
  if (!registration) return;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return;
  await apiPost('/api/push/unsubscribe', { endpoint: subscription.endpoint });
  await subscription.unsubscribe();
}
