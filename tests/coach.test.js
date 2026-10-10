// node --test tests/coach.test.js   (no network, no browser)
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

global.window = {};
require(path.join(__dirname, '..', 'simulator', 'knowledge-base.js'));
require(path.join(__dirname, '..', 'simulator', 'coach.js'));
const KB = window.MRIKB;
const C = window.MRICoach;

test('knowledge base is well formed', () => {
  assert.ok(KB.length >= 80, `expected a large knowledge base, got ${KB.length}`);
  const ids = new Set();
  for (const e of KB) {
    assert.ok(e.id && !ids.has(e.id), `duplicate or missing id: ${e.id}`);
    ids.add(e.id);
    assert.ok(Array.isArray(e.q) && e.q.length >= 1, `${e.id} needs sample questions`);
    assert.ok(e.a && e.a.length > 40, `${e.id} needs an answer`);
    assert.ok(e.topic, `${e.id} needs a topic`);
    assert.ok(!/azure/i.test(e.a + e.q.join(' ') + e.tags), `${e.id} still mentions Azure`);
  }
});

test('retrieval answers common questions with the right entry', () => {
  const cases = [
    ['Why is the magnetic field always on?', 'field-always-on'],
    ['What is the projectile effect?', 'projectile'],
    ['What is k-space?', 'kspace'],
    ['What is the Larmor frequency at 1.5 T?', 'larmor'],
    ['How do I change the theme?', 'app-theme'],
    ['Can a pacemaker patient have an MRI?', 'pacemaker'],
    ['Can I take oxygen into the scan room?', 'oxygen-cylinder'],
    ['What does the wand meter do?', 'app-wand'],
  ];
  for (const [q, id] of cases) {
    const top = C.search(q, 1)[0];
    assert.ok(top, `no match for: ${q}`);
    assert.equal(top.e.id, id, `"${q}" matched ${top.e.id}`);
    assert.ok(top.s >= C.confident, `"${q}" matched with low confidence ${top.s.toFixed(1)}`);
  }
});

test('an unrelated question gets an honest fallback, not a guess', () => {
  const reply = C.respond('tutor', null, 'tell me a joke about dogs');
  assert.match(reply, /don't have a confident answer/);
  assert.match(reply, /Try asking/);
});

test('chapter notes are used when the question is about the chapter', () => {
  const ctx = { chapter: '9. Slice selection', notes: 'The gradient makes the frequency depend on position.' };
  assert.match(C.respond('tutor', ctx, 'Explain this chapter simply'), /From 9\. Slice selection/);
});

test('explanations cite the broken rule and add background from the knowledge base', () => {
  const ctx = { violations: [{ rule: 'R-EQ-03', title: 'MR Unsafe item in or brought into Zone IV',
    evidence: 'Oxygen cylinder on trolley was still inside Zone IV.', why: 'Projectile risk.', corrective: 'Move it out.' }] };
  const text = C.respond('explain', ctx);
  assert.match(text, /\[R-EQ-03\]/);
  assert.match(text, /Background:/);
  assert.doesNotMatch(text, /R-(EQ-0[1245]|EQ-06|ACC|SCR|SEQ|SCAN|ID)/, 'must not mention other rules');
});

test('debrief summarises the attempt from the context it is given', () => {
  const text = C.respond('debrief', { scenario: 'Standard pre-scan', attempt: 2, score: 75, completed: false, passed: false,
    correctActions: 4, actionsWithViolation: 1, criticalCount: 0, violations: [], recommendation: null });
  assert.match(text, /score 75/);
  assert.match(text, /Mistakes: none recorded/);
});

test('quiz returns a question with its answer', () => {
  const text = C.respond('quiz', null);
  assert.match(text, /^Question: /);
  assert.match(text, /Answer to check yourself against:/);
});
