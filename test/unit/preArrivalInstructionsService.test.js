const preArrivalInstructionsService = require('../../src/services/preArrivalInstructionsService');

describe('preArrivalInstructionsService.getInstructions', () => {
  it('gives CPR guidance for an unconscious patient regardless of chief complaint', () => {
    const result = preArrivalInstructionsService.getInstructions('trauma', { unconscious: true });
    expect(result.title).toMatch(/cardiac arrest/i);
    expect(result.steps.some((s) => /compressions/i.test(s))).toBe(true);
  });

  it('gives CPR guidance for a not-breathing patient regardless of chief complaint', () => {
    const result = preArrivalInstructionsService.getInstructions('obstetric', { notBreathing: true });
    expect(result.title).toMatch(/cardiac arrest/i);
  });

  it('prioritizes CPR guidance over bleeding guidance when both red flags are set', () => {
    const result = preArrivalInstructionsService.getInstructions('trauma', {
      unconscious: true,
      severeBleeding: true,
    });
    expect(result.title).toMatch(/cardiac arrest/i);
  });

  it('gives bleeding-control guidance for severe bleeding with no consciousness/breathing red flag', () => {
    const result = preArrivalInstructionsService.getInstructions('trauma', { severeBleeding: true });
    expect(result.title).toMatch(/bleeding/i);
    expect(result.steps.some((s) => /pressure/i.test(s))).toBe(true);
  });

  it('gives chief-complaint-specific guidance with no red flags', () => {
    expect(preArrivalInstructionsService.getInstructions('cardiac', {}).title).toMatch(/cardiac/i);
    expect(preArrivalInstructionsService.getInstructions('respiratory', {}).title).toMatch(/breathing/i);
    expect(preArrivalInstructionsService.getInstructions('obstetric', {}).title).toMatch(/labor|childbirth/i);
    expect(preArrivalInstructionsService.getInstructions('trauma', {}).title).toMatch(/injury|trauma/i);
  });

  it('falls back to general guidance for an unrecognized chief complaint', () => {
    const result = preArrivalInstructionsService.getInstructions('not-a-real-category', {});
    expect(result.title).toMatch(/general/i);
  });

  it('treats missing/undefined red flags as false, not a crash', () => {
    expect(() => preArrivalInstructionsService.getInstructions('other', undefined)).not.toThrow();
  });

  it('every script has a non-empty steps array', () => {
    const complaints = ['cardiac', 'respiratory', 'obstetric', 'trauma', 'other'];
    for (const complaint of complaints) {
      const result = preArrivalInstructionsService.getInstructions(complaint, {});
      expect(Array.isArray(result.steps)).toBe(true);
      expect(result.steps.length).toBeGreaterThan(0);
    }
  });
});
