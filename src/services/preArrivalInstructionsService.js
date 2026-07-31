// Pre-arrival instructions -- a real Emergency Medical Dispatch (EMD/AMPDS)
// concept: while the ambulance is en route, the dispatcher stays on the
// line and reads the caller scripted first-aid steps for their specific
// situation. This is deliberately generic, standard lay-rescuer guidance
// (the same class of advice published by AHA/Red Cross), not a licensed
// clinical protocol -- same "explicitly not AMPDS" framing as
// triageService's own classify(). Pure function, no I/O, easy to unit test.
//
// Selection mirrors triageService.classify()'s own priority logic: a
// critical red flag overrides the chief-complaint category, because an
// unconscious/not-breathing patient needs CPR guidance regardless of why
// they were originally called in.

const { normalizeRedFlags } = require('./triageService');

const CARDIAC_ARREST_SCRIPT = {
  title: 'Possible cardiac arrest -- CPR guidance',
  steps: [
    'Make sure the scene is safe before approaching the patient.',
    'Check for a response -- tap their shoulder firmly and shout.',
    "If there's no response and they are not breathing normally, begin chest compressions immediately: push hard and fast in the center of the chest, about 5cm deep, at 100-120 compressions per minute.",
    'Let the chest fully rise between compressions.',
    'If someone else is present, send them to find an AED if one is available nearby, and follow its voice prompts.',
    'Continue compressions without stopping until the ambulance crew arrives or the patient starts breathing normally.',
  ],
};

const SEVERE_BLEEDING_SCRIPT = {
  title: 'Severe bleeding -- control guidance',
  steps: [
    'Apply firm, direct pressure to the wound using a clean cloth or dressing.',
    "If an object is embedded in the wound, don't remove it -- pack and apply pressure around it instead.",
    'Keep the patient lying down and, if possible, raise the injured area above heart level.',
    'If bleeding from a limb continues despite firm pressure, maintain pressure and keep the patient still.',
    'Keep the patient warm and reassure them until the crew arrives.',
  ],
};

const SCRIPTS_BY_CHIEF_COMPLAINT = {
  cardiac: {
    title: 'Suspected cardiac event',
    steps: [
      'Keep the patient calm and seated or lying in whichever position is most comfortable for them.',
      'Loosen any tight clothing.',
      'If they have their own prescribed heart medication, help them take it as prescribed.',
      "If a doctor has not advised against it and they aren't allergic, one adult aspirin can be chewed (not swallowed whole) -- only if this is safe for the patient.",
      "Don't let the patient walk around or drive themselves.",
      'If they become unresponsive and stop breathing normally, begin CPR immediately.',
    ],
  },
  respiratory: {
    title: 'Breathing difficulty',
    steps: [
      'Help the patient sit upright, leaning slightly forward if that eases their breathing.',
      'Loosen any tight clothing around the neck and chest.',
      'If they have prescribed rescue medication (e.g. an inhaler), help them use it if they are able.',
      'Keep them calm -- anxiety can worsen breathing difficulty.',
      'If they stop breathing or become unresponsive, begin CPR immediately.',
    ],
  },
  obstetric: {
    title: 'Active labor / imminent childbirth',
    steps: [
      'Stay calm -- most births happen safely without complications before help arrives.',
      'Help the mother into a comfortable position, lying back with knees bent and legs apart.',
      "Don't try to hold the baby back or delay delivery.",
      "If the baby's head begins to emerge, support it gently as it comes out -- never pull.",
      "Once born, dry the baby, keep them warm, and place them skin-to-skin on the mother's chest.",
      "Don't cut or tie the umbilical cord -- leave that for the crew.",
      'Note the time of birth if you can.',
    ],
  },
  trauma: {
    title: 'Injury / trauma',
    steps: [
      "Don't move the patient unless there is immediate danger (fire, traffic, unstable structure).",
      'Keep them as still as possible, especially the head and neck, in case of spinal injury.',
      'Control any visible bleeding with firm, direct pressure.',
      'Keep the patient warm and reassure them.',
      'Monitor their breathing and responsiveness until the crew arrives.',
    ],
  },
  other: {
    title: 'General guidance',
    steps: [
      'Keep the patient calm and as comfortable as possible.',
      "Don't give them anything to eat or drink.",
      'Monitor their breathing and level of consciousness.',
      'Stay on the line if possible and tell dispatch immediately if their condition changes.',
    ],
  },
};

// Returns { title, steps } -- always something, never null, since 'other'
// covers any chief complaint outside the structured categories.
function getInstructions(chiefComplaint, rawRedFlags) {
  const redFlags = normalizeRedFlags(rawRedFlags);

  if (redFlags.unconscious || redFlags.notBreathing) {
    return CARDIAC_ARREST_SCRIPT;
  }
  if (redFlags.severeBleeding) {
    return SEVERE_BLEEDING_SCRIPT;
  }
  return SCRIPTS_BY_CHIEF_COMPLAINT[chiefComplaint] || SCRIPTS_BY_CHIEF_COMPLAINT.other;
}

module.exports = { getInstructions };
