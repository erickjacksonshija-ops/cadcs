const passwordService = require('../../src/services/passwordService');

describe('passwordService', () => {
  it('hashes a password and verifies the correct password against it', async () => {
    const hash = await passwordService.hash('correct-horse-battery-staple');
    expect(hash).not.toBe('correct-horse-battery-staple');
    await expect(passwordService.verify('correct-horse-battery-staple', hash)).resolves.toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const hash = await passwordService.hash('correct-horse-battery-staple');
    await expect(passwordService.verify('wrong-password', hash)).resolves.toBe(false);
  });

  it('produces a different hash each time (random salt)', async () => {
    const hash1 = await passwordService.hash('same-password');
    const hash2 = await passwordService.hash('same-password');
    expect(hash1).not.toBe(hash2);
  });
});
