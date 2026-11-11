const assert = require('node:assert/strict');
const {test,after} = require('node:test');
const {createRequire} = require('node:module');
const {setTimeout:pause} = require('node:timers/promises');
const web = createRequire(require('node:path').resolve(__dirname,'../desktop/package.json'));
const apps = [];
let admin;
const live = Boolean(process.env.FIRESTORE_EMULATOR_HOST && process.env.FIREBASE_AUTH_EMULATOR_HOST);
test('Spark importa y protege auditorías, estados y avisos sin Cloud Functions',{skip:!live,timeout:90000},async()=>{
  const {createSparkAudits,observeSparkNotices,auditScope,auditReviewTotals} = await import('../auditorias-spark.mjs');
  const projectId = 'demo-dashboard-kpi';
  admin = require('firebase-admin/app').initializeApp({projectId});
  const backend = require('firebase-admin/firestore').getFirestore(admin);
  const app = web('firebase/app'), auth = web('firebase/auth'), store = web('firebase/firestore');
  async function account(name,profile) {
    const instance = app.initializeApp({projectId,apiKey:'demo-key'},name);
    apps.push(instance);
    const login = auth.getAuth(instance);
    auth.connectAuthEmulator(login,'http://'+process.env.FIREBASE_AUTH_EMULATOR_HOST,{disableWarnings:true});
    const {user} = await auth.createUserWithEmailAndPassword(login,name+'@example.test','password123');
    const db = store.getFirestore(instance);
    const [host,port] = process.env.FIRESTORE_EMULATOR_HOST.split(':');
    store.connectFirestoreEmulator(db,host,Number(port));
    await backend.collection('usuarios').doc(user.uid).set(profile);
    const api = {...store,db,currentUid:()=>login.currentUser?.uid,currentMeli:()=>profile.idMeli,currentRole:()=>profile.rol};
    return {uid:user.uid,db,profile:{uid:user.uid,role:profile.rol,team:profile.equipo,idMeli:profile.idMeli,global:profile.rol==='pm'},
      api, call:createSparkAudits(api)};
  }
  const pm = await account('pm',{rol:'pm'});
  const tl = await account('tl',{rol:'tl',equipo:'A'});
  const another = await account('other-tl',{rol:'tl',equipo:'B'});
  const person = await account('employee',{rol:'catalogador',equipo:'A',idMeli:'001',usuario:'NET_TEST'});
  const outsider = await account('outsider',{rol:'catalogador',equipo:'B',idMeli:'002'});
  const row = (externo,fila,idMeli='NET_TEST') => ({externo,fila,idMeli,hoja:'Datos',fecha:'2026-10-02',resultado:'Original'});
  const filas = [...Array.from({length:9},(_,i)=>row('a'+i,i+2)),row('a0',12),row('pendiente',13,'desconocido'),{...row('bad',14),fecha:'2026-02-30'}];
  const req = {archivo:'auditorias.csv',filas};
  const imported = confirm => pm.call('auditoriasImportar',{...req,confirmar:confirm});
  const preview = await imported(false);
  assert.deepEqual([preview.validas.length,preview.incidencias.length,preview.duplicadas.length,preview.rechazadas.length],[9,1,1,1]);
  await assert.rejects(tl.call('auditoriasImportar',{...req,confirmar:false}),{code:'permission-denied'});
  const result = await imported(true);
  assert.deepEqual([result.publicadas,result.pendientes,result.duplicadas,result.rechazadas],[9,1,1,1]);
  assert.equal((await imported(true)).repetida,true);
  const audits = store.collection(person.db,'auditorias');
  const mine = await store.getDocs(store.query(audits,store.where('colaboradorUid','==',person.uid)));
  assert.equal(mine.size,9);
  const [first,second] = mine.docs;
  await assert.rejects(store.getDocs(audits),{code:'permission-denied'});
  await assert.rejects(store.getDoc(store.doc(outsider.db,first.ref.path)),{code:'permission-denied'});
  await assert.rejects(store.updateDoc(first.ref,{resultado:'Falso'}),{code:'permission-denied'});
  await assert.rejects(store.setDoc(store.doc(audits,'falso'),first.data()),{code:'permission-denied'});
  await assert.rejects(store.updateDoc(first.ref,{estado:'pendiente_tl',
    respuesta:{uid:outsider.uid,accion:'responder',texto:'Suplantación',fecha:store.serverTimestamp()}}),{code:'permission-denied'});

  const stops=[], inbox = new Map();
  function subscribe(account) {
    const watch = (target,next,error)=>store.onSnapshot(target,next,error);
    stops.push(...observeSparkNotices(account.api,account.profile,watch,items=>inbox.set(account.uid,items)));
  }
  const until = async (account,type) => {
    for (let i=0;i<60;i++){
      const item=inbox.get(account.uid)?.find(item=>item.tipo===type);
      if(item)return item;
      await pause(150);
    }
    assert.fail('No apareció aviso '+type);
  };
  for (const account of [person,tl,outsider,another,pm]) subscribe(account);
  try {
    const notice = await until(person,'auditoria_nueva');
    assert.match(notice.mensaje,/9 nuevas/);
    const receipt = store.doc(person.db,'usuarios',person.uid,'lecturas_avisos',notice.id);
    await store.setDoc(receipt,{leidaEn:store.serverTimestamp()});
    assert.ok((await store.getDocFromServer(receipt)).data().leidaEn);
    await assert.rejects(store.getDoc(store.doc(outsider.db,receipt.path)),{code:'permission-denied'});
    await assert.rejects(store.setDoc(store.doc(outsider.db,receipt.path),{leidaEn:store.serverTimestamp()}),{code:'permission-denied'});
    await assert.rejects(store.setDoc(store.doc(person.db,'usuarios',person.uid,'notificaciones','falsa'),{titulo:'Falso'}),{code:'permission-denied'});

    const attempts = await Promise.allSettled([1,2].map(()=>person.call('auditoriasActuar',{id:first.id,accion:'responder',texto:'Respuesta'})));
    assert.equal(attempts.filter(item=>item.status==='fulfilled').length,1);
    assert.equal((await until(tl,'auditoria_respuesta')).auditoriaId,first.id);
    assert.equal(inbox.get(another.uid)?.some(item=>item.tipo==='auditoria_respuesta'),false);
    await assert.rejects(another.call('auditoriasActuar',{id:first.id,accion:'aprobar',texto:''}),{code:'permission-denied'});
    await assert.rejects(pm.call('auditoriasActuar',{id:first.id,accion:'aprobar',texto:''}),/cambió de estado/);
    assert.equal((await tl.call('auditoriasActuar',{id:first.id,accion:'aprobar',texto:''})).estado,'pendiente_pm');
    assert.equal((await until(pm,'auditoria_revision_pm')).auditoriaId,first.id);
    assert.equal(inbox.get(person.uid)?.some(item=>item.tipo==='auditoria_cierre'),false);
    const tlCopy = store.doc(tl.db,first.ref.path);
    await assert.rejects(store.updateDoc(tlCopy,{estado:'cerrada_aprobada',
      decisionPm:{accion:'aprobar',texto:'Falso',uid:tl.uid,fecha:store.serverTimestamp()}}),{code:'permission-denied'});
    await pm.call('auditoriasActuar',{id:first.id,accion:'aprobar',texto:''});
    await person.call('auditoriasActuar',{id:second.id,accion:'devolver',texto:'Revisar'});
    await tl.call('auditoriasActuar',{id:second.id,accion:'rechazar',texto:'Decisión'});
    await pm.call('auditoriasActuar',{id:second.id,accion:'rechazar',texto:'Cierre PM'});
    assert.equal((await store.getDocFromServer(first.ref)).data().resultado,'Original');
    assert.equal((await store.getDocFromServer(second.ref)).data().estado,'cerrada_rechazada');
    const metrics = auditReviewTotals((await store.getDocs(store.query(audits,store.where('colaboradorUid','==',person.uid)))).docs.map(doc=>doc.data()));
    assert.deepEqual(metrics,{revisaron:0,sinRevisar:1,aprobadasTl:1,rechazadasTl:1,pendientesPm:0,aprobadasPm:1,rechazadasPm:1});
    await until(person,'auditoria_cierre');
    await assert.rejects(person.call('auditoriasActuar',{id:first.id,accion:'responder',texto:'Reabrir'}),/cambió de estado/);

    const pending = (await store.getDocs(store.query(store.collection(pm.db,'auditorias'),store.where('estado','==','sin_asignar')))).docs[0];
    await assert.rejects(pm.call('auditoriasAsignar',{id:pending.id,colaboradorUid:person.uid,tlUid:another.uid}),/TL/);
    await pm.call('auditoriasAsignar',{id:pending.id,colaboradorUid:person.uid,tlUid:tl.uid});
    assert.equal((await store.getDocFromServer(store.doc(person.db,pending.ref.path))).data().estado,'pendiente_colaborador');

    await store.setDoc(store.doc(pm.db,'kpi_publicados','001'),{equipo:'A',publicadoEn:store.serverTimestamp(),
      tareas:[{cantidad:1}],holds:[{cantidad:2}],gestion:[{total:3}]});
    for (const type of ['productividad','holds','finalizadas']) {
      await until(person,type); await until(tl,type);
    }
    assert.equal(inbox.get(outsider.uid)?.some(item=>item.tipo==='productividad'),false);
    await store.setDoc(store.doc(pm.db,'calidad_config','objetivo'),{valor:90,actualizadoEn:store.serverTimestamp()});
    await until(person,'meta');
    await assert.rejects(store.setDoc(store.doc(person.db,'calidad_config','objetivo'),{valor:1,actualizadoEn:store.serverTimestamp()}),
      {code:'permission-denied'});
    await backend.collection('kpis').doc('3').set({idMeli:'3',equipo:'A',nombre:'ext_cuenta_futura'});
    const delayed = {archivo:'cuenta-futura.csv',filas:[row('cuenta-futura',2,'ext_cuenta_futura')]};
    assert.equal((await pm.call('auditoriasImportar',{...delayed,confirmar:false})).validas.length,1);
    assert.equal((await pm.call('auditoriasImportar',{...delayed,confirmar:true})).publicadas,1);
    const newcomer = await account('newcomer',{rol:'catalogador',equipo:'A',idMeli:3});
    const assigned = await Promise.all(auditScope(newcomer.api,newcomer.profile).map(target=>store.getDocs(target)));
    assert.equal(assigned[1].size,1);
    const futureAudit = assigned[1].docs[0];
    assert.equal(futureAudit.data().colaboradorUid,null);
    await assert.rejects(store.getDoc(store.doc(outsider.db,futureAudit.ref.path)),{code:'permission-denied'});
    await newcomer.call('auditoriasActuar',{id:futureAudit.id,accion:'responder',texto:'Cuenta habilitada'});
  } finally {stops.forEach(stop=>stop());}
});

after(async()=>{
  if(apps.length) await Promise.all(apps.map(web('firebase/app').deleteApp));
  if(admin) await require('firebase-admin/app').deleteApp(admin);
});
