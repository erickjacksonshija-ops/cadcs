// Bootstraps the very first admin account. The admin-provisioning API
// (POST /api/admin/users) requires an authenticated admin session to call
// it -- so the first admin has to be created out-of-band. Idempotent: does
// nothing if an admin already exists.
const crypto = require('crypto');
const pool = require('../config/db');
const userService = require('./../services/userService');
const { ROLES } = require('../config/roles');

async function run() {
  const [existingAdmins] = await pool.query(
    "SELECT id FROM users WHERE role = 'admin' LIMIT 1"
  );
  if (existingAdmins.length > 0) {
    console.log('An admin user already exists. Nothing to seed.');
    return;
  }

  const email = process.env.ADMIN_SEED_EMAIL || 'admin@cadcs.local';
  const password = process.env.ADMIN_SEED_PASSWORD || crypto.randomBytes(9).toString('base64url');

  await userService.createUser({
    name: 'System Administrator',
    email,
    password,
    role: ROLES.ADMIN,
  });

  console.log('Seeded initial admin account:');
  console.log(`  email:    ${email}`);
  if (!process.env.ADMIN_SEED_PASSWORD) {
    console.log(`  password: ${password}  (generated -- store this now, it will not be shown again)`);
  } else {
    console.log('  password: (from ADMIN_SEED_PASSWORD env var)');
  }
}

if (require.main === module) {
  run()
    .then(() => pool.end())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

module.exports = { run };
