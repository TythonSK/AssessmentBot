import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BACKEND_SOURCE_ROOT = path.resolve(__dirname, '../../../src/backend');

/**
 * The only legitimate top-level public functions in the backend. In Google Apps
 * Script any top-level function not ending in `_` is exposed to google.script.run,
 * so every other backend function must use a trailing underscore.
 */
const ALLOWED_PUBLIC_FUNCTIONS = Object.freeze(['apiHandler', 'doGet', 'triggerHandler']);

/**
 * Path segments that must never be scanned for exposed functions. Vendored code
 * under `scripts/builder/vendor` and dependency directories are outside the
 * backend's own surface; the scan rooted at `src/backend` already excludes them
 * by construction, and this list defends the helper against an injected vendored
 * path.
 */
const DEFAULT_EXCLUDED_PATH_SEGMENTS = Object.freeze(['node_modules', 'vendor']);

/** @param {string} relativeFilePath @param {string[]} excludedPathSegments */
function isExcludedPath(relativeFilePath, excludedPathSegments) {
  return relativeFilePath.split(/[\\/]/).some((segment) => excludedPathSegments.includes(segment));
}

/**
 * Discovers the backend source files at test time via a recursive glob over the
 * backend source root. Relative path names are returned with forward slashes.
 * Files that do not yet exist at scan time (e.g. `Triggers/triggerHandler.js`
 * before the Triggers section lands) are simply not matched, and the allowlist
 * already covers them from the start.
 *
 * @returns {string[]} relative source paths (forward-slash separated)
 */
function discoverBackendSourceFilePaths() {
  return fs
    .globSync('**/*.js', { cwd: BACKEND_SOURCE_ROOT })
    .map((relativePath) => relativePath.split(path.sep).join('/'))
    .filter((relativePath) => !isExcludedPath(relativePath, DEFAULT_EXCLUDED_PATH_SEGMENTS));
}

/**
 * Static source scan of backend files for accidental public function exposure.
 * A file is flagged when it declares a top-level `function <name>(…)` whose name
 * does not end in `_` and is not in the allowlist. Matches are anchored to line
 * starts so indented nested declarations are not false-flagged.
 *
 * @param {Record<string, string>} files - mapping of relative file path to source text
 * @param {object} [options]
 * @param {string[]} [options.allowlist] - public functions that are permitted
 * @param {string[]} [options.excludedPathSegments] - path segments whose files are skipped
 * @returns {Array<{file: string, line: number, name: string}>} flagged functions
 */
function scanForExposedPublicFunctions(files, { allowlist, excludedPathSegments } = {}) {
  const allowed = allowlist ?? ALLOWED_PUBLIC_FUNCTIONS;
  const excluded = excludedPathSegments ?? DEFAULT_EXCLUDED_PATH_SEGMENTS;
  const exposed = [];

  for (const [file, source] of Object.entries(files)) {
    if (isExcludedPath(file, excluded)) {
      continue;
    }

    source.split('\n').forEach((line, index) => {
      const declaration = line.match(/^function\s+([A-Za-z0-9_$]+)\s*\(/);
      if (declaration && !declaration[1].endsWith('_') && !allowed.includes(declaration[1])) {
        exposed.push({ file, line: index + 1, name: declaration[1] });
      }
    });
  }

  return exposed;
}

function findTopLevelFunctionNames(files) {
  const declarations = {};
  for (const [file, source] of Object.entries(files)) {
    if (isExcludedPath(file, DEFAULT_EXCLUDED_PATH_SEGMENTS)) continue;
    declarations[file] = source
      .split('\n')
      .map((line) => line.match(/^function\s+([A-Za-z0-9_$]+)\s*\(/)?.[1])
      .filter(Boolean);
  }
  return declarations;
}

/** Builds the real source map by globbing and reading every backend source file. */
function readAllBackendSourceFiles() {
  const files = {};
  for (const relativePath of discoverBackendSourceFilePaths()) {
    const absolutePath = path.join(BACKEND_SOURCE_ROOT, relativePath);
    files[relativePath] = fs.readFileSync(absolutePath, 'utf8');
  }
  return files;
}

describe('Backend global-exposure guardrail (static source scan)', () => {
  it('requires every top-level backend function to be private or allowlisted', () => {
    const files = readAllBackendSourceFiles();
    expect(Object.keys(files).length).toBeGreaterThan(0);

    const exposed = scanForExposedPublicFunctions(files, {
      allowlist: ALLOWED_PUBLIC_FUNCTIONS,
    });

    expect(exposed).toEqual([]);
  });

  it('excludes vendored code from the source scan', () => {
    const files = {
      'scripts/builder/vendor/jsondb/src/loadDatabase.js': 'function loadDatabase() {\n',
      'scripts/builder/vendor/jsondb/src/createAndInitialiseDatabase.js':
        'function createAndInitialiseDatabase() {\n',
      'src/backend/z_Api/z_apiHandler.js': 'function apiHandler() {\n',
    };

    const exposed = scanForExposedPublicFunctions(files, {
      allowlist: ALLOWED_PUBLIC_FUNCTIONS,
    });

    expect(exposed).toEqual([]);
  });

  it('flags an intentionally exposed function that lacks a trailing underscore', () => {
    const files = {
      'src/backend/SomeModule.js':
        'function legitimatePublic_() {}\nfunction accidentallyExposedHelper() {}\n',
    };

    const exposed = scanForExposedPublicFunctions(files, {
      allowlist: ALLOWED_PUBLIC_FUNCTIONS,
    });

    expect(exposed).toEqual([
      { file: 'src/backend/SomeModule.js', line: 2, name: 'accidentallyExposedHelper' },
    ]);
  });

  it('allowlists the three legitimate public entrypoints without flagging them', () => {
    const files = {
      'src/backend/z_Api/z_apiHandler.js': 'function apiHandler() {\n',
      'src/backend/z_Api/WebApp.js': 'function doGet() {\n',
      'src/backend/Triggers/triggerHandler.js': 'function triggerHandler() {\n',
    };

    const exposed = scanForExposedPublicFunctions(files, {
      allowlist: ALLOWED_PUBLIC_FUNCTIONS,
    });

    expect(exposed).toEqual([]);
  });

  it('flags already-private trailing-underscore functions only when not allowlisted', () => {
    const files = {
      'src/backend/z_Api/apiConfig.js':
        'function getBackendConfig_() {}\nfunction setBackendConfig_() {}\n  function safeSet() {}\n',
    };

    const exposed = scanForExposedPublicFunctions(files, {
      allowlist: ALLOWED_PUBLIC_FUNCTIONS,
    });

    // `safeSet` is indented (nested) so it must not be flagged.
    expect(exposed).toEqual([]);
  });

  it('keeps assignment-definition upsert helpers distinct from partial-row helpers', () => {
    const files = readAllBackendSourceFiles();
    const declarations = findTopLevelFunctionNames(files);
    const partialNames = new Set(
      declarations['z_Api/assignmentDefinition/assignmentDefinitionPartialRowValidation.js']
    );
    const upsertNames =
      declarations['z_Api/assignmentDefinition/assignmentDefinitionUpsertValidation.js'];

    expect(upsertNames.filter((name) => partialNames.has(name))).toEqual([]);
  });
});
