const triageService = require('../../src/services/triageService');

describe('triageService.classify', () => {
  it('classifies an unconscious patient as P1/ALS regardless of chief complaint', () => {
    expect(triageService.classify('other', { unconscious: true })).toEqual({
      priority: 'P1',
      capability: 'ALS',
    });
  });

  it('classifies not-breathing as P1/ALS', () => {
    expect(triageService.classify('trauma', { notBreathing: true })).toEqual({
      priority: 'P1',
      capability: 'ALS',
    });
  });

  it('classifies severe bleeding as P1/ALS', () => {
    expect(triageService.classify('other', { severeBleeding: true })).toEqual({
      priority: 'P1',
      capability: 'ALS',
    });
  });

  it('classifies cardiac with no red flags as P2/ALS', () => {
    expect(triageService.classify('cardiac', {})).toEqual({ priority: 'P2', capability: 'ALS' });
  });

  it('classifies respiratory with no red flags as P2/ALS', () => {
    expect(triageService.classify('respiratory', {})).toEqual({ priority: 'P2', capability: 'ALS' });
  });

  it('classifies trauma with no red flags as P2/BLS', () => {
    expect(triageService.classify('trauma', {})).toEqual({ priority: 'P2', capability: 'BLS' });
  });

  it('classifies obstetric with no red flags as P2/BLS', () => {
    expect(triageService.classify('obstetric', {})).toEqual({ priority: 'P2', capability: 'BLS' });
  });

  it('classifies other with no red flags as P3/BLS', () => {
    expect(triageService.classify('other', {})).toEqual({ priority: 'P3', capability: 'BLS' });
  });

  it('treats missing/undefined red flags as false, not a crash', () => {
    expect(triageService.classify('other', undefined)).toEqual({ priority: 'P3', capability: 'BLS' });
  });

  it('rejects an invalid chief complaint', () => {
    expect(() => triageService.classify('not-a-real-category', {})).toThrow();
  });
});
