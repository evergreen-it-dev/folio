#!/usr/bin/env node
/**
 * Does the native half of @cursor/sdk load in THIS environment?
 *
 * Folio AI runs through @cursor/sdk. Since 1.0.35 the SDK's platform package
 * (@cursor/sdk-<platform>-<arch>) ships glibc-linked native addons
 * (vendor/tree-sitter/binding.node and the bash grammar next to it) beside its
 * static helpers. npm installs that package on Alpine without complaint (it
 * declares no `libc`, and there is no musl variant), but without a glibc
 * compatibility layer the addon fails to load, and so does the FIRST assistant
 * run of every user:
 *   Error loading shared library ld-linux-x86-64.so.2 (needed by …/binding.node)
 * Nothing at build or boot time notices: typecheck, tests and /api/health stay
 * green. The Dockerfile runs this script after `npm ci`, so an image that
 * cannot start the assistant is never built.
 *
 *   node server/assistant/nativeCheck.mjs          the platform package itself
 *   node server/assistant/nativeCheck.mjs --sdk    + the real SDK, driven the
 *                                                  way cursorRuntime.ts drives it
 *
 * Keyless and offline: nothing here needs a Cursor API key or the network.
 * Every load happens in a child process, so a native crash is reported as a
 * failure instead of taking the checker down. Exit code: 0 fine, 1 a native
 * part cannot load, 2 the check itself cannot run.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const SELF = fileURLToPath(import.meta.url);

// Messages that mean "a native library did not load" (as opposed to the
// network error a healthy --sdk run ends with). `before initialization` is
// what every attempt AFTER the first one reports: the SDK's lazily loaded
// chunk is left half-evaluated by the failed load and stays broken until the
// process restarts.
const NATIVE_ERROR =
  /shared library|ld-linux|before initialization|TREE_SITTER|dlopen|GLIBC_|undefined symbol|cannot open shared object/i;

const firstLine = (value, max = 400) => String(value instanceof Error ? value.message : value).trim().split('\n')[0].slice(0, max);

/** Runs `node -e <code>` and reports how it ended; a signal (SIGSEGV…) counts as a failure. */
function inChild(code, args = []) {
  const res = spawnSync(process.execPath, ['-e', code, ...args], { encoding: 'utf8', timeout: 60_000 });
  if (res.error) return { ok: false, message: firstLine(res.error) };
  if (res.signal) return { ok: false, message: `process killed by ${res.signal}` };
  if (res.status !== 0) {
    // A failed require prints the source line first and the error below it.
    const text = res.stderr || res.stdout || `exit ${res.status}`;
    return { ok: false, message: firstLine(text.match(/^\w*Error\b.*$/m)?.[0] ?? text) };
  }
  return { ok: true, message: firstLine(res.stdout, 200) };
}

/**
 * --sdk, in its own process: the real SDK driven the way cursorRuntime.ts
 * drives it — Agent.create, then agent.send(), which is where the SDK loads its
 * local executor and, with it, the natives. The backend is a dead local port
 * and the model catalog comes from the environment (the SDK's own test hook),
 * so nothing leaves the machine. A healthy install gets through send() (the run
 * itself would only retry the dead backend for ~15 s and is not waited for); a
 * broken one throws a native-library error from send().
 */
async function sdkRun() {
  const home = mkdtempSync(join(tmpdir(), 'folio-native-check-'));
  try {
    process.env.HOME = home;
    process.env.CURSOR_BACKEND_URL = 'http://127.0.0.1:9';
    process.env.CURSOR_SDK_LOCAL_MODEL_CATALOG_JSON = JSON.stringify([{ id: 'auto' }]);
    const sdk = await import('@cursor/sdk');
    sdk.Cursor.configure({ local: { useHttp1ForAgent: true, store: new sdk.JsonlLocalAgentStore(join(home, 'state')) } });
    try {
      const agent = await sdk.Agent.create({
        apiKey: 'folio-native-check',
        model: { id: 'auto' },
        name: 'native-check',
        mode: 'agent',
        local: { cwd: home, settingSources: [], sandboxOptions: { enabled: false }, autoReview: false },
      });
      await agent.send('ping');
      console.log('@cursor/sdk run: Agent.create and agent.send() went through, the local executor loaded');
      return 0;
    } catch (err) {
      const message = firstLine(err);
      if (NATIVE_ERROR.test(message)) {
        console.error(message);
        return 1;
      }
      // Failed for another reason before the executor could load (the SDK's
      // test hook changed, say): inconclusive, the other checks stand alone.
      console.log(`@cursor/sdk run: inconclusive (${message.slice(0, 120)})`);
      return 0;
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

if (process.argv.includes('--sdk-run')) {
  const guard = setTimeout(() => {
    console.error('timed out after 60 s');
    process.exit(1);
  }, 60_000);
  guard.unref();
  process.exit(await sdkRun());
}

let failures = 0;
const pass = (what, detail = '') => console.log(`  ok    ${what}${detail ? ` - ${detail}` : ''}`);
const fail = (what, message) => {
  failures += 1;
  console.error(`  FAIL  ${what}\n        ${message}`);
};

function filesUnder(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...filesUnder(full));
    else out.push(full);
  }
  return out.sort();
}

const pkgName = `@cursor/sdk-${process.platform}-${process.arch}`;
console.log(`[assistant-native] ${pkgName}, node ${process.versions.node}`);

/** Does this @cursor/sdk release list a build for the platform at all? (Unknown: assume yes, so the check stays strict.) */
function sdkHasBuildFor(name) {
  try {
    let dir = dirname(require.resolve('@cursor/sdk'));
    for (let i = 0; i < 6; i += 1, dir = dirname(dir)) {
      const file = join(dir, 'package.json');
      if (!existsSync(file)) continue;
      const pkg = JSON.parse(readFileSync(file, 'utf8'));
      if (pkg.name === '@cursor/sdk') return Object.keys(pkg.optionalDependencies ?? {}).includes(name);
    }
  } catch {
    // fall through
  }
  return true;
}

let pkgDir;
try {
  pkgDir = dirname(require.resolve(`${pkgName}/package.json`));
} catch (err) {
  if (!sdkHasBuildFor(pkgName)) {
    // An architecture the SDK does not ship (riscv64, s390x…): the assistant
    // cannot run there, but the rest of Folio can, so this must not fail an
    // image build.
    console.log(`[assistant-native] @cursor/sdk has no build for ${process.platform}-${process.arch}: the assistant is unavailable here, the rest of Folio is not affected`);
    process.exit(0);
  }
  console.error(
    `[assistant-native] ${pkgName} is not installed, so @cursor/sdk would run without its native parts.\n` +
      '  (npm skips the optionalDependencies of other platforms: was node_modules copied across architectures?)\n' +
      `  ${firstLine(err)}`,
  );
  process.exit(2);
}

// 1. Every native addon the platform package ships must dlopen. The package is
// read as a whole rather than by file name, so an addon added by a later SDK
// release is covered without touching this script. The core tree-sitter addon
// goes first: that is the order the SDK loads them in.
const files = filesUnder(pkgDir);
const addons = files.filter((f) => f.endsWith('.node')).sort((a, b) => Number(b.includes('tree-sitter/')) - Number(a.includes('tree-sitter/')));
if (addons.length === 0) console.log('  note  the platform package ships no .node addons');
for (const file of addons) {
  const res = inChild('require(process.argv[1])', [file]);
  if (res.ok) pass(relative(pkgDir, file));
  else fail(relative(pkgDir, file), res.message);
}

// 2. The use the SDK makes of them: a tree-sitter parser with the bash grammar
// (agent/native/tree-sitter*.webpack.cjs). dlopen can succeed while a symbol
// still fails to resolve on first call, so parse something real.
const treeSitter = join(pkgDir, 'vendor', 'tree-sitter', 'index.js');
const treeSitterBash = join(pkgDir, 'vendor', 'tree-sitter-bash', 'index.js');
if (existsSync(treeSitter) && existsSync(treeSitterBash)) {
  const res = inChild(
    `const Parser = require(process.argv[1]);
     const parser = new Parser();
     parser.setLanguage(require(process.argv[2]));
     const tree = parser.parse('ls -la "$HOME" | grep foo > out.txt && echo done');
     const sexp = tree.rootNode.toString();
     if (tree.rootNode.type !== 'program' || !sexp.includes('pipeline') || !sexp.includes('file_redirect')) {
       throw new Error('unexpected parse tree: ' + sexp.slice(0, 160));
     }
     console.log('parsed a pipeline with a redirect');`,
    [treeSitter, treeSitterBash],
  );
  if (res.ok) pass('tree-sitter + bash grammar', res.message);
  else fail('tree-sitter + bash grammar', res.message);
}

// 3. Helper executables (ripgrep, the sandbox helper). A missing ELF
// interpreter or library surfaces as a spawn error (ENOENT/ENOEXEC) and a
// missing symbol as the loader's exit 127; a plain non-zero exit ("--policy is
// required") is the helper running. The sandbox helper is optional: Folio runs
// the SDK with the sandbox disabled (cursorRuntime.ts), and on arm64 it is a
// glibc binary that needs symbols gcompat does not provide.
const OPTIONAL_HELPERS = new Set(['cursorsandbox']);
for (const file of files.filter((f) => f.startsWith(join(pkgDir, 'bin') + '/') && (statSync(f).mode & 0o111) !== 0)) {
  const rel = relative(pkgDir, file);
  const res = spawnSync(file, ['--version'], { encoding: 'utf8', timeout: 15_000 });
  const broken = res.error
    ? firstLine(res.error)
    : res.signal
      ? `process killed by ${res.signal}`
      : res.status === 127
        ? firstLine(res.stderr || 'exit 127 (the dynamic loader could not start it)')
        : null;
  if (broken === null) pass(rel, `exit ${res.status}`);
  else if (OPTIONAL_HELPERS.has(file.split('/').pop())) console.log(`  note  ${rel} cannot run (${broken}); optional, Folio does not use the SDK sandbox`);
  else fail(rel, broken);
}

// 4. Optional: the real SDK (see sdkRun).
if (process.argv.includes('--sdk')) {
  const res = spawnSync(process.execPath, [SELF, '--sdk-run'], { encoding: 'utf8', timeout: 90_000 });
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim().split('\n').filter(Boolean).pop() ?? '';
  if (res.error) fail('@cursor/sdk run', firstLine(res.error));
  else if (res.signal) fail('@cursor/sdk run', `process killed by ${res.signal}`);
  else if (res.status !== 0) fail('@cursor/sdk run', firstLine(out));
  else pass('@cursor/sdk run', out.replace(/^@cursor\/sdk run: /, ''));
}

if (failures > 0) {
  console.error(`[assistant-native] ${failures} check(s) failed: the Folio AI assistant cannot start in this environment.`);
  if (existsSync('/etc/alpine-release')) {
    console.error('  Alpine (musl) needs a glibc compatibility layer for the SDK: `apk add gcompat libgcc` (see the Dockerfile).');
  }
  process.exit(1);
}
console.log('[assistant-native] ok');
