const socketSessionAuth = require('./auth');
const { DISPATCHERS_ROOM, crewRoom, hospitalRoom, findCurrentAmbulanceForCrew } = require('./rooms');
const { ROLES } = require('../config/roles');
const ambulanceService = require('../services/ambulanceService');
const notificationService = require('../services/notificationService');
const auditService = require('../services/auditService');
const pushService = require('../services/pushService');
const userService = require('../services/userService');
const env = require('../config/env');
const { setIo } = require('./ioRegistry');

const PING_HISTORY_THROTTLE_MS = 15_000;
const STALE_SWEEP_INTERVAL_MS = 10_000;
const ESCALATION_SWEEP_INTERVAL_MS = 15_000;

function isValidLatLng(lat, lng) {
  return (
    typeof lat === 'number' && typeof lng === 'number' &&
    lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
  );
}

function attachSocketHandlers(io) {
  setIo(io);
  io.use(socketSessionAuth);

  // ambulanceId -> ms timestamp of last ambulance_location_pings insert,
  // so history is sampled rather than written on every single GPS tick.
  const lastPingHistoryAt = new Map();
  // ambulanceId -> whether the dispatcher UI currently believes this unit
  // has lost signal, so signal_lost/signal_restored fire once on
  // transition rather than every sweep.
  const staleState = new Map();

  io.on('connection', async (socket) => {
    const user = socket.data.user;

    try {
      if (user.role === ROLES.DISPATCHER || user.role === ROLES.ADMIN) {
        socket.join(DISPATCHERS_ROOM);
      } else if (user.role === ROLES.CREW) {
        const ambulanceId = await findCurrentAmbulanceForCrew(user.id);
        if (ambulanceId) {
          socket.data.ambulanceId = ambulanceId;
          socket.join(crewRoom(ambulanceId));
        }
      } else if (user.role === ROLES.HOSPITAL_STAFF && user.hospitalId) {
        socket.join(hospitalRoom(user.hospitalId));
      }
    } catch (err) {
      console.error('Error assigning socket rooms:', err);
    }

    // Inbound: crew PWA reporting its GPS position. Only accepted from a
    // socket authenticated as the crew member currently assigned to that
    // specific ambulance -- never trusts a client-supplied ambulanceId.
    socket.on('ambulance:location', async ({ lat, lng } = {}) => {
      if (user.role !== ROLES.CREW || !socket.data.ambulanceId) return;
      if (!isValidLatLng(lat, lng)) return;

      const ambulanceId = socket.data.ambulanceId;
      try {
        const updated = await ambulanceService.updateLocation(ambulanceId, lat, lng);

        const lastInsert = lastPingHistoryAt.get(ambulanceId) || 0;
        if (Date.now() - lastInsert >= PING_HISTORY_THROTTLE_MS) {
          lastPingHistoryAt.set(ambulanceId, Date.now());
          await ambulanceService.recordLocationPing(ambulanceId, lat, lng);
        }

        // A fresh ping always means signal is restored, if it was stale.
        if (staleState.get(ambulanceId)) {
          staleState.set(ambulanceId, false);
          io.to(DISPATCHERS_ROOM).emit('ambulance:signal_restored', { ambulanceId });
        }

        io.to(DISPATCHERS_ROOM).emit('ambulance:location', {
          ambulanceId,
          lat: updated.lat,
          lng: updated.lng,
          lastPingAt: updated.last_ping_at,
          status: updated.status,
          callSign: updated.call_sign,
          capabilityLevel: updated.capability_level,
        });
      } catch (err) {
        console.error('Error handling ambulance:location:', err);
      }
    });
  });

  // Stale-signal sweep: flags (once, on transition) any ambulance on an
  // active mission whose last ping is older than the configured threshold,
  // rather than letting the dispatcher map silently show a frozen,
  // increasingly wrong position (see plan: "Reliability & Failure
  // Handling"). A single setInterval is correct for a single-process
  // deployment; a multi-instance deployment would need this moved to a
  // shared scheduler -- documented, not built, per the earlier decision
  // not to add Redis/clustering now.
  const sweepIntervalId = setInterval(async () => {
    try {
      const activeStatuses = ['dispatched', 'en_route', 'on_scene', 'transporting', 'at_hospital'];
      const ambulances = (
        await Promise.all(activeStatuses.map((status) => ambulanceService.list({ status })))
      ).flat();

      const now = Date.now();
      for (const amb of ambulances) {
        const lastPingMs = amb.last_ping_at ? new Date(amb.last_ping_at).getTime() : null;
        const isStale = lastPingMs === null || now - lastPingMs > env.ambulanceStaleSignalSeconds * 1000;
        const wasStale = staleState.get(amb.id) || false;

        if (isStale && !wasStale) {
          staleState.set(amb.id, true);
          io.to(DISPATCHERS_ROOM).emit('ambulance:signal_lost', { ambulanceId: amb.id });
        }
      }
    } catch (err) {
      console.error('Error during stale-signal sweep:', err);
    }
  }, STALE_SWEEP_INTERVAL_MS);
  sweepIntervalId.unref();

  // Hospital-acknowledgment escalation sweep: a notification sitting
  // unacknowledged past HOSPITAL_ACK_ESCALATION_SECONDS gets flagged to
  // dispatchers so a human can phone the hospital directly (see plan:
  // "Notification Reliability" / "Reliability & Failure Handling") --
  // the software degrades to "prompt a human" rather than assuming the
  // portal alert was seen.
  const escalationSweepIntervalId = setInterval(async () => {
    try {
      const pending = await notificationService.findPendingEscalations(env.hospitalAckEscalationSeconds);
      for (const notification of pending) {
        await notificationService.markEscalated(notification.id);
        await auditService.logEvent(notification.incident_id, 'hospital_ack_escalated', {
          metadata: { notificationId: notification.id, hospitalId: notification.hospital_id },
        });
        io.to(DISPATCHERS_ROOM).emit('hospital:ack_escalated', {
          notificationId: notification.id,
          incidentId: notification.incident_id,
          hospitalId: notification.hospital_id,
        });

        // Web Push alongside the Socket.IO emit above -- reaches a
        // dispatcher even if the dashboard tab isn't focused, which is
        // exactly the scenario this escalation exists to catch (see plan:
        // "Notification Reliability").
        userService
          .findActiveIdsByRoles([ROLES.DISPATCHER, ROLES.ADMIN])
          .then((userIds) => pushService.sendToUsers(userIds, {
            title: 'Hospital acknowledgment overdue',
            body: `Incident #${notification.incident_id} -- notification unacknowledged past the escalation threshold`,
            url: '/dispatcher/',
          }))
          .catch((err) => console.error('Push notification failed:', err.message));
      }
    } catch (err) {
      console.error('Error during hospital-ack escalation sweep:', err);
    }
  }, ESCALATION_SWEEP_INTERVAL_MS);
  escalationSweepIntervalId.unref();

  // Tied to the underlying HTTP server's lifecycle rather than relying on
  // every caller (including tests) to remember to clearInterval manually --
  // otherwise the sweeps keep firing after server.close()/pool.end() in
  // tests and throw against a closed pool.
  io.httpServer?.on('close', () => {
    clearInterval(sweepIntervalId);
    clearInterval(escalationSweepIntervalId);
  });

  return { sweepIntervalId, escalationSweepIntervalId };
}

module.exports = attachSocketHandlers;
