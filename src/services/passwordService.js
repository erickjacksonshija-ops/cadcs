const bcrypt = require('bcryptjs');

const SALT_ROUNDS = 12;

async function hash(plainPassword) {
  return bcrypt.hash(plainPassword, SALT_ROUNDS);
}

async function verify(plainPassword, passwordHash) {
  return bcrypt.compare(plainPassword, passwordHash);
}

module.exports = { hash, verify };
