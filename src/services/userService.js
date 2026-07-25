const pool = require('../config/db');
const passwordService = require('./passwordService');
const { ROLES, ALL_ROLES, requiredLinkFor } = require('../config/roles');

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
  }
}

class ConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConflictError';
    this.status = 409;
  }
}

function toPublicUser(row) {
  if (!row) return null;
  // Never serialize password_hash back to any client, ever.
  const { password_hash: _passwordHash, ...safe } = row;
  return safe;
}

async function createUser({ name, email, phone, password, role, providerId, hospitalId }) {
  if (!ALL_ROLES.includes(role)) {
    throw new ValidationError(`Invalid role: ${role}`);
  }

  const requiredLink = requiredLinkFor(role);
  if (requiredLink === 'provider_id' && !providerId) {
    throw new ValidationError(`role '${role}' requires providerId`);
  }
  if (requiredLink === 'hospital_id' && !hospitalId) {
    throw new ValidationError(`role '${role}' requires hospitalId`);
  }
  if (requiredLink === null && (providerId || hospitalId)) {
    throw new ValidationError(`role '${role}' must not have providerId or hospitalId`);
  }

  const passwordHash = await passwordService.hash(password);

  try {
    const [result] = await pool.query(
      `INSERT INTO users (name, email, phone, password_hash, role, provider_id, hospital_id)
       VALUES (:name, :email, :phone, :passwordHash, :role, :providerId, :hospitalId)`,
      {
        name,
        email,
        phone: phone || null,
        passwordHash,
        role,
        providerId: role === ROLES.DISPATCHER || role === ROLES.CREW ? providerId : null,
        hospitalId: role === ROLES.HOSPITAL_STAFF ? hospitalId : null,
      }
    );
    return findById(result.insertId);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      throw new ConflictError('A user with that email already exists');
    }
    if (err.code === 'ER_NO_REFERENCED_ROW_2') {
      throw new ValidationError('providerId or hospitalId does not reference an existing record');
    }
    if (err.code === 'ER_CHECK_CONSTRAINT_VIOLATED') {
      throw new ValidationError('role does not match the provided providerId/hospitalId combination');
    }
    throw err;
  }
}

async function findByEmail(email) {
  const [rows] = await pool.query('SELECT * FROM users WHERE email = :email LIMIT 1', { email });
  return rows[0] || null;
}

async function findById(id) {
  const [rows] = await pool.query('SELECT * FROM users WHERE id = :id LIMIT 1', { id });
  return rows[0] || null;
}

async function verifyCredentials(email, password) {
  const user = await findByEmail(email);
  if (!user || !user.active) return null;
  const valid = await passwordService.verify(password, user.password_hash);
  return valid ? user : null;
}

// Admin-mediated reset -- there is no public self-registration or email
// infrastructure in this system (see "Account Provisioning" in the plan:
// only an admin provisions accounts), so a self-service "forgot password"
// email flow doesn't fit the account model. If a user forgets their
// password, an admin sets a new one for them, same as account creation.
async function setPassword(userId, newPassword) {
  const user = await findById(userId);
  if (!user) throw new ValidationError('User not found');

  const passwordHash = await passwordService.hash(newPassword);
  await pool.query('UPDATE users SET password_hash = :passwordHash WHERE id = :id', {
    passwordHash,
    id: userId,
  });
  return findById(userId);
}

module.exports = {
  createUser,
  findByEmail,
  findById,
  verifyCredentials,
  setPassword,
  toPublicUser,
  ValidationError,
  ConflictError,
};
