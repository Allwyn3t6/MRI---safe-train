/*
 * MRISafe Twin — assessment engine
 * ------------------------------------------------------------------
 * Pure JavaScript. No DOM, no Three.js, no network.
 * Loaded in the browser as a classic <script> (exposes window.MRIEngine)
 * and in Node via require() for the unit tests in /tests.
 *
 * Contents
 *   1. Event contract (pads, scene events, labels, zones)
 *   2. Rule dataset (ILLUSTRATIVE — see docs/rules.md)
 *   3. Items, patients, scenarios
 *   4. Checkpoints and requirement checks
 *   5. Attempt  — the deterministic state machine for one scenario run
 *   6. Session  — a trainee session made of attempts (handles reset)
 *   7. Adaptive scenario selection
 *   8. Serial protocol parser + sequence tracker
 *   9. Report export (JSON / CSV)
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MRIEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ---------------------------------------------------------------
   * 1. Event contract
   * ------------------------------------------------------------- */
  const PROTOCOL_VERSION = 1;

  // Physical pads -> attestation events. Shared with firmware.
  const PADS = [
    { id: 'T1', gpio: 4,  event: 'SCREENING_CHECK',  short: 'Screening' },
    { id: 'T2', gpio: 5,  event: 'VERIFY_EQUIPMENT', short: 'Equipment' },
    { id: 'T3', gpio: 6,  event: 'ROOM_ACCESS',      short: 'Zone IV access' },
    { id: 'T4', gpio: 7,  event: 'SAFETY_CLEARANCE', short: 'Final clearance' },
    { id: 'T5', gpio: 13, event: 'PROCEED_TO_SCAN',  short: 'Proceed to scan' },
    { id: 'T6', gpio: 14, event: 'RESET_SCENARIO',   short: 'Reset attempt' },
  ];
  const PAD_EVENT = Object.fromEntries(PADS.map(p => [p.id, p.event]));
  const ATTEST_EVENTS = PADS.map(p => p.event);
  // Accepted for compatibility with the original brief's naming.
  const EVENT_ALIASES = { START_SIMULATION: 'PROCEED_TO_SCAN' };

  // Events produced by interacting with the 3D scene / inspector.
  const SCENE_EVENTS = [
    'CONFIRM_ID',           // trainee confirms two identifiers match
    'INSPECT',              // target: 'record' | 'patient' | itemId | other scene object
    'IMPLANT_DECISION',     // value: 'ESCALATE' | 'PROCEED_ON_CARD' | 'IGNORE'
    'CLASSIFY',             // target: itemId, value: label
    'CONFIRM_CONDITIONS',   // target: itemId (MR Conditional item)
    'MOVE',                 // target: itemId, value: zone
    'REMOVE_PERSONAL_ITEM', // target: personal item id
  ];
  const ALL_EVENTS = ATTEST_EVENTS.concat(SCENE_EVENTS);

  const LABELS = {
    MR_SAFE:        { text: 'MR Safe',        tone: 'safe' },
    MR_CONDITIONAL: { text: 'MR Conditional', tone: 'conditional' },
    MR_UNSAFE:      { text: 'MR Unsafe',      tone: 'unsafe' },
  };
  const ZONES = {
    ZONE_II: { text: 'Zone II · staging' },
    ZONE_IV: { text: 'Zone IV · magnet room' },
  };
  const SOURCES = ['hw', 'kbd', 'ui', 'scene', 'test'];

  /* ---------------------------------------------------------------
   * 2. Rule dataset
   * Every rule is an EDUCATIONAL SIMPLIFICATION. `basis` names the
   * guidance the rule is modelled on; none has been verified by a
   * qualified MR safety officer for this prototype (status field).
   * ------------------------------------------------------------- */
  const SEVERITY = {
    critical: { label: 'Critical', points: 25 },
    major:    { label: 'Major',    points: 10 },
    minor:    { label: 'Minor',    points: 5 },
  };
  const SCORING = { start: 100, passMinScore: 80, passMaxCritical: 0 };

  const BASIS = {
    ACR: 'ACR Manual on MR Safety (American College of Radiology)',
    ASTM: 'ASTM F2503 — marking of medical devices for safety in the MR environment',
    NPSG: 'Two-identifier patient identification (Joint Commission NPSG.01.01.01)',
    LOCAL: 'Training-procedure convention for this prototype (not a clinical rule)',
  };

  const RULES = {
    'R-ID-01': {
      category: 'screening', severity: 'major', basis: 'NPSG',
      title: 'Identity not confirmed before screening sign-off',
      why: 'Screening answers only protect the patient they belong to. Two identifiers (name and MRN or date of birth) must match the request and the wristband.',
      corrective: 'Open the patient record and confirm that both identifiers on the wristband match the scan request, then sign off screening.',
    },
    'R-SCR-01': {
      category: 'screening', severity: 'major', basis: 'ACR',
      title: 'Screening signed off without reviewing the form',
      why: 'Every patient must be screened before entering Zone IV. Signing off without reading the form means implants, devices and prior metal injuries can be missed.',
      corrective: 'Open the patient record, read the MR screening form, then sign off.',
    },
    'R-SCR-02': {
      category: 'screening', severity: 'critical', basis: 'ACR',
      title: 'Reported implant not referred for review',
      why: '"MR Conditional" means the device is acceptable only under specific conditions in its labelling (for example field strength and scan limits). A patient card alone does not show that those conditions can be met for this scan.',
      corrective: 'Escalate the implant to the MR safety officer or supervising radiologist for review against the manufacturer\'s MR Conditional labelling before sign-off.',
    },
    'R-EQ-01': {
      category: 'equipment', severity: 'major', basis: 'ASTM',
      title: 'Equipment signed off with items not classified',
      why: 'Each item near the magnet room needs its MR status determined from its labelling before equipment can be cleared.',
      corrective: 'Select each item in the staging area and Zone IV, read its labelling, and classify it.',
    },
    'R-EQ-02': {
      category: 'equipment', severity: 'major', basis: 'ASTM',
      title: 'Item misclassified',
      why: 'MR status comes from the item\'s labelling. Items with no labelling have unknown status and are handled as MR Unsafe.',
      corrective: 'Re-read the item\'s label and correct the classification.',
    },
    'R-EQ-03': {
      category: 'equipment', severity: 'critical', basis: 'ACR',
      title: 'MR Unsafe item in or brought into Zone IV',
      why: 'Ferromagnetic objects can be pulled into the magnet with great force (projectile effect). The magnetic field is always on, even when no scan is running.',
      corrective: 'Keep the item out of Zone IV. Move it back to the Zone II staging area.',
    },
    'R-EQ-04': {
      category: 'equipment', severity: 'major', basis: 'ASTM',
      title: 'MR Conditional item in Zone IV without its conditions checked',
      why: 'An MR Conditional item is acceptable only when the conditions in its labelling are met in this suite.',
      corrective: 'Open the item and confirm its conditions against the labelling, or move it out of Zone IV.',
    },
    'R-EQ-05': {
      category: 'equipment', severity: 'critical', basis: 'ASTM',
      title: 'MR Unsafe or unknown item classified as acceptable',
      why: 'Calling an MR Unsafe or unlabelled item "Safe" or "Conditional" is the error that lets a projectile into the magnet room.',
      corrective: 'Classify items with no MR labelling, or an MR Unsafe label, as MR Unsafe.',
    },
    'R-EQ-06': {
      category: 'equipment', severity: 'major', basis: 'ACR',
      title: 'Item moved toward Zone IV before its MR status was determined',
      why: 'Nothing should enter Zone IV until its MR status is known.',
      corrective: 'Inspect and classify the item first.',
    },
    'R-ACC-01': {
      category: 'access', severity: 'critical', basis: 'ACR',
      title: 'Personal metallic items not removed before Zone IV',
      why: 'Phones, hair clips, keys and similar items can become projectiles, heat up, or be damaged by the field.',
      corrective: 'Inspect the patient, remove and store personal items in the locker, then repeat the access check.',
    },
    'R-ACC-02': {
      category: 'access', severity: 'major', basis: 'LOCAL',
      title: 'Patient not checked at the Zone IV door',
      why: 'A final visual and verbal check at the door catches items added after screening (for example a phone picked up while waiting).',
      corrective: 'Select the patient on the table to perform the final check before attesting room access.',
    },
    'R-SEQ-01': {
      category: 'sequence', severity: 'major', basis: 'LOCAL',
      title: 'Step attempted before its prerequisites',
      why: 'The procedure is ordered so that each sign-off rests on checks already completed.',
      corrective: 'Complete the earlier checkpoints first. The procedure list shows which ones are open.',
    },
    'R-SEQ-02': {
      category: 'access', severity: 'critical', basis: 'ACR',
      title: 'Zone IV access attempted before screening and equipment clearance',
      why: 'Only screened patients and cleared equipment may enter Zone IV.',
      corrective: 'Finish screening sign-off and equipment verification before the room access check.',
    },
    'R-SCAN-01': {
      category: 'sequence', severity: 'critical', basis: 'LOCAL',
      title: 'Scan started without final safety clearance',
      why: 'The final clearance confirms nothing changed since the earlier checks. Starting without it skips the last barrier.',
      corrective: 'Complete the final safety clearance (T4), then proceed to scan.',
    },
  };
  for (const id of Object.keys(RULES)) {
    RULES[id].id = id;
    RULES[id].status = 'illustrative';
    RULES[id].basisText = BASIS[RULES[id].basis];
  }

  /* ---------------------------------------------------------------
   * 3. Items, patients, scenarios
   * ------------------------------------------------------------- */
  const ITEMS = {
    o2: {
      name: 'Oxygen cylinder on trolley', truth: 'MR_UNSAFE', labelShown: null,
      material: 'Steel cylinder, steel trolley frame',
      note: 'No MR labelling on the cylinder or the trolley. Status unknown.',
    },
    wheelchair: {
      name: 'Transport wheelchair', truth: 'MR_UNSAFE', labelShown: 'MR_UNSAFE',
      material: 'Steel frame',
      note: 'Labelled MR Unsafe.',
    },
    ivpole: {
      name: 'IV pole', truth: 'MR_CONDITIONAL', labelShown: 'MR_CONDITIONAL',
      material: 'Aluminium and plastic',
      note: 'Labelled MR Conditional. Conditions of use are listed in the manufacturer\'s documentation.',
    },
    pads: {
      name: 'Foam positioning pads', truth: 'MR_SAFE', labelShown: 'MR_SAFE',
      material: 'Polyurethane foam, no metal',
      note: 'Labelled MR Safe.',
    },
    pump: {
      name: 'Infusion pump', truth: 'MR_UNSAFE', labelShown: null,
      material: 'Electronic device in a metal housing',
      note: 'No MR labelling found. Status unknown.',
    },
  };

  const PERSONAL_ITEMS = {
    hairclip: { name: 'Metal hair clip' },
    phone:    { name: 'Mobile phone in gown pocket' },
  };

  const BASE_PATIENT = {
    name: 'Training Patient A', mrn: 'TR-00417', dob: '1984-03-12',
    exam: 'MRI brain without contrast (training case)',
    fictional: true,
  };

  const IMPLANT_CIED = {
    type: 'Cardiac implantable electronic device',
    card: 'Patient carries a device card that states "MR Conditional".',
  };

  const ALL_CHECKPOINTS = ['SCREENING', 'EQUIPMENT', 'ACCESS', 'CLEARANCE', 'SCAN'];

  const SCENARIOS = {
    guided: {
      title: 'Guided practice', level: 1, hints: true, kind: 'core',
      summary: 'Full pre-scan preparation with the next step highlighted.',
      checkpoints: ALL_CHECKPOINTS,
      patient: { implant: null, personal: [] },
      items: { pads: 'ZONE_IV', o2: 'ZONE_II', ivpole: 'ZONE_II' },
    },
    standard: {
      title: 'Standard pre-scan', level: 2, hints: false, kind: 'core',
      summary: 'Full pre-scan preparation. One hazard has been left in the magnet room.',
      checkpoints: ALL_CHECKPOINTS,
      patient: { implant: null, personal: ['hairclip'] },
      items: { o2: 'ZONE_IV', pads: 'ZONE_IV', ivpole: 'ZONE_II', wheelchair: 'ZONE_II' },
    },
    complex: {
      title: 'Complex pre-scan', level: 3, hints: false, kind: 'core',
      summary: 'Implant on the screening form, personal items, and several hazards.',
      checkpoints: ALL_CHECKPOINTS,
      patient: { implant: IMPLANT_CIED, personal: ['phone', 'hairclip'] },
      items: { o2: 'ZONE_IV', ivpole: 'ZONE_IV', pads: 'ZONE_IV', wheelchair: 'ZONE_II', pump: 'ZONE_II' },
    },
    'drill-equipment': {
      title: 'Equipment classification drill', level: 2, hints: false, kind: 'drill',
      summary: 'Classify every item by its labelling and clear Zone IV.',
      checkpoints: ['EQUIPMENT'],
      patient: { implant: null, personal: [] },
      items: { o2: 'ZONE_IV', pump: 'ZONE_IV', ivpole: 'ZONE_IV', wheelchair: 'ZONE_II', pads: 'ZONE_II' },
    },
    'drill-screening': {
      title: 'Screening drill', level: 2, hints: false, kind: 'drill',
      summary: 'Identity check, form review and implant referral.',
      checkpoints: ['SCREENING'],
      patient: { implant: IMPLANT_CIED, personal: [] },
      items: {},
    },
  };
  const PROGRESSION = { guided: 'standard', standard: 'complex', complex: 'complex' };

  /* ---------------------------------------------------------------
   * 4. Checkpoints and requirement checks
   * Each check returns null when satisfied, or { rule, subject, evidence, focus }.
   * ------------------------------------------------------------- */
  const CHECKPOINTS = {
    SCREENING: {
      id: 'SCREENING', event: 'SCREENING_CHECK', pad: 'T1', stage: 1,
      title: 'Screening sign-off', detail: 'Identity, screening form and implant review',
      prereqs: [], prereqRule: 'R-SEQ-01',
      requires: ['idConfirmed', 'formReviewed', 'implantResolved'],
    },
    EQUIPMENT: {
      id: 'EQUIPMENT', event: 'VERIFY_EQUIPMENT', pad: 'T2', stage: 2,
      title: 'Equipment verification', detail: 'Every item classified, Zone IV clear',
      prereqs: [], prereqRule: 'R-SEQ-01',
      requires: ['allClassified', 'classificationsCorrect', 'noUnsafeInZoneIV', 'conditionalConfirmed'],
    },
    ACCESS: {
      id: 'ACCESS', event: 'ROOM_ACCESS', pad: 'T3', stage: 3,
      title: 'Zone IV access check', detail: 'Final patient check at the door',
      prereqs: ['SCREENING', 'EQUIPMENT'], prereqRule: 'R-SEQ-02',
      requires: ['patientChecked', 'personalRemoved'],
    },
    CLEARANCE: {
      id: 'CLEARANCE', event: 'SAFETY_CLEARANCE', pad: 'T4', stage: 4,
      title: 'Final safety clearance', detail: 'Re-check that nothing changed',
      prereqs: ['ACCESS'], prereqRule: 'R-SEQ-01',
      requires: ['noUnsafeInZoneIV', 'conditionalConfirmed', 'personalRemoved'],
    },
    SCAN: {
      id: 'SCAN', event: 'PROCEED_TO_SCAN', pad: 'T5', stage: 5,
      title: 'Proceed to scan', detail: 'Table moves into the bore',
      prereqs: ['CLEARANCE'], prereqRule: 'R-SCAN-01',
      requires: [],
    },
  };
  const CHECKPOINT_BY_EVENT = Object.fromEntries(Object.values(CHECKPOINTS).map(c => [c.event, c.id]));

  const itemName = id => (ITEMS[id] ? ITEMS[id].name : id);
  const labelText = l => (LABELS[l] ? LABELS[l].text : 'unclassified');

  const CHECKS = {
    idConfirmed: s => s.patient.idConfirmed ? null : {
      rule: 'R-ID-01', subject: 'patient',
      evidence: 'Patient identifiers had not been confirmed against the request.',
      hint: 'Open the patient record and confirm the two identifiers.', focus: 'record',
    },
    formReviewed: s => s.patient.formReviewed ? null : {
      rule: 'R-SCR-01', subject: 'patient',
      evidence: 'The MR screening form had not been opened.',
      hint: 'Open the patient record to review the MR screening form.', focus: 'record',
    },
    implantResolved: s => (!s.patient.implant || s.patient.implantResolved) ? null : {
      rule: 'R-SCR-02', subject: 'implant',
      evidence: `The form reports a ${s.patient.implant.type.toLowerCase()} that had not been referred for review.`,
      hint: 'The form lists an implant. Decide how to handle it in the patient record.', focus: 'record',
    },
    allClassified: s => {
      const open = Object.keys(s.items).filter(id => !s.items[id].classifiedAs);
      return open.length === 0 ? null : {
        rule: 'R-EQ-01', subject: 'items',
        evidence: `Not yet classified: ${open.map(itemName).join(', ')}.`,
        hint: `Select the ${itemName(open[0]).toLowerCase()} and classify it from its label.`, focus: open[0],
      };
    },
    classificationsCorrect: s => {
      const wrong = Object.keys(s.items).filter(id => s.items[id].classifiedAs && s.items[id].classifiedAs !== ITEMS[id].truth);
      return wrong.length === 0 ? null : {
        rule: 'R-EQ-02', subject: 'items:' + wrong.join(','),
        evidence: wrong.map(id => `${itemName(id)} is classified as ${labelText(s.items[id].classifiedAs)}`).join('; ') + '.',
        hint: `Re-check the label on the ${itemName(wrong[0]).toLowerCase()}.`, focus: wrong[0],
      };
    },
    noUnsafeInZoneIV: s => {
      const bad = Object.keys(s.items).filter(id => s.items[id].zone === 'ZONE_IV' && ITEMS[id].truth === 'MR_UNSAFE');
      return bad.length === 0 ? null : {
        rule: 'R-EQ-03', subject: 'zone4:' + bad.join(','),
        evidence: `${bad.map(itemName).join(', ')} ${bad.length > 1 ? 'were' : 'was'} still inside Zone IV.`,
        hint: `Move the ${itemName(bad[0]).toLowerCase()} out of the magnet room.`, focus: bad[0],
      };
    },
    conditionalConfirmed: s => {
      const bad = Object.keys(s.items).filter(id => s.items[id].zone === 'ZONE_IV' && ITEMS[id].truth === 'MR_CONDITIONAL' && !s.items[id].conditionsConfirmed);
      return bad.length === 0 ? null : {
        rule: 'R-EQ-04', subject: 'cond:' + bad.join(','),
        evidence: `${bad.map(itemName).join(', ')} is in Zone IV and its MR Conditional conditions were not confirmed.`,
        hint: `Confirm the conditions for the ${itemName(bad[0]).toLowerCase()}, or move it out.`, focus: bad[0],
      };
    },
    patientChecked: s => s.patient.checked ? null : {
      rule: 'R-ACC-02', subject: 'patient',
      evidence: 'The patient was not checked at the Zone IV door.',
      hint: 'Select the patient on the table for the final door check.', focus: 'patient',
    },
    personalRemoved: s => {
      const left = s.patient.personal.filter(p => !p.removed);
      return left.length === 0 ? null : {
        rule: 'R-ACC-01', subject: 'personal',
        evidence: `${left.map(p => PERSONAL_ITEMS[p.id].name).join(', ')} still with the patient.`,
        hint: 'Inspect the patient and remove personal items.', focus: 'patient',
      };
    },
  };

  const REQ_LABELS = {
    idConfirmed: 'Two identifiers confirmed',
    formReviewed: 'Screening form reviewed',
    implantResolved: 'Implant referred for review (if reported)',
    allClassified: 'Every item classified',
    classificationsCorrect: 'Classifications match labelling',
    noUnsafeInZoneIV: 'No MR Unsafe item in Zone IV',
    conditionalConfirmed: 'Conditional items in Zone IV checked',
    patientChecked: 'Patient checked at the door',
    personalRemoved: 'Personal items removed',
  };

  /* ---------------------------------------------------------------
   * 5. Attempt — deterministic state machine for one scenario run
   * ------------------------------------------------------------- */
  function defaultClock() { return Date.now(); }

  function validateEvent(evt) {
    if (!evt || typeof evt !== 'object') return 'Event must be an object.';
    if (typeof evt.event !== 'string') return 'Event name missing.';
    const name = EVENT_ALIASES[evt.event] || evt.event;
    if (!ALL_EVENTS.includes(name)) return `Unknown event "${evt.event}".`;
    if (evt.src !== undefined && !SOURCES.includes(evt.src)) return `Unknown source "${evt.src}".`;
    if (['CLASSIFY', 'CONFIRM_CONDITIONS', 'MOVE', 'REMOVE_PERSONAL_ITEM', 'INSPECT'].includes(name) && typeof evt.target !== 'string') {
      return `${name} needs a target.`;
    }
    if (name === 'CLASSIFY' && !LABELS[evt.value]) return `CLASSIFY value must be one of ${Object.keys(LABELS).join(', ')}.`;
    if (name === 'MOVE' && !ZONES[evt.value]) return `MOVE value must be one of ${Object.keys(ZONES).join(', ')}.`;
    if (name === 'IMPLANT_DECISION' && !['ESCALATE', 'PROCEED_ON_CARD', 'IGNORE'].includes(evt.value)) return 'IMPLANT_DECISION value is not recognised.';
    return null;
  }

  class Attempt {
    constructor(scenarioId, opts = {}) {
      const sc = SCENARIOS[scenarioId];
      if (!sc) throw new Error(`Unknown scenario "${scenarioId}"`);
      this.scenarioId = scenarioId;
      this.scenario = sc;
      this.clock = opts.clock || defaultClock;
      this.attemptNo = opts.attemptNo || 1;
      this.startedAt = this.clock();
      this.endedAt = null;
      this.status = 'active'; // active | completed | reset | switched
      this.log = [];
      this.deductions = {};   // key "rule|subject" -> points (each pair penalised once)
      this.checkpoints = {};
      for (const id of sc.checkpoints) this.checkpoints[id] = { status: 'open', completedAt: null, incorrect: 0, repeats: 0 };
      this.patient = {
        ...BASE_PATIENT,
        implant: sc.patient.implant,
        personal: sc.patient.personal.map(id => ({ id, removed: false })),
        idConfirmed: false, formReviewed: false, implantResolved: false, implantDecision: null, checked: false,
      };
      this.items = {};
      for (const [id, zone] of Object.entries(sc.items)) {
        this.items[id] = { zone, startZone: zone, inspected: false, classifiedAs: null, conditionsConfirmed: false };
      }
    }

    /* Order of checkpoints as defined by the scenario. */
    get order() { return this.scenario.checkpoints; }

    isComplete() { return this.order.every(id => this.checkpoints[id].status === 'done'); }

    score() {
      const lost = Object.values(this.deductions).reduce((a, b) => a + b, 0);
      return Math.max(0, SCORING.start - lost);
    }

    violations() { return this.log.flatMap(o => o.violations.map(v => ({ ...v, n: o.n, at: o.at }))); }

    criticalCount() {
      // Unique critical (rule|subject) pairs
      const keys = new Set(this.violations().filter(v => v.severity === 'critical').map(v => v.rule + '|' + v.subject));
      return keys.size;
    }

    passed() {
      return this.isComplete() && this.score() >= SCORING.passMinScore && this.criticalCount() <= SCORING.passMaxCritical;
    }

    _violation(check) {
      const r = RULES[check.rule];
      const key = check.rule + '|' + check.subject;
      const first = !(key in this.deductions);
      const points = first ? SEVERITY[r.severity].points : 0;
      if (first) this.deductions[key] = points;
      return {
        rule: r.id, severity: r.severity, category: r.category, title: r.title,
        subject: check.subject, evidence: check.evidence, why: r.why, corrective: r.corrective,
        points, repeat: !first, status: r.status, basis: r.basisText,
      };
    }

    _unmet(checkpointId) {
      return CHECKPOINTS[checkpointId].requires.map(name => CHECKS[name](this)).filter(Boolean);
    }

    /* Per-requirement status for one checkpoint (used by guided mode and the trainer view). */
    requirementStatus(cpId) {
      return CHECKPOINTS[cpId].requires.map(name => ({ name, label: REQ_LABELS[name], ok: !CHECKS[name](this) }));
    }

    /* Next step guidance — used for guided mode and the trainer view. */
    nextHint() {
      if (this.status !== 'active') return null;
      for (const id of this.order) {
        const cp = this.checkpoints[id];
        if (cp.status === 'done') continue;
        const missing = CHECKPOINTS[id].prereqs.filter(p => this.checkpoints[p] && this.checkpoints[p].status !== 'done');
        if (missing.length) continue;
        const unmet = this._unmet(id);
        if (unmet.length) return { checkpoint: id, text: unmet[0].hint, focus: unmet[0].focus };
        const def = CHECKPOINTS[id];
        return { checkpoint: id, text: `Ready: touch ${def.pad} (${def.title}).`, focus: 'pad:' + def.pad };
      }
      return null;
    }

    /* Main entry point. Always returns an outcome record; never throws for bad input. */
    handle(raw) {
      const at = this.clock() - this.startedAt;
      const evt = raw && typeof raw === 'object' ? { ...raw } : { event: raw };
      if (typeof evt.event === 'string' && EVENT_ALIASES[evt.event]) evt.event = EVENT_ALIASES[evt.event];
      const o = {
        n: this.log.length + 1, at, wall: new Date(this.clock()).toISOString(),
        src: evt.src || 'test', devSeq: Number.isInteger(evt.seq) ? evt.seq : null, pad: evt.pad || null,
        event: typeof evt.event === 'string' ? evt.event : String(evt.event),
        target: evt.target || null, value: evt.value || null,
        received: true, accepted: false, checkpointCompleted: null,
        violations: [], notes: [], error: null, feedbackShown: false, effects: [],
      };
      this.log.push(o);

      const invalid = validateEvent(evt);
      if (invalid) { o.error = 'INVALID_EVENT'; o.notes.push(invalid); return o; }
      if (this.status !== 'active') { o.error = 'ATTEMPT_CLOSED'; o.notes.push('This attempt has ended. Start a new attempt.'); return o; }

      if (evt.event === 'RESET_SCENARIO') {
        // Handled by Session; an Attempt on its own just records it.
        o.accepted = true; o.notes.push('Reset requested.');
        return o;
      }
      if (ATTEST_EVENTS.includes(evt.event)) return this._attest(o, evt);
      return this._scene(o, evt);
    }

    _attest(o, evt) {
      const cpId = CHECKPOINT_BY_EVENT[evt.event];
      const cp = this.checkpoints[cpId];
      const def = CHECKPOINTS[cpId];
      if (!cp) {
        o.error = 'NOT_IN_SCENARIO';
        o.notes.push(`${def.title} is not part of this scenario.`);
        return o;
      }
      if (cp.status === 'done') {
        cp.repeats++;
        o.notes.push(`${def.title} was already completed. Repeat touch recorded, no change.`);
        return o;
      }
      // Prerequisites (only those included in this scenario)
      const missing = def.prereqs.filter(p => this.checkpoints[p] && this.checkpoints[p].status !== 'done');
      if (missing.length) {
        cp.incorrect++;
        o.violations.push(this._violation({
          rule: def.prereqRule, subject: cpId,
          evidence: `${def.pad} (${def.title}) was touched while ${missing.map(m => CHECKPOINTS[m].title).join(' and ')} ${missing.length > 1 ? 'were' : 'was'} still open.`,
        }));
        o.canProceed = false;
        return o;
      }
      const unmet = this._unmet(cpId);
      if (unmet.length) {
        cp.incorrect++;
        for (const u of unmet) {
          o.violations.push(this._violation({ ...u, evidence: `${def.pad} (${def.title}) was touched while this was unresolved: ${u.evidence}` }));
        }
        o.canProceed = false;
        return o;
      }
      cp.status = 'done';
      cp.completedAt = o.at;
      o.accepted = true;
      o.checkpointCompleted = cpId;
      o.canProceed = true;
      o.effects.push({ type: 'checkpoint', id: cpId });
      if (cpId === 'SCAN') o.effects.push({ type: 'scan' });
      if (this.isComplete()) {
        this.status = 'completed';
        this.endedAt = this.clock();
        o.effects.push({ type: 'complete' });
      }
      return o;
    }

    _scene(o, evt) {
      const p = this.patient;
      switch (evt.event) {
        case 'CONFIRM_ID':
          if (p.idConfirmed) { o.notes.push('Identifiers already confirmed.'); return o; }
          p.idConfirmed = true; o.accepted = true; o.notes.push('Two identifiers confirmed against the request.');
          return o;

        case 'INSPECT': {
          const t = evt.target;
          if (t === 'record') { o.accepted = true; if (!p.formReviewed) { p.formReviewed = true; o.notes.push('Screening form opened.'); } return o; }
          if (t === 'patient') { o.accepted = true; if (!p.checked) { p.checked = true; o.notes.push('Patient checked.'); } return o; }
          if (this.items[t]) { o.accepted = true; this.items[t].inspected = true; return o; }
          // Other scene objects (gantry, console, door): informational only
          o.accepted = true; o.notes.push('Viewed ' + t + '.');
          return o;
        }

        case 'IMPLANT_DECISION':
          if (!p.implant) { o.error = 'NO_IMPLANT'; o.notes.push('No implant is reported for this patient.'); return o; }
          if (p.implantResolved) { o.notes.push('Implant already referred.'); return o; }
          p.implantDecision = evt.value;
          if (evt.value === 'ESCALATE') {
            p.implantResolved = true; o.accepted = true;
            o.notes.push('Implant referred to the MR safety officer / supervising radiologist. Simulated outcome: review completed, scan may proceed under the labelled conditions.');
            return o;
          }
          o.violations.push(this._violation({
            rule: 'R-SCR-02', subject: 'implant',
            evidence: evt.value === 'PROCEED_ON_CARD'
              ? 'You chose to proceed on the strength of the patient\'s device card alone.'
              : 'You chose to disregard the implant reported on the screening form.',
          }));
          o.canProceed = false;
          return o;

        case 'CLASSIFY': {
          const it = this.items[evt.target];
          if (!it) { o.error = 'UNKNOWN_TARGET'; o.notes.push('No such item in this scenario.'); return o; }
          it.classifiedAs = evt.value; it.inspected = true;
          o.accepted = true;
          const truth = ITEMS[evt.target].truth;
          if (evt.value !== truth) {
            const critical = truth === 'MR_UNSAFE';
            o.violations.push(this._violation({
              rule: critical ? 'R-EQ-05' : 'R-EQ-02', subject: 'class:' + evt.target,
              evidence: `${itemName(evt.target)} was classified as ${labelText(evt.value)}. ${ITEMS[evt.target].note}`,
            }));
          } else {
            o.notes.push(`${itemName(evt.target)} classified as ${labelText(evt.value)}.`);
          }
          if (truth !== 'MR_CONDITIONAL') it.conditionsConfirmed = false;
          return o;
        }

        case 'CONFIRM_CONDITIONS': {
          const it = this.items[evt.target];
          if (!it) { o.error = 'UNKNOWN_TARGET'; o.notes.push('No such item in this scenario.'); return o; }
          if (it.classifiedAs !== 'MR_CONDITIONAL') { o.notes.push('Classify the item as MR Conditional before confirming conditions.'); return o; }
          if (ITEMS[evt.target].truth !== 'MR_CONDITIONAL') { o.notes.push('This item is not MR Conditional; there are no conditions to confirm.'); return o; }
          it.conditionsConfirmed = true; o.accepted = true;
          o.notes.push(`Conditions for ${itemName(evt.target).toLowerCase()} confirmed against its labelling (simulated).`);
          return o;
        }

        case 'MOVE': {
          const it = this.items[evt.target];
          if (!it) { o.error = 'UNKNOWN_TARGET'; o.notes.push('No such item in this scenario.'); return o; }
          if (it.zone === evt.value) { o.notes.push('Item is already there.'); return o; }
          if (evt.value === 'ZONE_IV') {
            const truth = ITEMS[evt.target].truth;
            let check = null;
            if (truth === 'MR_UNSAFE') check = { rule: 'R-EQ-03', subject: 'move:' + evt.target, evidence: `You tried to move the ${itemName(evt.target).toLowerCase()} into Zone IV. The move was blocked.` };
            else if (!it.classifiedAs) check = { rule: 'R-EQ-06', subject: 'move:' + evt.target, evidence: `You tried to move the ${itemName(evt.target).toLowerCase()} into Zone IV before classifying it. The move was blocked.` };
            else if (truth === 'MR_CONDITIONAL' && !it.conditionsConfirmed) check = { rule: 'R-EQ-04', subject: 'move:' + evt.target, evidence: `You tried to move the ${itemName(evt.target).toLowerCase()} into Zone IV before confirming its conditions. The move was blocked.` };
            if (check) { o.violations.push(this._violation(check)); o.canProceed = false; return o; }
          }
          it.zone = evt.value; o.accepted = true;
          o.effects.push({ type: 'move', id: evt.target, zone: evt.value });
          o.notes.push(`${itemName(evt.target)} moved to ${ZONES[evt.value].text}.`);
          return o;
        }

        case 'REMOVE_PERSONAL_ITEM': {
          const item = p.personal.find(x => x.id === evt.target);
          if (!item) { o.error = 'UNKNOWN_TARGET'; o.notes.push('The patient does not have that item.'); return o; }
          if (item.removed) { o.notes.push('Already removed.'); return o; }
          item.removed = true; o.accepted = true;
          o.effects.push({ type: 'personal', id: evt.target });
          o.notes.push(`${PERSONAL_ITEMS[evt.target].name} removed and stored in the locker.`);
          return o;
        }
      }
      o.error = 'UNHANDLED'; return o;
    }

    markFeedbackShown(n) { const o = this.log[n - 1]; if (o) o.feedbackShown = true; }

    close(status) {
      if (this.status === 'active') { this.status = status; this.endedAt = this.clock(); }
    }

    summary() {
      const v = this.violations();
      const byCategory = {};
      for (const x of v) if (!x.repeat) byCategory[x.category] = (byCategory[x.category] || 0) + 1;
      const correct = this.log.filter(o => o.accepted && o.violations.length === 0 && !o.error).length;
      const incorrect = this.log.filter(o => o.violations.length > 0).length;
      return {
        scenarioId: this.scenarioId, scenarioTitle: this.scenario.title, attemptNo: this.attemptNo,
        status: this.status, completed: this.isComplete(), passed: this.passed(),
        score: this.score(), criticalCount: this.criticalCount(),
        durationMs: (this.endedAt || this.clock()) - this.startedAt,
        correctActions: correct, incorrectActions: incorrect, events: this.log.length,
        violationsUnique: Object.keys(this.deductions).length, byCategory,
        criticalCategories: [...new Set(v.filter(x => x.severity === 'critical').map(x => x.category))],
        checkpoints: Object.fromEntries(this.order.map(id => [id, { ...this.checkpoints[id] }])),
      };
    }
  }

  /* ---------------------------------------------------------------
   * 6. Session — a trainee's run of attempts
   * ------------------------------------------------------------- */
  let _sessionCounter = 0;
  function makeSessionId(clock) {
    _sessionCounter++;
    const d = new Date(clock());
    const pad = n => String(n).padStart(2, '0');
    return `S-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${_sessionCounter}`;
  }

  class Session {
    constructor(opts = {}) {
      this.clock = opts.clock || defaultClock;
      this.id = opts.id || makeSessionId(this.clock);
      this.trainee = opts.trainee || 'Trainee 01';
      this.startedAt = this.clock();
      this.attempts = [];
      this.recommendations = [];
      this.start(opts.scenarioId || 'standard');
    }
    get current() { return this.attempts[this.attempts.length - 1]; }
    retriesFor(scenarioId) { return this.attempts.filter(a => a.scenarioId === scenarioId && a.status === 'reset').length; }
    get totalRetries() { return this.attempts.filter(a => a.status === 'reset').length; }

    /* closeAs: 'reset' (trainee retry, counted) or 'switched' (trainer changed scenario, not counted). */
    start(scenarioId, closeAs = 'switched') {
      if (this.current) this.current.close(closeAs);
      const n = this.attempts.filter(a => a.scenarioId === scenarioId).length + 1;
      const a = new Attempt(scenarioId, { clock: this.clock, attemptNo: n });
      this.attempts.push(a);
      return a;
    }

    handle(evt) {
      const a = this.current;
      const out = a.handle(evt);
      if (out.accepted && (out.event === 'RESET_SCENARIO')) {
        out.effects.push({ type: 'reset' });
        this.start(a.scenarioId, 'reset');
        out.notes.push(`Attempt ${a.attemptNo} closed as reset. Attempt ${this.current.attemptNo} started.`);
      }
      if (out.effects.some(e => e.type === 'complete')) {
        const rec = recommendNext(this.results());
        rec.afterAttempt = this.attempts.length;
        this.recommendations.push(rec);
        out.recommendation = rec;
      }
      return out;
    }

    /* Completed attempts only (resets are counted as retries, not results). */
    results() { return this.attempts.filter(a => a.status === 'completed').map(a => a.summary()); }

    report() {
      return {
        kind: 'MRISafeTwin.sessionReport', version: 1,
        disclaimer: 'Educational prototype. Rules are illustrative and not a substitute for local MR safety procedures or certification.',
        sessionId: this.id, trainee: this.trainee,
        startedAt: new Date(this.startedAt).toISOString(), exportedAt: new Date(this.clock()).toISOString(),
        dataOrigin: 'Recorded in this browser session (not demonstration data).',
        scoring: { ...SCORING, severityPoints: Object.fromEntries(Object.entries(SEVERITY).map(([k, v]) => [k, v.points])), dedupe: 'Each rule is penalised once per subject per attempt; repeats are logged with 0 points.' },
        totalRetries: this.totalRetries,
        attempts: this.attempts.map(a => ({ ...a.summary(), log: a.log, violations: a.violations() })),
        recommendations: this.recommendations,
      };
    }
  }

  /* ---------------------------------------------------------------
   * 7. Adaptive scenario selection (transparent, rule-ordered)
   * ------------------------------------------------------------- */
  const ADAPT_RULES = [
    { id: 'AD-1', text: 'Two consecutive attempts did not pass → guided practice with hints.' },
    { id: 'AD-2', text: 'Passed → unlock the next level (drills return to the last full scenario).' },
    { id: 'AD-3', text: 'Not passed with a critical or ≥2 equipment violations → equipment classification drill.' },
    { id: 'AD-4', text: 'Not passed with a critical or ≥2 screening violations → screening drill.' },
    { id: 'AD-5', text: 'Otherwise → repeat the same scenario.' },
  ];

  function recommendNext(results) {
    if (!results.length) return { scenarioId: 'guided', rule: 'AD-0', reason: 'No completed attempts yet; starting with guided practice.' };
    const last = results[results.length - 1];
    const prev = results[results.length - 2];
    const lastCore = [...results].reverse().find(r => SCENARIOS[r.scenarioId].kind === 'core');
    const pick = (scenarioId, rule, reason) => ({ scenarioId, rule, reason, basedOn: { scenarioId: last.scenarioId, score: last.score, passed: last.passed, byCategory: last.byCategory } });

    if (!last.passed && prev && !prev.passed && last.scenarioId !== 'guided') {
      return pick('guided', 'AD-1', `Attempts ${results.length - 1} and ${results.length} did not pass. Guided practice shows each next step.`);
    }
    if (last.passed) {
      if (SCENARIOS[last.scenarioId].kind === 'drill') {
        const back = lastCore ? lastCore.scenarioId : 'standard';
        return pick(back, 'AD-2', `Drill passed (score ${last.score}). Returning to ${SCENARIOS[back].title}.`);
      }
      const next = PROGRESSION[last.scenarioId];
      return pick(next, 'AD-2', next === last.scenarioId
        ? `Passed ${SCENARIOS[last.scenarioId].title} (score ${last.score}). Highest level reached; repeat to consolidate.`
        : `Passed ${SCENARIOS[last.scenarioId].title} with no critical violations (score ${last.score}). Unlocking ${SCENARIOS[next].title}.`);
    }
    const cat = last.byCategory || {};
    const v = results.length; // completed-attempt index for messages
    const critIn = c => (last.criticalCategories || []).includes(c);
    if ((cat.equipment || 0) >= 2 || critIn('equipment')) {
      return pick('drill-equipment', 'AD-3', `Attempt ${v} had ${cat.equipment || 0} equipment violation(s). A focused classification drill comes next.`);
    }
    if ((cat.screening || 0) >= 2 || critIn('screening')) {
      return pick('drill-screening', 'AD-4', `Attempt ${v} had ${cat.screening || 0} screening violation(s). A focused screening drill comes next.`);
    }
    return pick(last.scenarioId, 'AD-5', `Attempt ${v} did not pass (score ${last.score}, ${last.criticalCount} critical). Repeating ${SCENARIOS[last.scenarioId].title}.`);
  }

  /* ---------------------------------------------------------------
   * 8. Serial protocol (newline-delimited JSON, v1)
   * ------------------------------------------------------------- */
  const DEVICE_TYPES = ['hello', 'action', 'hb', 'cal', 'err', 'raw', 'log', 'pong', 'imu', 'gesture'];
  const GESTURES = ['tap', 'double_tap', 'flick_left', 'flick_right'];
  const MAX_LINE = 512;

  function parseLine(line) {
    if (typeof line !== 'string') return { ok: false, error: 'NOT_TEXT' };
    const s = line.trim();
    if (!s) return { ok: false, error: 'EMPTY' };
    if (s.length > MAX_LINE) return { ok: false, error: 'TOO_LONG', raw: s.slice(0, 80) };
    if (s[0] !== '{') return { ok: false, error: 'NOT_JSON', raw: s.slice(0, 80) }; // boot ROM text, etc.
    let msg;
    try { msg = JSON.parse(s); } catch (e) { return { ok: false, error: 'BAD_JSON', raw: s.slice(0, 80) }; }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return { ok: false, error: 'NOT_OBJECT', raw: s.slice(0, 80) };
    if (msg.v !== undefined && msg.v !== PROTOCOL_VERSION) return { ok: false, error: 'VERSION_MISMATCH', raw: s.slice(0, 80) };
    if (!DEVICE_TYPES.includes(msg.type)) return { ok: false, error: 'UNKNOWN_TYPE', raw: s.slice(0, 80) };
    if (msg.type === 'action') {
      if (typeof msg.event === 'string' && EVENT_ALIASES[msg.event]) msg.event = EVENT_ALIASES[msg.event];
      if (!ATTEST_EVENTS.includes(msg.event)) return { ok: false, error: 'UNKNOWN_EVENT', raw: s.slice(0, 80) };
      if (msg.id !== undefined && PAD_EVENT[msg.id] !== msg.event) return { ok: false, error: 'PAD_EVENT_MISMATCH', raw: s.slice(0, 80) };
      if (!Number.isInteger(msg.seq) || msg.seq < 0) return { ok: false, error: 'BAD_SEQ', raw: s.slice(0, 80) };
    }
    if (msg.type === 'imu') {
      if (!Number.isFinite(msg.r) || !Number.isFinite(msg.p) || Math.abs(msg.r) > 180 || Math.abs(msg.p) > 180) return { ok: false, error: 'BAD_IMU', raw: s.slice(0, 80) };
    }
    if (msg.type === 'gesture') {
      if (!GESTURES.includes(msg.g)) return { ok: false, error: 'UNKNOWN_GESTURE', raw: s.slice(0, 80) };
      if (!Number.isInteger(msg.seq) || msg.seq < 0) return { ok: false, error: 'BAD_SEQ', raw: s.slice(0, 80) };
    }
    return { ok: true, msg };
  }

  /* Splits an arbitrary stream of text chunks into complete lines. */
  class LineBuffer {
    constructor() { this.buf = ''; }
    push(chunk) {
      this.buf += chunk;
      if (this.buf.length > MAX_LINE * 8) this.buf = this.buf.slice(-MAX_LINE); // runaway guard
      const parts = this.buf.split(/\r?\n/);
      this.buf = parts.pop();
      return parts;
    }
    reset() { this.buf = ''; }
  }

  /* Drops duplicate / replayed action messages using (boot, seq). */
  class SeqTracker {
    constructor() { this.boot = null; this.last = -1; }
    hello(boot) { if (boot !== this.boot) { this.boot = boot; this.last = -1; return 'new-boot'; } return 'same-boot'; }
    check(msg) {
      if (msg.boot !== undefined && msg.boot !== this.boot) this.hello(msg.boot);
      if (msg.seq <= this.last) return 'duplicate';
      const gap = this.last >= 0 && msg.seq > this.last + 1;
      this.last = msg.seq;
      return gap ? 'gap' : 'ok';
    }
  }

  /* ---------------------------------------------------------------
   * 9. Report export
   * ------------------------------------------------------------- */
  const CSV_COLUMNS = ['session', 'attempt', 'scenario', 'n', 't_ms', 'wall', 'source', 'device_seq', 'pad', 'event', 'target', 'value',
    'received', 'accepted', 'checkpoint_completed', 'violation_rules', 'severity', 'points', 'feedback_shown', 'notes', 'error'];

  function csvCell(v) {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function toCSV(session) {
    const rows = [CSV_COLUMNS.join(',')];
    session.attempts.forEach((a, i) => {
      for (const o of a.log) {
        rows.push([
          session.id, i + 1, a.scenarioId, o.n, o.at, o.wall, o.src, o.devSeq, o.pad, o.event, o.target, o.value,
          o.received, o.accepted, o.checkpointCompleted || '', o.violations.map(v => v.rule).join(' '),
          o.violations.map(v => v.severity).join(' '), o.violations.reduce((s, v) => s + v.points, 0),
          o.feedbackShown, o.notes.join(' | '), o.error || '',
        ].map(csvCell).join(','));
      }
    });
    return rows.join('\n');
  }

  return {
    PROTOCOL_VERSION, PADS, PAD_EVENT, ATTEST_EVENTS, SCENE_EVENTS, EVENT_ALIASES, LABELS, ZONES,
    SEVERITY, SCORING, RULES, REQ_LABELS, BASIS, ITEMS, PERSONAL_ITEMS, SCENARIOS, PROGRESSION, CHECKPOINTS, ADAPT_RULES,
    GESTURES, validateEvent, Attempt, Session, recommendNext, parseLine, LineBuffer, SeqTracker, toCSV,
  };
});
