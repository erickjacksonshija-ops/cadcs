const express = require('express');
const path = require('path');
const helmet = require('helmet');
const session = require('express-session');
const env = require('./config/env');
const sessionStore = require('./config/sessionStore');
const tokenFallbackAuth = require('./middleware/tokenFallbackAuth');
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const incidentRoutes = require('./routes/incidents');
const ambulanceRoutes = require('./routes/ambulances');
const hospitalRoutes = require('./routes/hospitals');
const hospitalNotificationRoutes = require('./routes/hospitalNotifications');
const geocodeRoutes = require('./routes/geocode');
const pushRoutes = require('./routes/push');

function createApp() {
  const app = express();

  app.use(
    helmet({
      // Leaflet tiles are fetched from OSM's tile subdomains, which don't
      // send Cross-Origin-Resource-Policy headers -- COEP's default
      // 'require-corp' would silently block every map tile.
      crossOriginEmbedderPolicy: false,
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          // No inline <script> tags anywhere in the four frontends (verified
          // -- every handler is wired via addEventListener), so scriptSrc
          // stays strict with no 'unsafe-inline'.
          scriptSrc: ["'self'", 'https://unpkg.com'],
          // Inline style="" attributes and JS-set .style properties are
          // used throughout the vanilla-JS frontends, so styleSrc needs
          // 'unsafe-inline' -- CSS injection isn't a comparable risk to
          // script injection and there's no practical nonce/hash scheme
          // for dynamically generated innerHTML templates.
          styleSrc: ["'self'", 'https://unpkg.com', "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'https://unpkg.com', 'https://*.tile.openstreetmap.org'],
          connectSrc: ["'self'"],
          fontSrc: ["'self'", 'data:'],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          frameAncestors: ["'none'"],
        },
      },
    })
  );

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  app.use(
    session({
      store: sessionStore,
      secret: env.sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: env.nodeEnv === 'production',
        maxAge: 1000 * 60 * 60 * 12, // 12 hours
      },
    })
  );
  app.use(tokenFallbackAuth);

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', env: env.nodeEnv });
  });

  app.use('/api/auth', authRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/incidents', incidentRoutes);
  app.use('/api/ambulances', ambulanceRoutes);
  app.use('/api/hospitals', hospitalRoutes);
  app.use('/api/hospital/notifications', hospitalNotificationRoutes);
  app.use('/api/geocode', geocodeRoutes);
  app.use('/api/push', pushRoutes);

  // dotfiles: 'allow' is required here -- express.static ignores dot-segment
  // paths by default, which would silently 404 the Android TWA asset-link
  // verification file.
  app.use('/.well-known', express.static(path.join(__dirname, '../public/.well-known'), { dotfiles: 'allow' }));
  app.use('/shared', express.static(path.join(__dirname, '../public/shared')));
  app.use('/', express.static(path.join(__dirname, '../public/login')));
  app.use('/dispatcher', express.static(path.join(__dirname, '../public/dispatcher')));
  app.use('/crew', express.static(path.join(__dirname, '../public/crew')));
  app.use('/hospital', express.static(path.join(__dirname, '../public/hospital')));
  app.use('/admin', express.static(path.join(__dirname, '../public/admin')));

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    console.error(err);
    // Only expose err.message for errors we deliberately raised with a
    // client-safe message and an explicit 4xx status (ValidationError,
    // ConflictError, etc). Anything else -- including raw DB driver errors,
    // which can contain table/column/constraint names -- gets a generic
    // message; the real detail goes to the server log only.
    const status = err.status && err.status < 500 ? err.status : 500;
    const message = status < 500 ? err.message : 'Internal server error';
    res.status(status).json({ error: message });
  });

  return app;
}

module.exports = createApp;
