const normalize=value=>String(value??'').normalize('NFD').replace(/\p{Diacritic}/gu,'').toLowerCase().trim().replace(/[_\s]+/g,' ');
export const baseLabels={productividad:'Productividad',holds:'Holds',finalizadas:'Finalizadas',calidad:'Calidad',auditorias:'Auditorías'};

export function detectUploadBase(sheets){
  const names=sheets.map(sheet=>normalize(sheet.name));
  if(names.includes('base diaria')&&names.includes('base creaciones'))return 'productividad';
  const candidates=new Set();
  for(const sheet of sheets){
    for(const row of sheet.rows.slice(0,15)){
      const headers=row.map(normalize),has=(...values)=>values.every(value=>headers.includes(value));
      if(has('colaborador','fecha fin','fecha inicio','iniciativa','asignacion','finalizacion'))candidates.add('finalizadas');
      else if(has('id cdm','colaborador')&&(has('ultimo hold')||has('ultima hold')))candidates.add('holds');
      else if(has('accion correcta','colaborador')&&(has('suggestion id')||has('correction id')||has('id cdm')))candidates.add('auditorias');
      else if((has('id auditoria')||has('id de auditoria'))&&(has('resultado')||has('accion correcta')))candidates.add('auditorias');
      else if(headers.some(value=>['q tareas auditadas','tareas auditadas','cantidad auditada','evaluaciones'].includes(value))&&headers.some(value=>['% efectividad','efectividad','% calidad','calidad'].includes(value)))candidates.add('calidad');
    }
  }
  return candidates.size===1?[...candidates][0]:'';
}

export function findUploadConflicts(entries){
  const seen=new Map(),conflicts=new Set();
  for(const entry of entries){
    for(const [key,value] of entry.plan?.fingerprints||[]){
      const previous=seen.get(key);
      if(previous&&previous.value!==value){conflicts.add(previous.entry);conflicts.add(entry);}
      else seen.set(key,{entry,value});
    }
  }
  return conflicts;
}

export function setupBulkUpload({$,readSheets,analyze,save,publish,allowed,lock}){
  let entries=[],busy=false,revision=0,needsPublication=false;
  const input=$('bulkFiles'),body=$('bulkRows'),status=$('bulkStatus'),check=$('bulkAnalyze'),submit=$('bulkSave'),month=$('bulkMonth');
  const node=(tag,text)=>{const el=document.createElement(tag);if(text!==undefined)el.textContent=text;return el;};
  function render(){
    body.replaceChildren();
    for(const entry of entries){
      const row=node('tr'),file=node('td',entry.file.name),type=node('td'),select=node('select');
      select.setAttribute('aria-label','Tipo de base de '+entry.file.name);
      select.append(new Option('Elegí una base',''),...Object.entries(baseLabels).map(([key,label])=>new Option(label,key)));
      select.value=entry.type;select.disabled=busy||entry.state==='saved';
      select.onchange=()=>{entry.type=select.value;entry.plan=null;entry.state='pending';entry.message='Pendiente de revisión';render();};type.append(select);
      const detail=node('td',entry.message),actions=node('td'),remove=node('button','Quitar');remove.type='button';remove.className='tab';remove.disabled=busy||entry.state==='saved';
      remove.setAttribute('aria-label','Quitar '+entry.file.name);remove.onclick=()=>{entries=entries.filter(item=>item!==entry);render();};actions.append(remove);
      row.dataset.state=entry.state;row.append(file,type,detail,actions);body.append(row);
    }
    if(!entries.length){const row=node('tr'),cell=node('td','Seleccioná los archivos que querés cargar.');cell.colSpan=4;row.append(cell);body.append(row);}
    input.disabled=busy;month.disabled=busy;check.disabled=busy||!entries.length;
    submit.disabled=busy||!entries.length||entries.some(entry=>!['ready','saved'].includes(entry.state))||(!needsPublication&&entries.every(entry=>entry.state==='saved'));
    $('bulkClear').disabled=busy||!entries.length||needsPublication;
    $('bulkCount').textContent=entries.length?entries.length+' archivos seleccionados':'';
  }
  function setBusy(value){busy=value;lock(value);render();}
  input.onchange=async()=>{
    const current=++revision;setBusy(true);status.textContent='Reconociendo archivos…';
    try{
      for(const file of input.files){
        const bytes=await file.arrayBuffer(),digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),byte=>byte.toString(16).padStart(2,'0')).join('');
        if(current!==revision)return;
        if(entries.some(entry=>entry.digest===digest))continue;
        let type='',message='Pendiente de revisión';
        try{type=detectUploadBase(await readSheets(file));if(!type)message='No reconocido: elegí el tipo de base';}catch(error){message=error.message;}
        entries.push({file,digest,type,message,state:'pending',plan:null});render();
      }
      status.textContent='Revisá los tipos detectados y pulsá «Revisar archivos».';
    }catch(error){status.textContent=error.message;}
    finally{input.value='';if(current===revision)setBusy(false);}
  };
  month.onchange=()=>{for(const entry of entries)if(entry.state!=='saved'){entry.state='pending';entry.plan=null;entry.message='Pendiente de revisión';}render();};
  check.onclick=async()=>{
    if(busy||!allowed())return;const current=revision;setBusy(true);
    try{
      for(const entry of entries){
        if(entry.state==='saved')continue;
        entry.plan=null;entry.message='Revisando…';render();status.textContent='Revisando '+entry.file.name;
        try{if(!entry.type)throw Error('Elegí el tipo de base.');entry.plan=await analyze(entry.file,entry.type,month.value);if(current!==revision)return;entry.state='ready';entry.message=entry.plan.summary;}
        catch(error){if(current!==revision)return;entry.state='error';entry.message=error.message;}
        render();
      }
      const conflicts=findUploadConflicts(entries);
      for(const entry of conflicts){entry.state='error';entry.message='Conflicto: otro archivo trae valores diferentes para el mismo registro. Quitá uno y revisá otra vez.';}
      status.textContent=entries.some(entry=>entry.state==='error')?'Corregí o quitá los archivos señalados antes de cargar.':'Revisión completada. Podés cargar y publicar todo.';
    }finally{if(current===revision)setBusy(false);}
  };
  submit.onclick=async()=>{
    if(busy||submit.disabled||!allowed())return;const current=revision;setBusy(true);let active;
    try{
      for(const entry of entries){
        if(entry.state==='saved')continue;active=entry;entry.message='Cargando…';render();status.textContent='Cargando '+entry.file.name;
        // Una escritura parcial puede necesitar publicación aunque este archivo falle.
        if(['productividad','holds','finalizadas'].includes(entry.type))needsPublication=true;
        await save(entry.file,entry.type,entry.plan);if(current!==revision)return;
        entry.state='saved';entry.message='Cargado';render();
      }
      active=null;
      if(needsPublication){status.textContent='Publicando los KPI actualizados…';await publish();if(current!==revision)return;needsPublication=false;}
      status.textContent='Carga conjunta completada y publicada.';
    }catch(error){if(current!==revision)return;if(active){active.state='error';active.message=error.message;}status.textContent='Carga incompleta. '+error.message+' Los archivos completados se conservan; revisá y reintentá los pendientes.';}
    finally{if(current===revision)setBusy(false);}
  };
  $('bulkClear').onclick=()=>{entries=[];status.textContent='';render();};
  function reset(){++revision;entries=[];busy=false;needsPublication=false;input.value='';status.textContent='';lock(false);render();}
  render();return {reset};
}
