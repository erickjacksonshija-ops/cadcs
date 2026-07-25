const pool = require('../config/db');
const { ROLES } = require('../config/roles');

const DISPATCHERS_ROOM = 'dispatchers';
const crewRoom = (ambulanceId) => `crew:${ambulanceId}`;
const hospitalRoom = (hospitalId) => `hospital:${hospitalId}`;

async function findCurrentAmbulanceForCrew(userId) {
  const [rows] = await pool.query(
    'SELECT id FROM ambulances WHERE current_crew_user_id = :userId AND active = 1 LIMIT 1',
    { userId }
  );
  return rows[0]?.id ?? null;
}

// Server decides room membership from the authenticated session -- a
// client can never request an arbitrary room name.
async function roomsForUser(user) {
  if (user.role === ROLES.DISPATCHER || user.role === ROLES.ADMIN) {
    return [DISPATCHERS_ROOM];
  }
  if (user.role === ROLES.CREW) {
    const ambulanceId = await findCurrentAmbulanceForCrew(user.id);
    return ambulanceId ? [crewRoom(ambulanceId)] : [];
  }
  if (user.role === ROLES.HOSPITAL_STAFF) {
    return user.hospitalId ? [hospitalRoom(user.hospitalId)] : [];
  }
  return [];
}

module.exports = {
  DISPATCHERS_ROOM,
  crewRoom,
  hospitalRoom,
  findCurrentAmbulanceForCrew,
  roomsForUser,
};
