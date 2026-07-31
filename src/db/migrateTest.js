// Applies pending migrations to the TEST database (cadcs_dispatch_test),
// not dev. `migrate.js` itself just reads whatever's in process.env at the
// time -- this only exists to load .env.test first (see
// test/helpers/loadTestEnv.js) so the two never get pointed at the same
// DB by accident.
//
// Wired as `pretest` in package.json so `npm test` can never silently run
// against a stale test schema -- this exact failure mode (a migration
// applied to dev, forgotten for test, tests then failing with "table
// doesn't exist" instead of a real assertion failure) is what this script
// exists to prevent from recurring.
require('../../test/helpers/loadTestEnv');

require('./migrate')
  .run()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
