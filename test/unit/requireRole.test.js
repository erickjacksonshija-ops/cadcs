const requireRole = require('../../src/middleware/requireRole');

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe('requireRole middleware', () => {
  it('rejects unauthenticated requests with 401', () => {
    const req = { session: {} };
    const res = mockRes();
    const next = jest.fn();

    requireRole('admin')(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a role not in the allow-list with 403', () => {
    const req = { session: { user: { role: 'dispatcher' } } };
    const res = mockRes();
    const next = jest.fn();

    requireRole('admin')(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('allows a role in the allow-list through to next()', () => {
    const req = { session: { user: { role: 'admin' } } };
    const res = mockRes();
    const next = jest.fn();

    requireRole('admin')(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('allows any role listed when multiple are given', () => {
    const req = { session: { user: { role: 'dispatcher' } } };
    const res = mockRes();
    const next = jest.fn();

    requireRole('admin', 'dispatcher')(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });
});
