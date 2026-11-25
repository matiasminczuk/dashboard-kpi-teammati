import test from 'node:test';
import assert from 'node:assert/strict';
import {detectUploadBase,findUploadConflicts,setupBulkUpload} from './carga-conjunta.mjs';

test('reconoce las cinco bases por contenido y no por nombre del archivo',()=>{
  const detect=headers=>detectUploadBase([{name:'Sheet1',rows:[headers]}]);
  assert.equal(detectUploadBase([{name:'Base diaria',rows:[]},{name:'Base creaciones',rows:[]}]),'productividad');
  assert.equal(detect(['ID CDM','Colaborador','Último Hold']),'holds');
  assert.equal(detect(['Colaborador','Fecha fin','Fecha inicio','Iniciativa','Asignación','Finalización']),'finalizadas');
  assert.equal(detect(['Colaborador','Q Tareas auditadas','% Efectividad']),'calidad');
  assert.equal(detect(['Suggestion ID','Colaborador','Acción correcta']),'auditorias');
  assert.equal(detect(['Correction ID','Colaborador','Acción correcta']),'auditorias');
  assert.equal(detect(['Algo desconocido']),'');
});

test('un libro con bases mezcladas requiere selección explícita',()=>{
  assert.equal(detectUploadBase([{name:'A',rows:[['ID CDM','Colaborador','Ultimo Hold']]},{name:'B',rows:[['Colaborador','Q Tareas auditadas','% Efectividad']]}]),'');
});

test('detecta conflictos entre archivos sin confundir claves de bases independientes',()=>{
  const a={plan:{fingerprints:[['persona:tareas_2026-11-24','100']]}};
  const same={plan:{fingerprints:[['persona:tareas_2026-11-24','100']]}};
  const b={plan:{fingerprints:[['persona:tareas_2026-11-24','200']]}};
  const other={plan:{fingerprints:[['persona:gestion_2026-11-24','200']]}};
  assert.equal(findUploadConflicts([a,same,other]).size,0);
  assert.deepEqual([...findUploadConflicts([a,b,other])],[a,b]);
});

function harness(callbacks={}){
  class Element{
    constructor(){this.children=[];this.value='';this.textContent='';this.dataset={};}
    append(...values){this.children.push(...values);}
    replaceChildren(...values){this.children=values;}
    setAttribute(){}
  }
  const originalDocument=globalThis.document,originalOption=globalThis.Option;
  globalThis.document={createElement:()=>new Element()};globalThis.Option=Element;
  const nodes=new Map(),$=id=>{if(!nodes.has(id))nodes.set(id,new Element());return nodes.get(id);};
  const saved=[],published=[];
  const api=setupBulkUpload({$,allowed:()=>true,lock(){},
    readSheets:async()=>[{name:'Datos',rows:[['ID CDM','Colaborador','Ultimo Hold']]}],
    analyze:async file=>({summary:'Listo',fingerprints:[[file.name,file.name]]}),
    save:async file=>saved.push(file.name),publish:async()=>published.push(true),...callbacks});
  return {$,api,saved,published,restore(){globalThis.document=originalDocument;globalThis.Option=originalOption;}};
}

test('reintenta el archivo fallido sin volver a guardar los que ya se completaron',async()=>{
  const calls=[];let fail=true;
  const h=harness({save:async file=>{calls.push(file.name);if(file.name==='b.csv'&&fail){fail=false;throw Error('Sin conexión');}}});
  try{
    h.$('bulkFiles').files=[new File(['a'],'a.csv'),new File(['b'],'b.csv')];
    await h.$('bulkFiles').onchange();await h.$('bulkAnalyze').onclick();
    assert.deepEqual(calls,[]);assert.equal(h.$('bulkSave').disabled,false);
    await h.$('bulkSave').onclick();assert.match(h.$('bulkStatus').textContent,/Carga incompleta/);
    await h.$('bulkAnalyze').onclick();await h.$('bulkSave').onclick();
    assert.deepEqual(calls,['a.csv','b.csv','b.csv']);assert.equal(h.published.length,1);
    assert.match(h.$('bulkStatus').textContent,/completada y publicada/);
  }finally{h.restore();}
});

test('reintenta solo la publicación si todos los archivos ya fueron guardados',async()=>{
  let attempts=0;
  const h=harness({publish:async()=>{if(++attempts===1)throw Error('Publicación interrumpida');}});
  try{
    h.$('bulkFiles').files=[new File(['a'],'a.csv')];
    await h.$('bulkFiles').onchange();await h.$('bulkAnalyze').onclick();await h.$('bulkSave').onclick();
    assert.equal(h.$('bulkSave').disabled,false);assert.equal(h.$('bulkClear').disabled,true);
    await h.$('bulkSave').onclick();assert.deepEqual(h.saved,['a.csv']);assert.equal(attempts,2);
  }finally{h.restore();}
});

test('descarta archivos de contenido idéntico aunque tengan nombres diferentes',async()=>{
  const h=harness();
  try{
    h.$('bulkFiles').files=[new File(['same'],'a.csv'),new File(['same'],'copia.csv')];
    await h.$('bulkFiles').onchange();assert.equal(h.$('bulkCount').textContent,'1 archivos seleccionados');
  }finally{h.restore();}
});
