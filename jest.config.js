module.exports = {
  testEnvironment: 'node',
  // Integration tests hit a real MySQL instance (TRUNCATE across 9 tables
  // per test, plus bcrypt hashing) -- the 5s Jest default is too tight
  // under load. 30s is generous without masking a genuinely hung test.
  testTimeout: 30000,
};
