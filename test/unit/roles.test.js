const { ROLES, requiredLinkFor } = require('../../src/config/roles');

describe('requiredLinkFor', () => {
  it('requires provider_id for dispatcher and crew', () => {
    expect(requiredLinkFor(ROLES.DISPATCHER)).toBe('provider_id');
    expect(requiredLinkFor(ROLES.CREW)).toBe('provider_id');
  });

  it('requires hospital_id for hospital_staff', () => {
    expect(requiredLinkFor(ROLES.HOSPITAL_STAFF)).toBe('hospital_id');
  });

  it('requires no link for admin', () => {
    expect(requiredLinkFor(ROLES.ADMIN)).toBeNull();
  });
});
