// Must be required before any src/ module that reads process.env (e.g.
// src/config/env.js), so tests hit cadcs_dispatch_test, never the dev DB.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env.test'), override: true });
