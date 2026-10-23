import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDocument, createPixelBuffer, replaceLayer } from '../core/document/ops';
import type { EditorDocument } from '../core/document/types';
import {
  clearAllProjects,
  clearAutosave,
  deleteProjectRecord,
  estimateStorage,
  getAutosave,
  getProjectRecord,
  listProjects,
  openDb,
  putAutosave,
  saveProjectRecord,
} from './indexedDb';
import { parseProject, serializeProject } from './projectFormat';

function makeDoc(name = 'doc', value = 7): EditorDocument {
  const base = createDocument({ name, width: 1, height: 1, layers: [], now: 1000 });
  const pixels = createPixelBuffer(1, 1, 0);
  pixels.data.set([value, 0, 0, 255]);
  return replaceLayer(base, base.layers[0].id, { ...base.layers[0], pixels });
}

async function putProject(id: string, name: string, savedAt: number, value = 7) {
  const doc = makeDoc(name, value);
  const data = await serializeProject(doc, { codec: 'raw' });
  await saveProjectRecord({
    id,
    name,
    width: doc.width,
    height: doc.height,
    layerCount: doc.layers.length,
    modifiedAt: savedAt,
    savedAt,
    data,
  });
}

beforeEach(async () => {
  await clearAllProjects();
  await clearAutosave();
});

describe('project store', () => {
  it('saves and reloads a project document', async () => {
    await putProject('p1', 'Sunset', 1000);
    const record = await getProjectRecord('p1');
    expect(record).not.toBeNull();
    expect(record!.name).toBe('Sunset');
    expect(record!.layerCount).toBe(1);

    const doc = await parseProject(record!.data);
    expect(doc.name).toBe('Sunset');
    expect(Array.from(doc.layers[0].pixels.data)).toEqual([7, 0, 0, 255]);
  });

  it('returns null for missing projects', async () => {
    expect(await getProjectRecord('missing')).toBeNull();
  });

  it('lists project metadata newest-first without payloads', async () => {
    await putProject('a', 'A', 100);
    await putProject('b', 'B', 300);
    await putProject('c', 'C', 200);

    const list = await listProjects();
    expect(list.map((p) => p.id)).toEqual(['b', 'c', 'a']);
    expect(Object.keys(list[0])).not.toContain('data');
  });

  it('upserts an existing project id', async () => {
    await putProject('a', 'A', 100);
    await putProject('a', 'A renamed', 400);
    const list = await listProjects();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('A renamed');
    expect(list[0].savedAt).toBe(400);
  });

  it('deletes a project', async () => {
    await putProject('x', 'X', 1);
    await deleteProjectRecord('x');
    expect(await getProjectRecord('x')).toBeNull();
    expect(await listProjects()).toHaveLength(0);
  });

  it('opens a usable database handle', async () => {
    const db = await openDb();
    expect(db.objectStoreNames.contains('projects')).toBe(true);
    expect(db.objectStoreNames.contains('autosave')).toBe(true);
    // Note: never close() — openDb() caches this handle for the app's lifetime.
  });

  it('returns a well-shaped storage estimate or null', async () => {
    const est = await estimateStorage();
    expect(est === null || (typeof est.usage === 'number' && typeof est.quota === 'number')).toBe(true);
  });
});

describe('autosave store', () => {
  it('stores and reads back the current autosave', async () => {
    const doc = makeDoc('WIP');
    const data = await serializeProject(doc, { codec: 'raw' });
    await putAutosave({ key: 'current', savedAt: 123, name: 'WIP', data });

    const saved = await getAutosave();
    expect(saved).not.toBeNull();
    expect(saved!.name).toBe('WIP');
    expect(saved!.savedAt).toBe(123);
    const restored = await parseProject(saved!.data);
    expect(restored.name).toBe('WIP');
  });

  it('overwrites the previous autosave', async () => {
    const first = await serializeProject(makeDoc('first'), { codec: 'raw' });
    const second = await serializeProject(makeDoc('second'), { codec: 'raw' });
    await putAutosave({ key: 'current', savedAt: 1, name: 'first', data: first });
    await putAutosave({ key: 'current', savedAt: 2, name: 'second', data: second });
    const saved = await getAutosave();
    expect(saved!.name).toBe('second');
    expect(saved!.savedAt).toBe(2);
  });

  it('returns null when nothing was saved', async () => {
    expect(await getAutosave()).toBeNull();
  });

  it('clears the autosave only', async () => {
    await putProject('keep', 'Keep', 1);
    await putAutosave({ key: 'current', savedAt: 1, name: 'tmp', data: await serializeProject(makeDoc('tmp')) });
    await clearAutosave();
    expect(await getAutosave()).toBeNull();
    expect(await listProjects()).toHaveLength(1);
  });
});

describe('clearAllProjects', () => {
  it('wipes both stores', async () => {
    await putProject('p', 'P', 1);
    await putAutosave({ key: 'current', savedAt: 1, name: 's', data: await serializeProject(makeDoc('s')) });
    await clearAllProjects();
    expect(await listProjects()).toHaveLength(0);
    expect(await getAutosave()).toBeNull();
  });
});
