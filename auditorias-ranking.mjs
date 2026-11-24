const clean = value => String(value ?? '').trim().replace(/\s+/g, ' ');
const keyOf = value => value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
const missing = value => !value || ['null','undefined'].includes(keyOf(value));

export function auditRankingFlow(audit) {
  const flow=clean(audit.flujo).toUpperCase();
  if(flow==='MAO')return 'CCC';
  if(flow&&flow!=='NULL')return flow;
  return /^https:\/\/catalog-domains\.adminml\.com\/catalogo\/bc-admin\/sugerencias\/revision\//i.test(clean(audit.referencia))?'SDC':'';
}
export function auditErrorRanking(audits, flow = '') {
  const groups = new Map();
  for (const audit of audits) {
    if(flow && auditRankingFlow(audit)!==flow)continue;
    const correct = clean(audit.resultado);
    if (audit.estado === 'sin_error' || missing(correct)) continue;
    const origin=clean(audit.decisionOrigen),state=clean(audit.estadoOrigen);
    const storedDecision=/^(approved|rejected|aprobar|aprobado|rechazar|rechazado|desestimar|desestimado)$/i.test(state)?state:'';
    const raw = missing(origin)?storedDecision:origin;
    const decision = missing(raw) ? 'Sin decisión registrada' : raw;
    const key = JSON.stringify([keyOf(decision),keyOf(correct)]);
    const group = groups.get(key) || {decision,correct,count:0};
    group.count++;
    groups.set(key,group);
  }
  return [...groups.values()].sort((a,b) => b.count-a.count || a.decision.localeCompare(b.decision,'es') || a.correct.localeCompare(b.correct,'es'));
}
