# dashboard-kpi-teammati
Dashboard de productividad - Equipo Mati.M

## Calidad

En **Configuración → Cargar bases → Calidad**, elegí el Excel o CSV y revisá la vista previa. Si el archivo solo contiene totales por mes, seleccioná el mes de referencia antes de publicar. Para un CSV de una sola hoja, incluí las columnas **Origen** y **Flujo**. También podés incluir **Fecha**, **Semana** ISO (por ejemplo, `2026-W40`), **Período** (`AAAA-MM`), **Acción**, **ID auditoría** y **Errores** cuando la fuente los provea.

El archivo de referencia «Auditorías Octubre.xlsx» tiene cinco hojas de auditorías internas y de MELI, con resultados por colaborador, flujo y, cuando corresponde, acción. La efectividad es la suma de cada efectividad multiplicada por sus tareas auditadas, dividida por el total de tareas auditadas. Cada origen se consulta por separado. Los totales mensuales tienen prioridad sobre el detalle del mismo mes y grupo para evitar contar dos veces las tareas. La vista semanal requiere una fecha o semana en el origen. El conteo de errores requiere un valor explícito en todos los registros del agregado.

La identificación utiliza el ID MELI o una coincidencia única de nombre o usuario registrado en Firebase. La clave de actualización combina el catalogador, el origen, el flujo, la acción, el período y el ID de auditoría cuando existe. Reimportar una fila idéntica mantiene su resultado. Una corrección actualiza la ficha y el archivo de origen queda archivado.

Para publicar una base del importador anterior, abrí **Calidad → Usar una base ya cargada**. Elegí el archivo de Firebase, completá el mes si falta y revisá la vista previa. Al publicar se incorporan los registros faltantes y se conservan las correcciones ya publicadas.

| Ruta de Firestore | Contenido y acceso |
| --- | --- |
| `bases_calidad/{hash}` y `hojas/{bloqueId}` | Archivo de origen, mes de referencia, hojas, filas y metadatos de carga. Acceso de gestión existente. |
| `calidad_publicada/{idMeli}` | Nombre, equipo y registros con origen, flujo, acción, período, cantidad auditada, efectividad, errores y referencia a la base. Los perfiles con gestión ven todas las fichas, los TL sin delegación ven su equipo y los catalogadores su ficha. |
| `calidad_config/objetivo` | Campo `valor` entre 0 y 100, o vacío. PM y Admin pueden editarlo. |
| `importaciones/calidad_{hash}` | Registro de publicación con el archivo, las filas procesadas, la fecha y la cuenta que publicó. |

Ejecutá `node --test calidad.test.mjs` para verificar la normalización, la ponderación, la deduplicación y los filtros de Calidad.
