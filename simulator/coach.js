/* MRISafe Twin coach: answers from knowledge-base.js on this computer.
 * No account, API key, server or internet is needed. It is the default coach, and the
 * fallback when an optional local AI server (for example Ollama) is unavailable.
 *
 * Matching is keyword retrieval: question words are stemmed, weighted by where they match
 * (sample questions > tags > topic > answer text) and scored with inverse document
 * frequency. A reply is given only when the match is confident; otherwise the coach says so
 * and suggests questions it can answer. Explanations of broken rules are built from the
 * rule card the assessor sends, never from free text. */
(function () {
  const KB = Array.isArray(window.MRIKB) ? window.MRIKB : [];

  const STOP = new Set(('a an the is are was were be to of in on for and or it its this that what how why when do does did ' +
    'i my me you your can with as at by from if so not no about explain tell please which there their they we should would ' +
    'could get use mean means simply just').split(' '));
  const SYN = {
    magnets: 'magnet', magnetic: 'magnet', tesla: 'field', detector: 'detect', detection: 'detect', detects: 'detect',
    metal: 'ferromagnetic', steel: 'ferromagnetic', implants: 'implant', device: 'implant', pacemakers: 'pacemaker',
    screened: 'screening', screen: 'screening', scanner: 'scan', scans: 'scan', scanning: 'scan', quenches: 'quench',
    loud: 'noise', noisy: 'noise', hot: 'heat', heating: 'heat', burns: 'burn', labels: 'label', labelling: 'label',
    labelled: 'label', classify: 'classification', classified: 'classification', pads: 'pad',
    chapters: 'chapter', zones: 'zone', rooms: 'room',
  };

  function stem(w) {
    w = SYN[w] || w;
    return w.length > 4 ? w.replace(/(ings|ing|ed|es|s)$/, '') : w;
  }
  function tokens(s) {
    return String(s || '').toLowerCase().replace(/k-space/g, 'kspace').replace(/[^a-z0-9\s-]+/g, ' ').split(/[\s]+/)
      .map(w => w.replace(/^-+|-+$/g, ''))
      .filter(w => w.length > 1 && !STOP.has(w))
      .map(stem);
  }

  // Index: one token set per field, and document frequency for weighting.
  const WEIGHTS = { q: 3, tags: 2, topic: 1, a: 1 };
  const docs = KB.map(e => ({
    e,
    f: {
      q: new Set(tokens((e.q || []).join(' '))),
      tags: new Set(tokens(e.tags)),
      topic: new Set(tokens(e.topic)),
      a: new Set(tokens(e.a)),
    },
  }));
  const df = new Map();
  for (const d of docs) {
    const all = new Set([...d.f.q, ...d.f.tags, ...d.f.topic, ...d.f.a]);
    for (const t of all) df.set(t, (df.get(t) || 0) + 1);
  }
  const N = Math.max(1, docs.length);
  const idf = t => Math.log(1 + N / (df.get(t) || 1));

  function score(qTokens, d) {
    let s = 0;
    for (const t of new Set(qTokens)) {
      let best = 0;
      for (const field of Object.keys(WEIGHTS)) if (d.f[field].has(t)) best = Math.max(best, WEIGHTS[field]);
      if (best) s += best * idf(t);
    }
    return s;
  }
  const CONFIDENT = 4; // below this the coach admits it does not know

  function search(question, n = 3) {
    const q = tokens(question);
    if (!q.length) return [];
    return docs.map(d => ({ e: d.e, s: score(q, d) }))
      .filter(x => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, n);
  }

  const SUGGEST = ['What does MR Conditional mean?', 'Why is the magnetic field always on?', 'What is k-space?',
    'What is a quench?', 'How does slice selection work?', 'Why do I need to classify each item?'];

  function explain(ctx) {
    const vs = (ctx && ctx.violations) || [];
    if (!vs.length) return 'No mistake is recorded yet in this attempt. When the assessor flags one, ask me again.';
    return vs.map(v => {
      const hits = search(`${v.title} ${v.evidence || ''}`, 6);
      const bg = (hits.find(h => (h.e.see || []).includes(v.rule)) || { e: KB.find(e => (e.see || []).includes(v.rule)) }).e;
      let t = `[${v.rule}] ${v.title}\n\nWhat happened: ${v.evidence}\n\nWhy it matters: ${v.why}\n\nNext: ${v.corrective}`;
      if (bg) t += `\n\nBackground: ${bg.a}`;
      return t;
    }).join('\n\n— — —\n\n');
  }

  function debrief(ctx) {
    if (!ctx) return 'Finish or reset an attempt first, then ask for a debrief.';
    const lines = [
      `Result: ${ctx.scenario}, attempt ${ctx.attempt}: score ${ctx.score}${ctx.completed ? (ctx.passed ? ', passed.' : ', not passed.') : ' (in progress).'}`,
      `Actions: ${ctx.correctActions} correct, ${ctx.actionsWithViolation} with a violation; ${ctx.criticalCount} critical.`,
      ctx.violations && ctx.violations.length ? `Mistakes: ${ctx.violations.map(v => `[${v.rule}] ${v.title}`).join('; ')}.` : 'Mistakes: none recorded.',
      ctx.recommendation ? `Next: ${ctx.recommendation.next} (${ctx.recommendation.rule}). ${ctx.recommendation.reason}` : 'Next: finish the attempt to get a recommendation.',
    ];
    const tip = ctx.violations && ctx.violations.length
      ? `\n\nFor the first mistake, the rule to remember is [${ctx.violations[0].rule}]: ${ctx.violations[0].corrective}`
      : '';
    return lines.join('\n') + tip;
  }

  let quizIndex = 0;
  const QUIZ_POOL = KB.filter(e => e.q && e.q.length && e.topic !== 'App' && e.topic !== 'Procedure');
  function quiz() {
    if (!QUIZ_POOL.length) return 'The quiz has no questions yet.';
    const e = QUIZ_POOL[quizIndex % QUIZ_POOL.length];
    quizIndex += 7; // a stride through the pool so repeats are rare
    return `Question: ${e.q[0]}\n\nAnswer to check yourself against: ${e.a}\n\nAsk "quiz me" again for another question.`;
  }

  function tutor(question, ctx) {
    const notes = ctx && ctx.notes ? ctx.notes.slice(0, 900) : '';
    if (notes && /chapter|simpl|this (part|section|page)/i.test(question || '')) {
      return `From ${ctx.chapter}:\n\n${notes}`;
    }
    const hits = search(question || '', 3);
    if (hits.length && hits[0].s >= CONFIDENT) {
      const more = hits.slice(1).filter(h => h.s >= CONFIDENT - 1).map(h => h.e.q[0]);
      return hits[0].e.a + (more.length ? `\n\nRelated: ${more.join(' · ')}` : '');
    }
    let t = "I don't have a confident answer to that in the built-in knowledge base yet.";
    if (notes) t += `\n\nHere are the notes for ${ctx.chapter}:\n\n${notes}`;
    t += `\n\nTry asking: ${SUGGEST.slice(0, 4).join(' · ')}`;
    return t;
  }

  /* Public API. respond() returns plain text; the shell labels it "Knowledge base · offline". */
  function respond(task, ctx, question) {
    if (task === 'explain') return explain(ctx);
    if (task === 'debrief') return debrief(ctx);
    if (task === 'quiz') return quiz();
    return tutor(question, ctx);
  }

  window.MRICoach = { respond, search, count: KB.length, confident: CONFIDENT, tokens };
})();
