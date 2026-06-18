// Generates resources/plugins/hive-material-icons/ from the MIT
// material-icon-theme package: a hive plugin.json, a copy of the icon-theme
// JSON with iconPaths rewritten to ./icons/<file>.svg, and the referenced SVGs.
//
// The upstream package is fetched on demand with `npm pack` into a throwaway
// temp dir — it is NOT a project dependency. We only read its prebuilt
// `dist/material-icons.json` and static `icons/*.svg`; we never run its own
// generator, so its (5+) runtime dependencies are irrelevant. Keeping it out
// of package.json also avoids churning package-lock.json (see the repo's
// lockfile-prune gotcha on Node 25).
//
// Re-run with `npm run gen:icons` after bumping MIT_VERSION below.
import { execFileSync } from 'node:child_process';
import {
  readFile,
  writeFile,
  mkdir,
  mkdtemp,
  copyFile,
  rm,
  readdir,
} from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const MIT_VERSION = '5.35.0';
const PLUGIN_VERSION = '1.0.0';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(repoRoot, 'resources', 'plugins', 'hive-material-icons');
const OUT_ICONS = join(OUT, 'icons');

// --- fetch + unpack the upstream tarball into a temp dir ---------------------
const work = await mkdtemp(join(tmpdir(), 'material-icons-'));
try {
  const spec = `material-icon-theme@${MIT_VERSION}`;
  console.log(`Packing ${spec} …`);
  const out = execFileSync('npm', ['pack', spec, '--silent'], {
    cwd: work,
    encoding: 'utf8',
  });
  const tarball = out.trim().split('\n').pop();
  execFileSync('tar', ['-xzf', tarball], { cwd: work });
  const pkg = join(work, 'package');

  const theme = JSON.parse(
    await readFile(join(pkg, 'dist', 'material-icons.json'), 'utf8'),
  );
  const iconsSrcDir = join(pkg, 'icons');

  // --- rewrite + copy --------------------------------------------------------
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT_ICONS, { recursive: true });

  const outDefs = {};
  let copied = 0;
  for (const [id, def] of Object.entries(theme.iconDefinitions ?? {})) {
    if (typeof def?.iconPath !== 'string') continue; // skip font-only defs
    const svgName = basename(def.iconPath);
    await copyFile(join(iconsSrcDir, svgName), join(OUT_ICONS, svgName));
    outDefs[id] = { iconPath: './icons/' + svgName };
    copied++;
  }

  const outTheme = {
    iconDefinitions: outDefs,
    file: theme.file,
    folder: theme.folder,
    folderExpanded: theme.folderExpanded,
    fileExtensions: theme.fileExtensions ?? {},
    fileNames: theme.fileNames ?? {},
    folderNames: theme.folderNames ?? {},
    folderNamesExpanded: theme.folderNamesExpanded ?? {},
    languageIds: theme.languageIds ?? {},
  };
  await writeFile(join(OUT, 'material-icons.json'), JSON.stringify(outTheme));

  const manifest = {
    id: 'hive/material-icons',
    name: 'Material Icon Theme',
    version: PLUGIN_VERSION,
    publisher: 'hive',
    description:
      'Colourful Material file icons (port of PKief/material-icon-theme, MIT).',
    contributes: {
      iconThemes: [
        { id: 'material', label: 'Material', path: './material-icons.json' },
      ],
    },
  };
  await writeFile(join(OUT, 'plugin.json'), JSON.stringify(manifest, null, 2));

  await copyFile(join(pkg, 'LICENSE'), join(OUT, 'LICENSE'));

  // Sanity: every referenced SVG landed.
  const written = (await readdir(OUT_ICONS)).length;
  console.log(
    `Generated ${OUT}\n  ${copied} icon definitions, ${written} SVGs, from material-icon-theme@${MIT_VERSION}.`,
  );
} finally {
  await rm(work, { recursive: true, force: true });
}
