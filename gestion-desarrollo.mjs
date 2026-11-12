export const operationalFlows = {mixto:'Flujo Mixto',soporte:'Soporte',kv:'Know Values'};
export const defaultProductivityGoals = {mixto:100,soporte:11,kv:null};
export const qualityFlows = ['SDC','SCP','FO','CCC'];
export const normalizeLabel = value => String(value??'').normalize('NFD').replace(/\p{Diacritic}/gu,'').trim().toLowerCase().replace(/[\s_-]+/g,' ');
const day = 86400000;
const dateString = date => new Date(date).toISOString().slice(0,10);
export function dateValue(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
  const time = Date.parse(value+'T00:00:00Z');
  return Number.isFinite(time) && dateString(time)===value ? time : NaN;
}
export function analysisPeriod({from,to}, fallback) {
  const start=dateValue(from||fallback.from), end=dateValue(to||fallback.to);
  if (!Number.isFinite(start)||!Number.isFinite(end)||end<start) return null;
  const length=end-start+day;
  return {current:{start:dateString(start),end:dateString(end)},previous:{start:dateString(start-length),end:dateString(start-day)}};
}
export function inPeriod(date,period) {
  return Boolean(period && Number.isFinite(dateValue(date)) && date>=period.start && date<=period.end);
}
export function periodBucket(date,cadence) {
  const value=dateValue(date);
  if (!Number.isFinite(value)) return null;
  if (cadence==='months') return date.slice(0,7);
  if (cadence==='weeks') return dateString(value-((new Date(value).getUTCDay()+6)%7)*day);
  return date;
}
export function normalizeQualityFlow(value) {
  const words=normalizeLabel(value).split(/[^a-z]+/);
  return qualityFlows.find(flow=>words.includes(flow.toLowerCase())||(flow==='CCC'&&words.includes('mao'))) || '';
}
export function operationalFlow(value) {
  const name=normalizeLabel(value).replace(/^analista /,'');
  if (/^(soporte|support)$/.test(name)) return 'soporte';
  if (/^(kv|know(n|s)? values?)$/.test(name)) return 'kv';
  return 'mixto';
}
export function publishedProductivity(publication, classifyInitiative) {
  const excludedDates = new Set((publication.gestion || []).filter(record =>
    Object.entries(record.flujos || {}).some(([initiative, count]) =>
      Number(count) > 0 && ['SOPORTE','KNOWN_VALUE'].includes(classifyInitiative(initiative))
    )
  ).map(record => record.fecha));

  const rows = (publication.tareas || []).map(row => {
    const flow = [row.flujoOperativo, publication.flujoOperativo]
      .find(value => Object.hasOwn(operationalFlows, value));
    const role = row.rolOrigen || publication.rolOrigen;
    const historicalFlow = excludedDates.has(row.fecha) ? null : 'mixto';
    return {...row, id:String(publication.idMeli), equipo:publication.equipo,
      flujoOperativo:flow || (role ? operationalFlow(role) : historicalFlow)};
  });
  const corrections = new Map();
  for(const {fecha,flujos} of publication.gestion || []){
    if(!fecha||!Object.keys(flujos || {}).length)continue;
    let total=corrections.get(fecha)??0;
    for(const [initiative,count] of Object.entries(flujos)){
      const quantity=Number(count);
      if(/\bcorreccion(?:es)?\b/.test(normalizeLabel(initiative))&&Number.isFinite(quantity)&&quantity>0){
        total+=quantity;
      }
    }
    corrections.set(fecha,total);
  }
  const existing=rows.filter(row=>row.tipo!=='correcciones'||!corrections.has(row.fecha));
  for(const [fecha,cantidad] of corrections){
    existing.push({fecha,cantidad,tipo:'correcciones',id:String(publication.idMeli),
      equipo:publication.equipo,colaborador:publication.nombre||String(publication.idMeli)});
  }
  return existing;
}
export function productivityTotals(rows) {
  const valid=rows.filter(row=>row.tipo==='tareas'&&Number.isFinite(row.cantidad)&&row.cantidad>=0);
  return {days:valid.length,people:new Set(valid.map(row=>row.id)).size,
    average:valid.length?valid.reduce((sum,row)=>sum+row.cantidad,0)/valid.length:null};
}
export function achievement(average,minimum) {
  return average===null||minimum==null ? {difference:null,percent:null} :
    {difference:average-minimum,percent:average/minimum*100};
}
export function itemUrl(item) {
  const id=String(item??'').trim().toUpperCase();
  if (!/^ML[A-Z]{1,3}-?\d{5,16}$/.test(id)) return null;
  const url=new URL('https://meli-one-source.adminml.com/item-view');
  url.searchParams.set('item_id',id.replace('-',''));
  return url.href;
}
export function creationSeries(rows,cadence) {
  const series=new Map();
  for(const row of rows){
    if(!['creaciones','correcciones'].includes(row.tipo)||!Number.isFinite(row.cantidad)||row.cantidad<0)continue;
    const key=periodBucket(row.fecha,cadence);
    if(!key)continue;
    if(!series.has(key))series.set(key,{key,creaciones:null,correcciones:null});
    const point=series.get(key);
    point[row.tipo]=(point[row.tipo]??0)+row.cantidad;
  }
  return [...series.values()].sort((a,b)=>a.key.localeCompare(b.key));
}
export function holdsErrorRanking(rows,cadence) {
  const actions=new Map();
  let total=0;
  for(const row of rows){
    // Una fila con varias acciones conserva la combinación original y cuenta una vez.
    const action=String(row.accionCorrecta??'').trim(), key=normalizeLabel(action);
    if(!key||key==='null')continue;
    const count=Number(row.cantidad), bucket=periodBucket(row.fecha,cadence);
    if(!Number.isFinite(count)||count<=0||!bucket)continue;
    if(!actions.has(key))actions.set(key,{action,count:0,rows:[],trend:new Map()});
    const group=actions.get(key);
    group.count+=count;total+=count;group.rows.push(row);
    group.trend.set(bucket,(group.trend.get(bucket)||0)+count);
  }
  return [...actions.values()].sort((a,b)=>b.count-a.count||a.action.localeCompare(b.action,'es'))
    .map((group,i)=>({...group,rank:i+1,percent:group.count/total*100,trend:[...group.trend].sort(([a],[b])=>a.localeCompare(b))}));
}
