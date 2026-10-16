import path from 'path';
import fs from 'fs';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

// Runs MkDocs from a project-local virtual environment so contributors do not
// need a global Python install of the documentation toolchain.
//   npm run docs                 -> mkdocs serve (http://127.0.0.1:8000)
//   npm run docs -- build --strict
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const venvDir = path.join(rootDir, '.venv-docs');
const requirementsPath = path.join(rootDir, 'docs', 'requirements.txt');
const installedStampPath = path.join(venvDir, '.installed-requirements.txt');
const binDir = path.join(venvDir, process.platform === 'win32' ? 'Scripts' : 'bin');
const executableSuffix = process.platform === 'win32' ? '.exe' : '';
const venvPython = path.join(binDir, `python${executableSuffix}`);
const mkdocs = path.join(binDir, `mkdocs${executableSuffix}`);

function run(command: string, args: string[]): number {
  const result = spawnSync(command, args, { cwd: rootDir, stdio: 'inherit' });
  if (result.error) {
    throw result.error;
  }
  return result.status ?? 1;
}

function findPython(): string {
  const candidates = process.env.PYTHON ? [process.env.PYTHON] : ['python3', 'python'];
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ['--version'], { stdio: 'ignore' });
    if (!result.error && result.status === 0) {
      return candidate;
    }
  }
  throw new Error('Python 3 is required to build the documentation. Install it or set PYTHON to its path.');
}

function ensureEnvironment(): void {
  if (!fs.existsSync(venvPython)) {
    console.log('📚 Creating documentation environment in .venv-docs/ ...');
    if (run(findPython(), ['-m', 'venv', venvDir]) !== 0) {
      throw new Error('Failed to create the documentation virtual environment.');
    }
  }

  const requirements = fs.readFileSync(requirementsPath, 'utf8');
  const installed = fs.existsSync(installedStampPath) ? fs.readFileSync(installedStampPath, 'utf8') : null;
  if (installed === requirements) {
    return;
  }

  console.log('📚 Installing documentation dependencies ...');
  if (run(venvPython, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', requirementsPath]) !== 0) {
    throw new Error('Failed to install documentation dependencies.');
  }
  fs.writeFileSync(installedStampPath, requirements);
}

try {
  ensureEnvironment();
  const args = process.argv.slice(2);
  process.exitCode = run(mkdocs, args.length > 0 ? args : ['serve']);
} catch (error) {
  console.error(`❌ ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
