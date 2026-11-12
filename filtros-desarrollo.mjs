const day = 86400000;
const formatDate = time => new Date(time).toISOString().slice(0,10);
const parseDate = date => Date.parse(date+'T00:00:00Z');
const monthLabel = new Intl.DateTimeFormat('es-AR',{month:'long',year:'numeric',timeZone:'UTC'});
const shortDate = new Intl.DateTimeFormat('es-AR',{day:'2-digit',month:'2-digit',year:'numeric',timeZone:'UTC'});

function mondayOf(date) {
  const time=parseDate(date);
  return time-((new Date(time).getUTCDay()+6)%7)*day;
}

function weekLabel(date) {
  const thursday=new Date(parseDate(date)+3*day),year=thursday.getUTCFullYear();
  const week=Math.floor((thursday-Date.UTC(year,0,1))/(7*day))+1;
  return 'W'+String(week).padStart(2,'0')+' '+year;
}

function setupPeriodPicker({$,today,state,change}) {
  const toggle=$('pmPeriodToggle'),popover=$('pmPeriodPopover');
  const modes=[...popover.querySelectorAll('[data-pm-mode]')];
  const selects=['pmQuarterChoice','pmMonthChoice','pmWeekFrom','pmWeekTo'];
  const areas={quarter:'pmQuarterArea',month:'pmMonthArea',weeks:'pmWeeksArea',custom:'pmCustomArea'};
  const fill=(id,items)=>$(id).replaceChildren(...items.map(([value,label])=>new Option(label,value)));
  function populate() {
    const currentYear=Number(today().slice(0,4));
    const savedYears=[state().from,state().to].filter(value=>/^\d{4}-\d{2}-\d{2}$/.test(value)).map(value=>Number(value.slice(0,4)));
    const years=[...new Set([...Array.from({length:6},(_,i)=>currentYear+1-i),...savedYears])].sort((a,b)=>b-a);
    const quarters=[],months=[],weeks=[];
    for(const year of years){
      for(let quarter=4;quarter>=1;quarter--)quarters.push([formatDate(Date.UTC(year,(quarter-1)*3,1)),'Q'+quarter+' '+year]);
      for(let month=11;month>=0;month--){
        const time=Date.UTC(year,month,1),label=monthLabel.format(time);
        months.push([formatDate(time),label.charAt(0).toUpperCase()+label.slice(1)]);
      }
      for(let time=mondayOf(year+'-01-04');weekLabel(formatDate(time)).endsWith(' '+year);time+=7*day){
        const date=formatDate(time);
        weeks.push([date,weekLabel(date)+' · '+shortDate.format(time)]);
      }
    }
    fill('pmQuarterChoice',quarters);fill('pmMonthChoice',months);
    weeks.sort(([a],[b])=>a.localeCompare(b));
    fill('pmWeekFrom',weeks);fill('pmWeekTo',weeks);
  }
  function render() {
    const {mode,from,to}=state();
    for(const button of modes){
      const active=button.dataset.pmMode===mode;
      button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));
    }
    for(const [key,id] of Object.entries(areas))$(id).hidden=key!==mode;
    if(mode==='quarter')$('pmQuarterChoice').value=from;
    if(mode==='month')$('pmMonthChoice').value=from;
    if(mode==='weeks'){$('pmWeekFrom').value=from;$('pmWeekTo').value=formatDate(parseDate(to)-6*day);}
    $('devFrom').value=from;$('devTo').value=to;
    const title=mode==='quarter'?$('pmQuarterChoice').selectedOptions[0]?.text:
      mode==='month'?$('pmMonthChoice').selectedOptions[0]?.text:
      mode==='weeks'?weekLabel(from)+' a '+weekLabel($('pmWeekTo').value):
      [from,to].filter(Boolean).map(date=>shortDate.format(parseDate(date))).join(' a ');
    toggle.firstChild.textContent=(title||'Fechas personalizadas')+' ';
  }
  function select(mode,from,weekEnd) {
    const current=today();
    if(mode==='custom'){Object.assign(state(),{mode});}
    else if(mode==='weeks'){
      const last=weekEnd||formatDate(mondayOf(current));
      const first=from||formatDate(parseDate(last)-21*day);
      Object.assign(state(),{mode,from:first,to:formatDate(parseDate(last)+6*day),cadence:'weeks'});
    }else{
      const [year,month]=current.split('-').map(Number);
      const start=from||formatDate(Date.UTC(year,mode==='quarter'?Math.floor((month-1)/3)*3:month-1,1));
      const date=new Date(parseDate(start));
      const end=Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+(mode==='quarter'?3:1),0);
      Object.assign(state(),{mode,from:start,to:formatDate(end),cadence:'weeks'});
    }
    render();change();
  }
  function open(visible) {
    popover.hidden=!visible;toggle.setAttribute('aria-expanded',String(visible));
  }
  toggle.addEventListener('click',()=>open(popover.hidden));
  document.addEventListener('click',event=>{if(!event.target.closest('.pm-period-control'))open(false);});
  toggle.parentElement.addEventListener('keydown',event=>{
    if(event.key==='Escape'&&!popover.hidden){event.preventDefault();open(false);toggle.focus();}
  });
  for(const button of modes)button.addEventListener('click',()=>{
    if(state().mode!==button.dataset.pmMode)select(button.dataset.pmMode);
  });
  for(const [id,mode] of [[selects[0],'quarter'],[selects[1],'month']]){
    $(id).addEventListener('change',()=>select(mode,$(id).value));
  }
  for(const id of selects.slice(2))$(id).addEventListener('change',()=>{
    const first=$('pmWeekFrom').value,last=$('pmWeekTo').value;
    if(first>last){const chosen=$(id).value;select('weeks',chosen,chosen);}
    else select('weeks',first,last);
  });
  for(const button of popover.querySelectorAll('[data-pm-last]'))button.addEventListener('click',()=>{
    const last=mondayOf(today());
    select('weeks',formatDate(last-(Number(button.dataset.pmLast)-1)*7*day),formatDate(last));
  });
  for(const [id,key] of [['devFrom','from'],['devTo','to']])$(id).addEventListener('change',()=>{
    state()[key]=$(id).value;render();change();
  });
  return {populate,render,close:()=>open(false)};
}


export function setupFilters({period,readScope,refresh,today}) {
  const $=id=>document.getElementById(id);
  const controls=$('devGlobalFilters');
  const defaults=()=>{
    const [year,month]=today().split('-').map(Number);
    const quarter=Math.floor((month-1)/3)*3;
    return {teams:[],people:[],mode:'quarter',from:formatDate(Date.UTC(year,quarter,1)),
      to:formatDate(Date.UTC(year,quarter+3,0)),cadence:'weeks'};
  };
  let state=defaults(), account='';
  const picker=setupPeriodPicker({$,today,state:()=>state,change});
  function start(uid){
    account='dashboard-kpi-dev-filtros-'+uid;state=defaults();
    try {
      const saved=JSON.parse(localStorage.getItem(account)||'{}');
      for(const key of ['teams','people'])if(Array.isArray(saved[key]))state[key]=saved[key].filter(x=>typeof x==='string');
      if(['quarter','month','weeks','custom'].includes(saved.mode)||saved.from||saved.to){
        state.mode=saved.mode||'custom';
        for(const key of ['from','to'])if(typeof saved[key]==='string'&&(saved[key]===''||Number.isFinite(parseDate(saved[key]))))state[key]=saved[key];
      }
      if(['days','weeks','months'].includes(saved.cadence))state.cadence=saved.cadence;
    }catch{}
    if(!readScope().global)state.teams=[];
    picker.populate();picker.render();render();
  }
  function change(){
    try{localStorage.setItem(account,JSON.stringify(state));}catch{}
    $('devFilterStatus').textContent=period(state)?'':'Revisá el rango de fechas.';
    refresh();
  }
  function render(){
    const {global,people}=readScope();
    const teams=[...new Set(people.map(x=>x.team).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'es'));
    $('devTeams').hidden=!global;
    const options=(id,key,items)=>{
      const box=$(id);box.replaceChildren();
      for(const {id:value,label:name} of items){
        const label=document.createElement('label'),check=document.createElement('input');
        check.type='checkbox';check.checked=state[key].includes(value);
        check.onchange=()=>{
          state[key]=check.checked?[...new Set([...state[key],value])]:state[key].filter(item=>item!==value);
          if(key==='teams')state.people=state.people.filter(id=>!state.teams.length||state.teams.includes(people.find(item=>item.id===id)?.team));
          change();
        };
        label.append(check,document.createTextNode(name||value));box.append(label);
      }
      box.parentElement.querySelector('summary').textContent=(key==='teams'?'Equipos':'Catalogadores')+' · '+(state[key].length||'Todos');
    };
    options('devTeamOptions','teams',teams.map(id=>({id,label:id})));
    options('devPeopleOptions','people',people.filter(x=>!state.teams.length||state.teams.includes(x.team))
      .sort((a,b)=>String(a.label).localeCompare(String(b.label),'es')));
  }
  $('devClear').addEventListener('click',()=>{state=defaults();picker.render();picker.close();change();});
  return {
    start,render, state:()=>state, period:()=>period(state),
    mount(container){picker.close();container.prepend(controls);controls.hidden=false;},
    teamMatches(team){const scope=readScope();return scope.global?(!state.teams.length||state.teams.includes(team)):team===scope.team;},
    personMatches(id){return !state.people.length||state.people.includes(String(id??''));},
    chooseTeam(team){state.teams=[team];state.people=[];change();}
  };
}
