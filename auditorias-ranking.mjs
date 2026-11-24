const clean = value => String(value ?? '').trim().replace(/\s+/g, ' ');
const keyOf = value => value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
const missing = value => !value || ['null','undefined'].includes(keyOf(value));

export function auditErrorRanking(audits) {
  const groups = new Map();
  for (const audit of audits) {
    const correct = clean(audit.resultado);
    if (audit.estado === 'sin_error' || missing(correct)) continue;
    const raw = clean(audit.decisionOrigen);
    const decision = missing(raw) ? 'Sin decisión registrada' : raw;
    const key = JSON.stringify([keyOf(decision),keyOf(correct)]);
    const group = groups.get(key) || {decision,correct,count:0};
    group.count++;
    groups.set(key,group);
  }
  return [...groups.values()].sort((a,b) => b.count-a.count || a.decision.localeCompare(b.decision,'es') || a.correct.localeCompare(b.correct,'es'));
}
