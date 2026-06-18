import { describe, it, expect } from 'vitest';
import { normalizeIconTheme, matchIconDef, iconPathFor } from './iconThemeDoc';

const RAW = {
  iconDefinitions: {
    _file: { iconPath: './icons/file.svg' },
    _folder: { iconPath: './icons/folder.svg' },
    _folder_open: { iconPath: './icons/folder-open.svg' },
    _java: { iconPath: './icons/java.svg' },
    _ts: { iconPath: './icons/ts.svg' },
    _testts: { iconPath: './icons/test-ts.svg' },
    _docker: { iconPath: './icons/docker.svg' },
    _src: { iconPath: './icons/folder-src.svg' },
    _src_open: { iconPath: './icons/folder-src-open.svg' },
  },
  file: '_file',
  folder: '_folder',
  folderExpanded: '_folder_open',
  fileExtensions: { java: '_java', ts: '_ts', 'test.ts': '_testts' },
  fileNames: { dockerfile: '_docker' },
  folderNames: { src: '_src' },
  folderNamesExpanded: { src: '_src_open' },
};

describe('normalizeIconTheme', () => {
  it('lowercases lookup keys and keeps defs', () => {
    const t = normalizeIconTheme(RAW);
    expect(t.fileExtensions.java).toBe('_java');
    expect(iconPathFor(t, '_java')).toBe('./icons/java.svg');
  });

  it('tolerates a missing/garbage document', () => {
    const t = normalizeIconTheme(null);
    expect(matchIconDef(t, 'x.ts', 'file', false)).toBeUndefined();
  });
});

describe('matchIconDef precedence', () => {
  const t = normalizeIconTheme(RAW);
  it('exact filename beats extension', () => {
    expect(matchIconDef(t, 'Dockerfile', 'file', false)).toBe('_docker');
  });
  it('longest compound extension wins', () => {
    expect(matchIconDef(t, 'Foo.test.ts', 'file', false)).toBe('_testts');
  });
  it('single extension', () => {
    expect(matchIconDef(t, 'Main.java', 'file', false)).toBe('_java');
  });
  it('falls back to the file default', () => {
    expect(matchIconDef(t, 'README', 'file', false)).toBe('_file');
  });
  it('folder open/closed', () => {
    expect(matchIconDef(t, 'src', 'folder', false)).toBe('_src');
    expect(matchIconDef(t, 'src', 'folder', true)).toBe('_src_open');
  });
  it('unknown folder uses folder default', () => {
    expect(matchIconDef(t, 'whatever', 'folder', false)).toBe('_folder');
    expect(matchIconDef(t, 'whatever', 'folder', true)).toBe('_folder_open');
  });
});
