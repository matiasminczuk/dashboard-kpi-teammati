export async function resetImportedData({root, children, remove, progress}) {
  const groups = [
    ['kpis', ['registros', 'semanas'], false],
    ['bases_calidad', ['hojas'], true],
    ['auditorias', ['historial'], true],
    ['usuarios', ['lecturas_avisos', 'notificaciones'], false],
    ['calidad_publicada', [], true],
    ['kpi_publicados', [], true],
    ['importaciones_auditorias', [], true],
    ['importaciones', [], true]
  ];
  async function scan() {
    const descendants = [], parents = [];
    for (const [name, subcollections, deleteParent] of groups) {
      const documents = await root(name);
      for (const document of documents) {
        for (const subcollection of subcollections) {
          descendants.push(...await children(document, subcollection));
        }
      }
      if (deleteParent) parents.push(...documents);
    }
    return [descendants, parents];
  }

  // Verify access to every affected collection before making the first deletion.
  const phases = await scan();
  const total = phases.reduce((count, phase) => count + phase.length, 0);
  let deleted = 0;
  for (const phase of phases) {
    for (let offset = 0; offset < phase.length; offset += 200) {
      const batch = phase.slice(offset, offset + 200);
      await remove(batch);
      deleted += batch.length;
      progress(deleted, total);
    }
  }
  const remaining = await scan();
  if (remaining.some(phase => phase.length)) {
    throw Error('Quedaron datos pendientes. Cerrá las otras sesiones de carga y volvé a ejecutar el reinicio.');
  }
  return deleted;
}
