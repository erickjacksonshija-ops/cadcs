// Deterministic, dispatcher-actionable-in-seconds triage classification --
// explicitly NOT a licensed EMD/AMPDS protocol (see the plan's "Triage /
// Priority Classification" section). Maps a chief-complaint category plus
// a short red-flag checklist to a suggested priority tier and minimum
// ambulance capability. The dispatcher can override the suggestion, but
// both are always recorded (see incidentService) so an override is
// visible, not silently lost.

const CHIEF_COMPLAINTS = ['trauma', 'cardiac', 'obstetric', 'respiratory', 'other'];

const RED_FLAG_KEYS = ['unconscious', 'notBreathing', 'severeBleeding'];

const PRIORITIES = ['P1', 'P2', 'P3'];

function normalizeRedFlags(redFlags = {}) {
  const normalized = {};
  for (const key of RED_FLAG_KEYS) {
    normalized[key] = Boolean(redFlags[key]);
  }
  return normalized;
}

function hasAnyRedFlag(redFlags) {
  return RED_FLAG_KEYS.some((key) => redFlags[key]);
}

// Returns { priority, capability } -- pure function, no I/O, easy to unit test.
function classify(chiefComplaint, rawRedFlags) {
  if (!CHIEF_COMPLAINTS.includes(chiefComplaint)) {
    throw new Error(`Invalid chief complaint: ${chiefComplaint}`);
  }
  const redFlags = normalizeRedFlags(rawRedFlags);

  // Any critical red flag (unconscious / not breathing / severe bleeding)
  // is always P1/ALS regardless of chief complaint category.
  if (hasAnyRedFlag(redFlags)) {
    return { priority: 'P1', capability: 'ALS' };
  }

  if (chiefComplaint === 'cardiac' || chiefComplaint === 'respiratory') {
    // No red flags yet, but these categories can deteriorate quickly --
    // keep ALS available.
    return { priority: 'P2', capability: 'ALS' };
  }

  if (chiefComplaint === 'trauma' || chiefComplaint === 'obstetric') {
    return { priority: 'P2', capability: 'BLS' };
  }

  return { priority: 'P3', capability: 'BLS' };
}

module.exports = { classify, CHIEF_COMPLAINTS, RED_FLAG_KEYS, PRIORITIES, normalizeRedFlags };
