/** Phase 6 S4 contract step, C0a: source control path rules, limits, defaults and the shared types. */
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  isManagedPath,
  type PullResult,
  type PullWorkFolderBody,
  type PushResult,
  type PushWorkFolderBody,
  parseManagedPath,
  pathFor,
  SOURCE_CONTROL_DEFAULTS,
  SOURCE_CONTROL_LIMITS,
  SOURCE_CONTROL_PATHS,
  type SourceControlledFile,
  type SourceControlledFileStatus,
  type SourceControlledFileType,
  type SourceControlPreferences,
} from '../src';

const ID = '3f2b8c1e-9a4d-4e7f-8b21-0c5d6e7f8a9b';
const TYPES: SourceControlledFileType[] = [
  'workflow',
  'credential',
  'variables',
  'tags',
  'folders',
  'datatable',
  'project',
];
const PER_RESOURCE: Array<[SourceControlledFileType, string]> = [
  ['workflow', 'workflows'],
  ['credential', 'credential_stubs'],
  ['datatable', 'datatables'],
  ['project', 'projects'],
];
const SINGLE: Array<[SourceControlledFileType, string]> = [
  ['variables', 'variable_stubs.json'],
  ['tags', 'tags.json'],
  ['folders', 'folders.json'],
];

describe('SOURCE_CONTROL_PATHS', () => {
  it('has one rule per file type and nothing else', () => {
    expect(Object.keys(SOURCE_CONTROL_PATHS).sort()).toEqual([...TYPES].sort());
  });

  describe.each(PER_RESOURCE)('%s rule', (type, folder) => {
    const rule = SOURCE_CONTROL_PATHS[type];
    it('accepts its form', () => {
      expect(rule.test(`${folder}/${ID}.json`)).toBe(true);
      expect(isManagedPath(`${folder}/${ID}.json`)).toBe(true);
    });
    it.each([
      ['../', `${folder}/../${ID}.json`],
      ['leading ../', `../${folder}/${ID}.json`],
      ['absolute', `/${folder}/${ID}.json`],
      ['drive letter', `C:/${folder}/${ID}.json`],
      ['nested folder', `${folder}/sub/${ID}.json`],
      ['nested root', `x/${folder}/${ID}.json`],
      ['other extension', `${folder}/${ID}.js`],
      ['double extension', `${folder}/${ID}.json.bak`],
      ['backslash', `${folder}\\${ID}.json`],
      ['dot prefix', `./${folder}/${ID}.json`],
      ['not a uuid', `${folder}/abc.json`],
      ['upper case uuid', `${folder}/${ID.toUpperCase()}.json`],
      ['trailing newline', `${folder}/${ID}.json\n`],
      ['empty name', `${folder}/.json`],
    ])('refuses %s', (_label, path) => {
      expect(rule.test(path)).toBe(false);
      expect(isManagedPath(path)).toBe(false);
    });
  });

  describe.each(SINGLE)('%s rule', (type, file) => {
    const rule = SOURCE_CONTROL_PATHS[type];
    it('accepts its form', () => {
      expect(rule.test(file)).toBe(true);
      expect(isManagedPath(file)).toBe(true);
    });
    it.each([
      ['../', `../${file}`],
      ['absolute', `/${file}`],
      ['nested folder', `sub/${file}`],
      ['other extension', file.replace(/\.json$/, '.yaml')],
      ['double extension', `${file}.bak`],
      ['dot prefix', `./${file}`],
    ])('refuses %s', (_label, path) => {
      expect(rule.test(path)).toBe(false);
      expect(isManagedPath(path)).toBe(false);
    });
  });

  it('refuses anything outside the seven rules', () => {
    for (const path of ['', '.git/config', 'README.md', 'workflows/', 'workflows', 'tags.json/']) {
      expect(isManagedPath(path)).toBe(false);
    }
  });
});

describe('pathFor', () => {
  it.each(TYPES)('round trips %s', (type) => {
    const path = pathFor(type, ID);
    expect(isManagedPath(path)).toBe(true);
    expect(SOURCE_CONTROL_PATHS[type].test(path)).toBe(true);
    const parsed = parseManagedPath(path);
    expect(parsed?.type).toBe(type);
    if (PER_RESOURCE.some(([t]) => t === type)) expect(parsed?.id).toBe(ID);
    else expect(parsed?.id).toBeUndefined();
  });

  it('gives the fixed paths', () => {
    expect(pathFor('workflow', ID)).toBe(`workflows/${ID}.json`);
    expect(pathFor('credential', ID)).toBe(`credential_stubs/${ID}.json`);
    expect(pathFor('datatable', ID)).toBe(`datatables/${ID}.json`);
    expect(pathFor('project', ID)).toBe(`projects/${ID}.json`);
    expect(pathFor('variables')).toBe('variable_stubs.json');
    expect(pathFor('tags')).toBe('tags.json');
    expect(pathFor('folders')).toBe('folders.json');
  });

  it.each(['../x', `../${ID}`, `${ID}/x`, 'abc', '', ID.toUpperCase()])('refuses the id %j', (id) => {
    for (const [type] of PER_RESOURCE) expect(() => pathFor(type, id)).toThrow();
  });

  it('refuses a missing id for a per-resource type', () => {
    expect(() => pathFor('workflow')).toThrow();
  });

  it('parseManagedPath answers undefined for an unmanaged path', () => {
    expect(parseManagedPath('../tags.json')).toBeUndefined();
  });
});

describe('limits and defaults', () => {
  it('uses n8n package numbers', () => {
    expect(SOURCE_CONTROL_LIMITS).toEqual({ totalBytes: 314572800, fileBytes: 5242880, files: 5000 });
    expect(SOURCE_CONTROL_LIMITS.totalBytes).toBe(300 * 1024 * 1024);
    expect(SOURCE_CONTROL_LIMITS.fileBytes).toBe(5 * 1024 * 1024);
    expect(Object.isFrozen(SOURCE_CONTROL_LIMITS)).toBe(true);
  });

  it('has the defaults', () => {
    expect(SOURCE_CONTROL_DEFAULTS).toEqual({
      branchName: 'main',
      branchColor: '#5296D6',
      commitMessage: 'Updated Workfolder',
    });
    expect(Object.isFrozen(SOURCE_CONTROL_DEFAULTS)).toBe(true);
  });
});

describe('types', () => {
  it('SourceControlledFile has n8n field names', () => {
    const file: SourceControlledFile = {
      file: pathFor('workflow', ID),
      id: ID,
      name: 'My flow',
      type: 'workflow',
      status: 'modified',
      location: 'local',
      conflict: false,
      updatedAt: '2026-11-11T00:00:00.000Z',
      pushed: false,
      isLocalPublished: true,
      owner: { type: 'team', projectId: ID, projectName: 'Team' },
      folderPath: ['a', 'b'],
    };
    expect(file.type).toBe('workflow');
    expectTypeOf<SourceControlledFile['status']>().toEqualTypeOf<SourceControlledFileStatus>();
    expectTypeOf<SourceControlledFileStatus>().toEqualTypeOf<
      'new' | 'modified' | 'deleted' | 'created' | 'renamed' | 'conflicted' | 'unknown'
    >();
    expectTypeOf<SourceControlledFile['location']>().toEqualTypeOf<'local' | 'remote'>();
  });

  it('SourceControlPreferences has no secret field', () => {
    const prefs: SourceControlPreferences = {
      connected: false,
      branchName: SOURCE_CONTROL_DEFAULTS.branchName,
      branchReadOnly: false,
      branchColor: SOURCE_CONTROL_DEFAULTS.branchColor,
    };
    expect(prefs.connected).toBe(false);
    expectTypeOf<keyof SourceControlPreferences>().toEqualTypeOf<
      | 'connected'
      | 'repositoryUrl'
      | 'branchName'
      | 'branchReadOnly'
      | 'branchColor'
      | 'connectionType'
      | 'keyGeneratorType'
      | 'publicKey'
      | 'httpsUsername'
    >();
  });

  it('push and pull bodies and results', () => {
    const push: PushWorkFolderBody = { fileNames: [{ id: ID, type: 'workflow' }], commitMessage: 'x' };
    const pull: PullWorkFolderBody = { force: true, autoPublish: 'published' };
    const pushed: PushResult = { files: [], commit: 'abc' };
    const pulled: PullResult = { files: [], publishingErrors: [], contentImportPolicy: [] };
    expect([push, pull, pushed, pulled]).toHaveLength(4);
    expectTypeOf<PullWorkFolderBody['autoPublish']>().toEqualTypeOf<
      'none' | 'all' | 'published' | undefined
    >();
    expectTypeOf<PullResult['contentImportPolicy'][number]>().toEqualTypeOf<{
      id: string;
      name: string;
      violations: string[];
    }>();
  });
});
