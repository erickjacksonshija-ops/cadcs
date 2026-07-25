// Role-aware field visibility for incidents -- one function every route
// goes through, rather than ad-hoc filtering scattered per-route (see
// plan: "Security" section). Mirrors the exact visibility rules from the
// proposal's ethics section (Sec 3.11):
//   - Dispatcher/admin: full record (they're the ones who took the call).
//   - Crew: location + clinical priority + what's needed to actually
//     respond (chief complaint category, required capability, status) --
//     but NOT the dispatcher's free-text patient_notes, which can contain
//     sensitive personal detail beyond what's operationally necessary.
//   - Hospital staff: condition information (including patient_notes), but
//     ONLY once the incident has actually been dispatched to them --
//     before that, a hospital has no legitimate reason to see the record
//     at all (enforced by the route layer, which only looks up
//     notifications for that hospital in the first place).
const { ROLES } = require('../config/roles');

function forDispatcher(incident) {
  return incident;
}

function forCrew(incident) {
  const { patient_notes: _patientNotes, caller_phone: _callerPhone, created_by: _createdBy, ...visible } = incident;
  return visible;
}

function forHospitalStaff(incident) {
  const { caller_phone: _callerPhone, created_by: _createdBy, red_flags: _redFlags, ...visible } = incident;
  return visible;
}

function serializeIncidentForRole(incident, role) {
  if (!incident) return incident;
  if (role === ROLES.DISPATCHER || role === ROLES.ADMIN) return forDispatcher(incident);
  if (role === ROLES.CREW) return forCrew(incident);
  if (role === ROLES.HOSPITAL_STAFF) return forHospitalStaff(incident);
  throw new Error(`Unknown role for incident serialization: ${role}`);
}

module.exports = { serializeIncidentForRole };
