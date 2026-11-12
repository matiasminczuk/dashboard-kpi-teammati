import {operationalFlows,productivityTotals,achievement,creationSeries,holdsErrorRanking,inPeriod} from './gestion-desarrollo.mjs';

const format=new Intl.NumberFormat('es-AR',{maximumFractionDigits:1});
const fmt=value=>value==null?'—':format.format(value);
const signed=value=>value==null?'—':(value>0?'+':'')+fmt(value);
function element(tag,text,className){
  const node=document.createElement(tag);
  if(text!==undefined)node.textContent=text;
  if(className)node.className=className;
  return node;
}
function report(rows,period,group){
  return productivityTotals(rows.filter(row=>row.flujoOperativo===group&&inPeriod(row.fecha,period)));
}
function comparisonChange(cell,value){
  if(value==null||value===0){cell.textContent=fmt(value);return;}
  const increasing=value>0;
  const arrow=element('span',increasing?'↑':'↓','comparison-arrow');
  arrow.dataset.direction=increasing?'up':'down';
  arrow.setAttribute('role','img');
  arrow.setAttribute('aria-label',increasing?'Aumento':'Disminución');
  cell.append(arrow,document.createTextNode(' '+fmt(Math.abs(value))));
}

export function renderOperationalCards(container,rows,period,goals,onlyActive=false){
  container.replaceChildren();
  for(const [group,name] of Object.entries(operationalFlows)){
    const current=report(rows,period?.current,group),previous=report(rows,period?.previous,group);
    if(onlyActive&&!current.people&&!previous.people)continue;
    const target=goals[group]??null, kpi=achievement(current.average,target);
    const card=element('article',undefined,'dev-metric');
    card.append(element('h3',name),element('strong',current.average==null?'Sin datos':fmt(current.average)+' tareas por jornada'),
      element('p',fmt(current.people)+' colaboradores · '+fmt(current.days)+' jornadas'),
      element('p',target===null?'Sin objetivo':'Mínimo '+fmt(target)+' · Diferencia '+signed(kpi.difference)+
        (kpi.percent==null?'':' · '+fmt(kpi.percent)+'% de cumplimiento')),
      element('p',current.average==null||previous.average==null?'Sin comparación disponible':
        signed(current.average-previous.average)+' tareas por jornada vs. período anterior'));
    container.append(card);
  }
  if(!container.children.length)container.append(element('p','Sin colaboradores con datos de flujo en el período.'));
}

export function renderComparison({chart,body,rows,period,group,sort,goals,drilldown,chooseMonth}){
  const teams=new Map();
  for(const row of rows){
    if(!teams.has(row.equipo))teams.set(row.equipo,[]);
    teams.get(row.equipo).push(row);
  }
  const minimum=goals[group]??null;
  const comparisons=[...teams].map(([team,data])=>{
    const current=report(data,period?.current,group),previous=report(data,period?.previous,group);
    const {difference}=achievement(current.average,minimum);
    return {team,...current,difference,delta:current.average==null||previous.average==null?null:current.average-previous.average};
  }).filter(item=>item.average!==null);
  const ranking=[...comparisons].sort((a,b)=>b.average-a.average||a.team.localeCompare(b.team,'es'));
  const positions=new Map(ranking.map((item,i)=>[item.team,i+1]));
  const max=Math.max(1,minimum||0,...ranking.map(item=>item.average));
  chart.replaceChildren();
  body.replaceChildren();
  if(!ranking.length){
    const dates=rows.filter(row=>row.tipo==='tareas'&&row.flujoOperativo===group).map(row=>row.fecha).sort();
    chart.textContent='Sin jornadas de '+operationalFlows[group]+' para la selección actual.';
    if(dates.length){
      const latest=dates.at(-1);
      const month=new Intl.DateTimeFormat('es-AR',{month:'long',year:'numeric',timeZone:'UTC'}).format(new Date(latest+'T00:00:00Z'));
      const button=element('button','Ver '+month,'audit-link');
      button.type='button';button.onclick=()=>chooseMonth(latest);
      chart.append(document.createTextNode(' '),button);
    }
    return;
  }
  for(const item of ranking){
    const row=element('div',undefined,'dev-comparison-bar'),label=element('span',item.team),meter=element('meter');
    meter.min=0;meter.max=max;meter.value=item.average;
    meter.setAttribute('aria-label',item.team+' · '+fmt(item.average)+' tareas por jornada');
    row.append(label,meter,element('strong',fmt(item.average)));chart.append(row);
  }
  comparisons.sort((a,b)=>(b[sort]??-Infinity)-(a[sort]??-Infinity)||a.team.localeCompare(b.team,'es'));
  for(const item of comparisons){
    const row=body.insertRow();
    row.insertCell().textContent=positions.get(item.team);
    const button=element('button',item.team,'audit-link');button.type='button';button.onclick=()=>drilldown(item.team);
    row.insertCell().append(button);
    for(const value of [fmt(item.average),fmt(item.people),minimum===null?'Sin objetivo':fmt(minimum)])row.insertCell().textContent=value;
    comparisonChange(row.insertCell(),item.difference);
    comparisonChange(row.insertCell(),item.delta);
  }
}

export function renderCreationChart(container,rows,cadence){
  const points=creationSeries(rows,cadence);
  container.replaceChildren();
  if(!points.length){container.textContent='Sin registros de Creaciones o Correcciones en el período.';return;}
  const ns='http://www.w3.org/2000/svg', svg=document.createElementNS(ns,'svg');
  const width=Math.max(520,points.length*68),height=230,padding=38;
  svg.setAttribute('viewBox','0 0 '+width+' '+height);
  svg.style.minWidth=Math.min(width,Math.max(420,points.length*54))+'px';
  svg.setAttribute('role','img');svg.setAttribute('aria-label','Evolución de Creaciones y Correcciones');
  const max=Math.max(1,...points.flatMap(p=>[p.creaciones??0,p.correcciones??0]));
  const x=index=>points.length===1?width/2:padding+index*(width-2*padding)/(points.length-1);
  const y=value=>height-padding-value*(height-2*padding)/max;
  const add=(tag,attrs,text)=>{
    const node=document.createElementNS(ns,tag);
    for(const [key,value] of Object.entries(attrs))node.setAttribute(key,value);
    if(text!==undefined)node.textContent=text;svg.append(node);return node;
  };
  for(let tick=0;tick<=4;tick++){
    const value=max*tick/4;
    add('line',{x1:padding,y1:y(value),x2:width-padding,y2:y(value),class:'dev-chart-grid'});
    add('text',{x:padding-6,y:y(value)+4,'text-anchor':'end'},fmt(value));
  }
  points.forEach((point,i)=>add('text',{x:x(i),y:height-12,'text-anchor':'middle'},point.key));
  for(const [key,name,color] of [['creaciones','Creaciones','#1765d1'],['correcciones','Correcciones','#d17b12']]){
    let last=null;
    points.forEach((point,i)=>{
      const value=point[key];
      if(value==null){last=null;return;}
      const next=[x(i),y(value)];
      if(last)add('line',{x1:last[0],y1:last[1],x2:next[0],y2:next[1],stroke:color,'stroke-width':3});
      const circle=add('circle',{cx:next[0],cy:next[1],r:4,fill:color,tabindex:0});
      const tooltip=point.key+' · '+name+' '+fmt(value);circle.setAttribute('aria-label',tooltip);
      const title=document.createElementNS(ns,'title');title.textContent=tooltip;circle.append(title);
      last=next;
    });
  }
  container.append(svg);
  if(points.every(point=>point.correcciones==null))container.append(element('p','La publicación no contiene registros de Correcciones.','muted'));
}

export function renderHoldsRanking(container,rows,cadence,top){
  container.replaceChildren();
  const ranking=holdsErrorRanking(rows,cadence).slice(0,top);
  if(!ranking.length){container.textContent='Sin registros con «Acción correcta» en las bases de Holds publicadas para esta selección.';return;}
  const list=element('ol',undefined,'dev-holds-list');
  for(const entry of ranking){
    const row=element('li'),detail=element('details');
    detail.append(element('summary',entry.action+' · '+fmt(entry.count)+' errores · '+fmt(entry.percent)+'%'));
    const trend=element('p',entry.trend.map(([date,count])=>date+' · '+fmt(count)).join(' | '),'muted');
    detail.append(trend);
    const records=element('ul');
    for(const record of entry.rows)records.append(element('li',
      [record.fecha,record.colaborador||record.id,record.idCDM,record.accionCorrecta,fmt(record.cantidad)].filter(Boolean).join(' · ')));
    detail.append(records);row.append(detail);list.append(row);
  }
  container.append(list);
}
