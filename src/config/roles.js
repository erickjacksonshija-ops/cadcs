const ROLES = Object.freeze({
  DISPATCHER: 'dispatcher',
  CREW: 'crew',
  HOSPITAL_STAFF: 'hospital_staff',
  ADMIN: 'admin',
});

const ALL_ROLES = Object.values(ROLES);

// Mirrors the DB CHECK constraint (chk_users_role_links in
// 003_create_users.sql) so invalid combinations are rejected at the API
// boundary with a clear message, not just a raw SQL constraint error.
function requiredLinkFor(role) {
  if (role === ROLES.DISPATCHER || role === ROLES.CREW) return 'provider_id';
  if (role === ROLES.HOSPITAL_STAFF) return 'hospital_id';
  return null; // admin
}

module.exports = { ROLES, ALL_ROLES, requiredLinkFor };
