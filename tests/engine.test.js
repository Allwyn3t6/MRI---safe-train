// Run with:  node --test tests/
// No dependencies. Uses Node's built-in test runner (Node 18+).
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../simulator/engine.js');

// Deterministic clock: advances 1 s per call.
function fakeClock(start = Date.UTC(2026, 9, 9, 6, 0, 0)) { let t = start; return () => (t += 1000); }
const attempt = id => new E.Attempt(id, { clock: fakeClock() });
const pad = (a, event) => a.handle({ event, src: 'test' });
const scene = (a, event, target, value) => a.handle({ event, target, value, src: 'scene' });

/* Correct path through the standard scenario. */
function solveStandard(a) {
  scene(a, 'INSPECT', 'record');
  scene(a, 'CONFIRM_ID');
  assert.equal(pad(a, 'SCREENING_CHECK').checkpointCompleted, 'SCREENING');
  for (const id of Object.keys(a.items)) scene(a, 'CLASSIFY', id, E.ITEMS[id].truth);
  scene(a, 'MOVE', 'o2', 'ZONE_II');
  assert.equal(pad(a, 'VERIFY_EQUIPMENT').checkpointCompleted, 'EQUIPMENT');
  scene(a, 'INSPECT', 'patient');
  scene(a, 'REMOVE_PERSONAL_ITEM', 'hairclip');
  assert.equal(pad(a, 'ROOM_ACCESS').checkpointCompleted, 'ACCESS');
  assert.equal(pad(a, 'SAFETY_CLEARANCE').checkpointCompleted, 'CLEARANCE');
  return pad(a, 'PROCEED_TO_SCAN');
}

test('correct sequence completes the standard scenario with full marks', () => {
  const a = attempt('standard');
  const last = solveStandard(a);
  assert.equal(last.checkpointCompleted, 'SCAN');
  assert.ok(last.effects.some(e => e.type === 'complete'));
  assert.equal(a.status, 'completed');
  assert.equal(a.score(), 100);
  assert.equal(a.passed(), true);
  assert.equal(a.violations().length, 0);
});

test('a touch is received but not accepted when requirements are unmet', () => {
  const a = attempt('standard');
  const o = pad(a, 'SCREENING_CHECK');
  assert.equal(o.received, true);
  assert.equal(o.accepted, false);
  assert.equal(o.checkpointCompleted, null);
  assert.deepEqual(o.violations.map(v => v.rule).sort(), ['R-ID-01', 'R-SCR-01']);
  assert.equal(a.checkpoints.SCREENING.status, 'open');
  assert.equal(a.checkpoints.SCREENING.incorrect, 1);
});

test('skipped prerequisite is a violation and blocks the transition', () => {
  const a = attempt('standard');
  const o = pad(a, 'ROOM_ACCESS');
  assert.equal(o.accepted, false);
  assert.equal(o.violations[0].rule, 'R-SEQ-02');
  assert.equal(o.violations[0].severity, 'critical');
  assert.equal(a.checkpoints.ACCESS.status, 'open');
});

test('proceeding to scan without clearance uses the scan rule', () => {
  const a = attempt('standard');
  const o = pad(a, 'PROCEED_TO_SCAN');
  assert.equal(o.violations[0].rule, 'R-SCAN-01');
  assert.equal(o.accepted, false);
});

test('repeated checkpoint touch is logged without penalty', () => {
  const a = attempt('standard');
  scene(a, 'INSPECT', 'record'); scene(a, 'CONFIRM_ID');
  pad(a, 'SCREENING_CHECK');
  const before = a.score();
  const o = pad(a, 'SCREENING_CHECK');
  assert.equal(o.accepted, false);
  assert.equal(o.violations.length, 0);
  assert.equal(a.checkpoints.SCREENING.repeats, 1);
  assert.equal(a.score(), before);
});

test('the same violation is penalised once per subject', () => {
  const a = attempt('standard');
  pad(a, 'ROOM_ACCESS');
  pad(a, 'ROOM_ACCESS');
  assert.equal(a.score(), 100 - E.SEVERITY.critical.points);
  const v = a.violations();
  assert.equal(v.length, 2);
  assert.equal(v[1].repeat, true);
  assert.equal(v[1].points, 0);
});

test('invalid and unknown events are rejected without crashing or penalty', () => {
  const a = attempt('standard');
  for (const bad of [null, 42, {}, { event: 'LAUNCH_ROCKET' }, { event: 'CLASSIFY', target: 'o2', value: 'SAFE-ISH' }, { event: 'MOVE', target: 'o2', value: 'ZONE_IX' }, { event: 'INSPECT' }]) {
    const o = a.handle(bad);
    assert.equal(o.received, true);
    assert.equal(o.accepted, false);
    assert.equal(o.error, 'INVALID_EVENT');
  }
  assert.equal(a.score(), 100);
});

test('unsafe item cannot be moved into Zone IV', () => {
  const a = attempt('standard');
  scene(a, 'CLASSIFY', 'wheelchair', 'MR_UNSAFE');
  const o = scene(a, 'MOVE', 'wheelchair', 'ZONE_IV');
  assert.equal(o.accepted, false);
  assert.equal(o.violations[0].rule, 'R-EQ-03');
  assert.equal(a.items.wheelchair.zone, 'ZONE_II');
});

test('equipment sign-off with the cylinder still in Zone IV fails with evidence', () => {
  const a = attempt('standard');
  for (const id of Object.keys(a.items)) scene(a, 'CLASSIFY', id, E.ITEMS[id].truth);
  const o = pad(a, 'VERIFY_EQUIPMENT');
  assert.equal(o.accepted, false);
  const v = o.violations.find(x => x.rule === 'R-EQ-03');
  assert.ok(v);
  assert.match(v.evidence, /Oxygen cylinder/);
});

test('classifying an unlabelled steel item as MR Safe is critical', () => {
  const a = attempt('standard');
  const o = scene(a, 'CLASSIFY', 'o2', 'MR_SAFE');
  assert.equal(o.accepted, true);            // the action was recorded...
  assert.equal(o.violations[0].rule, 'R-EQ-05'); // ...and flagged
  assert.equal(o.violations[0].severity, 'critical');
});

test('MR Conditional item in Zone IV needs conditions confirmed', () => {
  const a = attempt('complex');
  for (const id of Object.keys(a.items)) scene(a, 'CLASSIFY', id, E.ITEMS[id].truth);
  scene(a, 'MOVE', 'o2', 'ZONE_II');
  let o = pad(a, 'VERIFY_EQUIPMENT');
  assert.deepEqual(o.violations.map(v => v.rule), ['R-EQ-04']);
  scene(a, 'CONFIRM_CONDITIONS', 'ivpole');
  o = pad(a, 'VERIFY_EQUIPMENT');
  assert.equal(o.checkpointCompleted, 'EQUIPMENT');
});

test('implant: proceeding on the card is critical; escalation resolves it', () => {
  const a = attempt('complex');
  scene(a, 'INSPECT', 'record'); scene(a, 'CONFIRM_ID');
  let o = scene(a, 'IMPLANT_DECISION', null, 'PROCEED_ON_CARD');
  assert.equal(o.violations[0].rule, 'R-SCR-02');
  assert.equal(pad(a, 'SCREENING_CHECK').accepted, false);
  scene(a, 'IMPLANT_DECISION', null, 'ESCALATE');
  o = pad(a, 'SCREENING_CHECK');
  assert.equal(o.checkpointCompleted, 'SCREENING');
});

test('personal items block room access', () => {
  const a = attempt('complex');
  scene(a, 'INSPECT', 'record'); scene(a, 'CONFIRM_ID'); scene(a, 'IMPLANT_DECISION', null, 'ESCALATE');
  pad(a, 'SCREENING_CHECK');
  for (const id of Object.keys(a.items)) scene(a, 'CLASSIFY', id, E.ITEMS[id].truth);
  scene(a, 'MOVE', 'o2', 'ZONE_II'); scene(a, 'CONFIRM_CONDITIONS', 'ivpole');
  pad(a, 'VERIFY_EQUIPMENT');
  scene(a, 'INSPECT', 'patient');
  const o = pad(a, 'ROOM_ACCESS');
  assert.deepEqual(o.violations.map(v => v.rule), ['R-ACC-01']);
  scene(a, 'REMOVE_PERSONAL_ITEM', 'phone'); scene(a, 'REMOVE_PERSONAL_ITEM', 'hairclip');
  assert.equal(pad(a, 'ROOM_ACCESS').checkpointCompleted, 'ACCESS');
});

test('reset during a session closes the attempt and counts a retry', () => {
  const s = new E.Session({ clock: fakeClock(), scenarioId: 'standard' });
  s.handle({ event: 'INSPECT', target: 'record', src: 'scene' });
  const o = s.handle({ event: 'RESET_SCENARIO', src: 'hw', seq: 7 });
  assert.ok(o.effects.some(e => e.type === 'reset'));
  assert.equal(s.attempts.length, 2);
  assert.equal(s.attempts[0].status, 'reset');
  assert.equal(s.current.status, 'active');
  assert.equal(s.current.patient.formReviewed, false);
  assert.equal(s.totalRetries, 1);
  assert.equal(s.current.attemptNo, 2);
});

test('events after completion are rejected', () => {
  const a = attempt('standard');
  solveStandard(a);
  const o = pad(a, 'SCREENING_CHECK');
  assert.equal(o.error, 'ATTEMPT_CLOSED');
});

test('drill scenarios ignore checkpoints outside the drill', () => {
  const a = attempt('drill-screening');
  const o = pad(a, 'VERIFY_EQUIPMENT');
  assert.equal(o.error, 'NOT_IN_SCENARIO');
  assert.equal(o.violations.length, 0);
});

test('guided hints point at the next unmet requirement', () => {
  const a = attempt('guided');
  assert.equal(a.nextHint().focus, 'record');
  scene(a, 'INSPECT', 'record'); scene(a, 'CONFIRM_ID');
  assert.equal(a.nextHint().focus, 'pad:T1');
});

/* ---------------- adaptive selection ---------------- */

function completeWith(id, mutate) {
  const s = new E.Session({ clock: fakeClock(), scenarioId: id });
  mutate(s);
  return s;
}

test('adaptive: pass unlocks the next level', () => {
  const s = completeWith('standard', s => solveStandard(s.current));
  // solveStandard bypassed Session.handle; compute directly from results
  const rec = E.recommendNext(s.results());
  assert.equal(rec.scenarioId, 'complex');
  assert.equal(rec.rule, 'AD-2');
});

test('adaptive: critical equipment error triggers the equipment drill', () => {
  const a = attempt('standard');
  scene(a, 'CLASSIFY', 'o2', 'MR_SAFE');      // critical equipment
  for (const id of Object.keys(a.items)) scene(a, 'CLASSIFY', id, E.ITEMS[id].truth);
  scene(a, 'MOVE', 'o2', 'ZONE_II');
  scene(a, 'INSPECT', 'record'); scene(a, 'CONFIRM_ID');
  pad(a, 'SCREENING_CHECK'); pad(a, 'VERIFY_EQUIPMENT');
  scene(a, 'INSPECT', 'patient'); scene(a, 'REMOVE_PERSONAL_ITEM', 'hairclip');
  pad(a, 'ROOM_ACCESS'); pad(a, 'SAFETY_CLEARANCE'); pad(a, 'PROCEED_TO_SCAN');
  const sum = a.summary();
  assert.equal(sum.completed, true);
  assert.equal(sum.passed, false);
  const rec = E.recommendNext([sum]);
  assert.equal(rec.scenarioId, 'drill-equipment');
  assert.equal(rec.rule, 'AD-3');
});

test('adaptive: two failures in a row switch to guided practice', () => {
  const fail = { scenarioId: 'standard', passed: false, score: 60, criticalCount: 1, byCategory: { access: 1 }, criticalCategories: ['access'] };
  const rec = E.recommendNext([fail, fail]);
  assert.equal(rec.scenarioId, 'guided');
  assert.equal(rec.rule, 'AD-1');
});

test('adaptive: passed drill returns to the last full scenario', () => {
  const core = { scenarioId: 'complex', passed: false, score: 70, criticalCount: 1, byCategory: { screening: 1 }, criticalCategories: ['screening'] };
  const drill = { scenarioId: 'drill-screening', passed: true, score: 100, criticalCount: 0, byCategory: {}, criticalCategories: [] };
  const rec = E.recommendNext([core, drill]);
  assert.equal(rec.scenarioId, 'complex');
});

/* ---------------- serial protocol ---------------- */

test('parser accepts a valid action and normalises the alias', () => {
  let r = E.parseLine('{"v":1,"type":"action","id":"T1","event":"SCREENING_CHECK","seq":1,"t":1234}');
  assert.equal(r.ok, true);
  r = E.parseLine('{"type":"action","id":"T5","event":"START_SIMULATION","seq":2}');
  assert.equal(r.ok, true);
  assert.equal(r.msg.event, 'PROCEED_TO_SCAN');
});

test('parser rejects malformed, unknown and mismatched lines', () => {
  const cases = {
    '': 'EMPTY',
    'ESP-ROM:esp32s3-20210327': 'NOT_JSON',
    '{"type":"action","event":"SCREENING_CHECK","seq":1': 'BAD_JSON',
    '[1,2]': 'NOT_JSON',
    '{"v":2,"type":"action","event":"SCREENING_CHECK","seq":1}': 'VERSION_MISMATCH',
    '{"type":"telemetry"}': 'UNKNOWN_TYPE',
    '{"type":"action","event":"OPEN_DOOR","seq":1}': 'UNKNOWN_EVENT',
    '{"type":"action","id":"T2","event":"SCREENING_CHECK","seq":1}': 'PAD_EVENT_MISMATCH',
    '{"type":"action","event":"SCREENING_CHECK","seq":-1}': 'BAD_SEQ',
    '{"type":"action","event":"SCREENING_CHECK","seq":"3"}': 'BAD_SEQ',
  };
  for (const [line, err] of Object.entries(cases)) assert.equal(E.parseLine(line).error, err, line);
  assert.equal(E.parseLine('{' + 'x'.repeat(600) + '}').error, 'TOO_LONG');
});

test('line buffer reassembles lines split across chunks', () => {
  const b = new E.LineBuffer();
  assert.deepEqual(b.push('{"type":"hb"'), []);
  assert.deepEqual(b.push('}\r\n{"type":'), ['{"type":"hb"}']);
  assert.deepEqual(b.push('"hb"}\n'), ['{"type":"hb"}']);
});

test('sequence tracker drops duplicates and resets on a new boot id', () => {
  const t = new E.SeqTracker();
  t.hello(111);
  assert.equal(t.check({ seq: 1 }), 'ok');
  assert.equal(t.check({ seq: 1 }), 'duplicate');
  assert.equal(t.check({ seq: 0 }), 'duplicate');
  assert.equal(t.check({ seq: 4 }), 'gap');
  assert.equal(t.hello(222), 'new-boot');
  assert.equal(t.check({ seq: 1 }), 'ok');
});

/* ---------------- report ---------------- */

test('CSV export has one row per logged event and matches the log', () => {
  const s = new E.Session({ clock: fakeClock(), scenarioId: 'standard' });
  s.handle({ event: 'ROOM_ACCESS', src: 'hw', seq: 1, pad: 'T3' });
  s.handle({ event: 'INSPECT', target: 'record', src: 'scene' });
  const csv = E.toCSV(s).split('\n');
  assert.equal(csv.length, 1 + 2);
  assert.match(csv[1], /ROOM_ACCESS/);
  assert.match(csv[1], /R-SEQ-02/);
  const rep = s.report();
  assert.equal(rep.attempts[0].log.length, 2);
  assert.equal(rep.attempts[0].violations.length, 1);
});

test('trainer switching scenario is not counted as a retry', () => {
  const s = new E.Session({ clock: fakeClock(), scenarioId: 'standard' });
  s.start('complex', 'switched');
  assert.equal(s.attempts[0].status, 'switched');
  assert.equal(s.totalRetries, 0);
});

test('parser accepts IMU and gesture messages and rejects bad ones', () => {
  assert.equal(E.parseLine('{"v":1,"type":"imu","r":12.5,"p":-3.1,"gz":4,"mag":48.2,"dmag":0.4,"t":100}').ok, true);
  assert.equal(E.parseLine('{"v":1,"type":"gesture","g":"double_tap","seq":3,"t":100}').ok, true);
  assert.equal(E.parseLine('{"v":1,"type":"imu","r":"x","p":1}').error, 'BAD_IMU');
  assert.equal(E.parseLine('{"v":1,"type":"imu","r":500,"p":1}').error, 'BAD_IMU');
  assert.equal(E.parseLine('{"v":1,"type":"gesture","g":"wave","seq":1}').error, 'UNKNOWN_GESTURE');
  assert.equal(E.parseLine('{"v":1,"type":"gesture","g":"tap"}').error, 'BAD_SEQ');
});
