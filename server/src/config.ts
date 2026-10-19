import path from 'path';
import os from 'os';
import fs from 'fs';
import { randomUUID } from 'crypto';
import YAML from 'yaml';
import type { CatalogPaging } from '../../shared/types.js';

export interface ServerYamlConfig {
  port?: number;
  host?: string;
  allowed_origins?: string[];
  allowed_hosts?: string[];
}

export interface PipelineYamlConfig {
  thumbnail_quality?: number;
  auto_stack_animations?: boolean;
  auto_stack_audio?: boolean;
  default_fps?: number;
}

export const CATALOG_PAGING_MODES: readonly CatalogPaging[] = ['load-more', 'pages'];

export interface UiYamlConfig {
  catalog_paging?: CatalogPaging;
}

export interface AppYamlConfig {
  server?: ServerYamlConfig;
  data_dir?: string;
  libraries?: string[];
  projects?: string[];
  classifiers?: Record<string, Record<string, unknown>>;
  pipeline?: PipelineYamlConfig;
  ui?: UiYamlConfig;
}

export interface ServerConfig {
  port: number;
  host: string;
  dataDir: string;
  libraries: string[];
  projects: string[];
  configFilePath: string;
  defaultLibraryPath: string;
  defaultActiveProjectPath: string;
  appDataDir: string;
  cacheDirName: string; // '.assettlor'
}

export const DEFAULT_CONFIG_DIR = path.join(os.homedir(), '.config', 'assetlor');
export const DEFAULT_CONFIG_FILE = path.join(DEFAULT_CONFIG_DIR, 'config.yaml');
export const DEFAULT_DATA_DIR = path.join(DEFAULT_CONFIG_DIR, 'data');
export const DEFAULT_LIBRARY_PATH = path.join(process.cwd(), 'sample', 'assets');
export const DEFAULT_PROJECT_PATH = path.join(process.cwd(), 'sample', 'game-project');

export function createDefaultYamlConfig(): AppYamlConfig {
  return {
    server: {
      port: 3001,
      host: '127.0.0.1',
      allowed_origins: [],
      allowed_hosts: [],
    },
    data_dir: DEFAULT_DATA_DIR,
    libraries: [],
    projects: [],
    classifiers: {
      bpm: {
        enabled: true,
        minBpm: 60,
        maxBpm: 200,
        minDurationSeconds: 1.0,
        maxAnalysisSeconds: 45.0,
        applyBpmTag: false,
        applyTempoTag: false,
      },
      sprite: {
        enabled: true,
        minConfidence: 0.5,
        enableVisualAnalysis: true,
        enablePathAnalysis: true,
        enableStackAnalysis: true,
        applySpriteTag: false,
      },
      pack: {
        enabled: true,
        inferFromArchive: true,
        inferFromDirectory: true,
        directoryStrategy: 'top',
        directoryDepth: 1,
        cleanSeparators: true,
        stripVersionSuffix: true,
        stripAffixes: false,
        caseConvention: 'as-is',
        applyTag: false,
        tagPrefix: 'pack:',
        targetArchives: [],
        targetDirectories: [],
      },
    },
    pipeline: {
      thumbnail_quality: 80,
      auto_stack_animations: true,
      auto_stack_audio: true,
      default_fps: 12,
    },
    ui: {
      catalog_paging: 'load-more',
    },
  };
}

function parseCliOption(name: string): string | undefined {
  for (let i = 0; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === name) {
      // A trailing flag without a value reads as empty rather than absent.
      return i + 1 < process.argv.length ? process.argv[i + 1] : '';
    }
    if (arg.startsWith(`${name}=`)) {
      return arg.slice(name.length + 1);
    }
  }
  return undefined;
}

export function parseCliConfigArg(): string | undefined {
  return parseCliOption('--config');
}

export function parseCliGenerateConfigArg(): string | undefined {
  return parseCliOption('--generate-config');
}

export function resolveConfigPath(rawPath: string, configDir: string): string {
  if (!rawPath) return rawPath;
  if (rawPath.startsWith('~/')) {
    return path.join(os.homedir(), rawPath.slice(2));
  }
  if (path.isAbsolute(rawPath)) {
    return rawPath;
  }
  return path.resolve(configDir, rawPath);
}

export function resolveDataDir(inputDir: string): string {
  const resolved = path.resolve(inputDir);
  const base = path.basename(resolved);
  if (base === '.assettlor' || base === 'data' || base === 'cache') {
    return resolved;
  }
  return path.join(resolved, '.assettlor');
}

export class ConfigValidationError extends Error {
  readonly statusCode = 400;
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigValidationError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireInteger(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new ConfigValidationError(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ConfigValidationError(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function requireStringList(value: unknown, name: string): string[] {
  if (!Array.isArray(value)) {
    throw new ConfigValidationError(`${name} must be an array of strings`);
  }
  return value.map((entry, index) => requireString(entry, `${name}[${index}]`));
}

function readConfEnv(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
}

// The configuration written when none exists yet. ASSETTLOR_CONF_* variables
// seed it and are never consulted when an existing file is loaded.
export function createInitialYamlConfig(): AppYamlConfig {
  const initial = createDefaultYamlConfig();
  const dataDir = readConfEnv('ASSETTLOR_CONF_DATA_DIR');
  if (dataDir !== undefined) {
    // Resolve from the shell's cwd, where the variable was written, rather
    // than from the configuration directory.
    initial.data_dir = resolveConfigPath(requireString(dataDir, 'ASSETTLOR_CONF_DATA_DIR'), process.cwd());
  }
  const port = readConfEnv('ASSETTLOR_CONF_PORT');
  if (port !== undefined) {
    initial.server = {
      ...initial.server,
      port: requireInteger(Number(port), 'ASSETTLOR_CONF_PORT', 1, 65535),
    };
  }
  return initial;
}

function normalizeYamlConfig(raw: unknown, configDir: string): AppYamlConfig {
  const input = requireRecord(raw, 'Configuration');
  const defaults = createDefaultYamlConfig();
  const serverInput = input.server === undefined ? {} : requireRecord(input.server, 'server');
  const pipelineInput = input.pipeline === undefined ? {} : requireRecord(input.pipeline, 'pipeline');
  const uiInput = input.ui === undefined ? {} : requireRecord(input.ui, 'ui');
  const classifiersInput = input.classifiers === undefined
    ? {}
    : requireRecord(input.classifiers, 'classifiers');
  const classifiers: Record<string, Record<string, unknown>> = { ...defaults.classifiers };
  for (const [name, settings] of Object.entries(classifiersInput)) {
    classifiers[name] = requireRecord(settings, `classifiers.${name}`);
  }

  const server = { ...defaults.server, ...serverInput };
  if (server.port !== undefined) server.port = requireInteger(server.port, 'server.port', 1, 65535);
  if (server.host !== undefined) server.host = requireString(server.host, 'server.host');
  for (const field of ['allowed_origins', 'allowed_hosts'] as const) {
    if (server[field] !== undefined) server[field] = requireStringList(server[field], `server.${field}`);
  }

  const pipeline = { ...defaults.pipeline, ...pipelineInput };
  if (pipeline.thumbnail_quality !== undefined) {
    pipeline.thumbnail_quality = requireInteger(pipeline.thumbnail_quality, 'pipeline.thumbnail_quality', 1, 100);
  }
  if (pipeline.default_fps !== undefined) {
    pipeline.default_fps = requireInteger(pipeline.default_fps, 'pipeline.default_fps', 1, 60);
  }
  for (const field of ['auto_stack_animations', 'auto_stack_audio'] as const) {
    if (typeof pipeline[field] !== 'boolean') {
      throw new ConfigValidationError(`pipeline.${field} must be a boolean`);
    }
  }

  const ui = { ...defaults.ui, ...uiInput };
  if (!(CATALOG_PAGING_MODES as readonly unknown[]).includes(ui.catalog_paging)) {
    throw new ConfigValidationError(`ui.catalog_paging must be one of ${CATALOG_PAGING_MODES.join(', ')}`);
  }

  const dataDir = input.data_dir === undefined
    ? defaults.data_dir
    : resolveConfigPath(requireString(input.data_dir, 'data_dir'), configDir);
  const libraries = input.libraries === undefined
    ? defaults.libraries
    : requireStringList(input.libraries, 'libraries').map((p) => resolveConfigPath(p, configDir));
  const projects = input.projects === undefined
    ? defaults.projects
    : requireStringList(input.projects, 'projects').map((p) => resolveConfigPath(p, configDir));

  return {
    ...input,
    server: server as ServerYamlConfig,
    data_dir: dataDir,
    libraries,
    projects,
    classifiers,
    pipeline: pipeline as PipelineYamlConfig,
    ui: ui as UiYamlConfig,
  };
}

let currentConfigFilePath: string = DEFAULT_CONFIG_FILE;
let currentYamlConfig: AppYamlConfig = createDefaultYamlConfig();
let isMemoryOnly: boolean = Boolean(
  process.env.VITEST &&
  !parseCliConfigArg() &&
  !process.env.ASSETTLOR_CONFIG &&
  !process.env.CONFIG_PATH
);

export const config: ServerConfig = {
  port: Number(process.env.PORT) || 3001,
  host: process.env.HOST || '127.0.0.1',
  dataDir: DEFAULT_DATA_DIR,
  libraries: [],
  projects: [],
  configFilePath: currentConfigFilePath,
  defaultLibraryPath: DEFAULT_LIBRARY_PATH,
  defaultActiveProjectPath: DEFAULT_PROJECT_PATH,
  appDataDir: path.join(os.homedir(), '.assettlor'),
  cacheDirName: '.assettlor',
};

function syncConfigObject(): void {
  config.port = process.env.PORT === undefined
    ? currentYamlConfig.server?.port ?? 3001
    : requireInteger(Number(process.env.PORT), 'PORT', 1, 65535);
  config.host = process.env.HOST || currentYamlConfig.server?.host || '127.0.0.1';
  config.dataDir = resolveDataDir(currentYamlConfig.data_dir || DEFAULT_DATA_DIR);
  config.libraries = currentYamlConfig.libraries || [];
  config.projects = currentYamlConfig.projects || [];
  config.configFilePath = currentConfigFilePath;
}

export function loadConfigFile(customPath?: string): AppYamlConfig {
  const cliArg = parseCliConfigArg();
  const envArg = process.env.ASSETTLOR_CONFIG || process.env.CONFIG_PATH;
  const targetPath = customPath || cliArg || envArg || DEFAULT_CONFIG_FILE;
  const selectedPath = path.resolve(targetPath);
  const selectedMemoryOnly = Boolean(
    process.env.VITEST && !customPath && !cliArg && !envArg
  );
  const configDir = path.dirname(selectedPath);
  let candidate: AppYamlConfig;

  if (fs.existsSync(selectedPath)) {
    const content = fs.readFileSync(selectedPath, 'utf-8');
    let parsed: unknown;
    try {
      parsed = YAML.parse(content);
    } catch (err) {
      throw new ConfigValidationError(`Invalid YAML configuration at ${selectedPath}: ${String(err)}`);
    }
    if (parsed === null || parsed === undefined) {
      throw new ConfigValidationError(`Configuration at ${selectedPath} must be an object`);
    }
    candidate = normalizeYamlConfig(parsed, configDir);
  } else {
    candidate = normalizeYamlConfig(createInitialYamlConfig(), configDir);
    if (!selectedMemoryOnly) {
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(selectedPath, YAML.stringify(candidate), { encoding: 'utf-8', flag: 'wx' });
    }
  }

  if (process.env.PORT !== undefined) requireInteger(Number(process.env.PORT), 'PORT', 1, 65535);
  currentConfigFilePath = selectedPath;
  isMemoryOnly = selectedMemoryOnly;
  currentYamlConfig = candidate;
  syncConfigObject();
  return currentYamlConfig;
}

// Writes a fresh configuration to targetPath without loading it. Refuses to
// replace an existing file.
export function generateConfigFile(targetPath: string): string {
  const selectedPath = path.resolve(targetPath);
  if (fs.existsSync(selectedPath)) {
    throw new ConfigValidationError(`Configuration already exists at ${selectedPath}`);
  }
  const candidate = normalizeYamlConfig(createInitialYamlConfig(), path.dirname(selectedPath));
  fs.mkdirSync(path.dirname(selectedPath), { recursive: true });
  fs.writeFileSync(selectedPath, YAML.stringify(candidate), { encoding: 'utf-8', flag: 'wx' });
  return selectedPath;
}

export function saveConfigFile(partial: Partial<AppYamlConfig>): AppYamlConfig {
  const configDir = path.dirname(currentConfigFilePath);
  const input = requireRecord(partial, 'Configuration update');
  for (const field of ['server', 'pipeline', 'classifiers', 'ui'] as const) {
    if (input[field] !== undefined) requireRecord(input[field], field);
  }
  const candidate = normalizeYamlConfig({
    ...currentYamlConfig,
    ...partial,
    server: { ...currentYamlConfig.server, ...partial.server },
    classifiers: { ...currentYamlConfig.classifiers, ...partial.classifiers },
    pipeline: { ...currentYamlConfig.pipeline, ...partial.pipeline },
    ui: { ...currentYamlConfig.ui, ...partial.ui },
  }, configDir);

  if (!isMemoryOnly) {
    const tempPath = path.join(
      configDir,
      `.${path.basename(currentConfigFilePath)}.${process.pid}.${randomUUID()}.tmp`
    );
    try {
      fs.mkdirSync(configDir, { recursive: true });
      const fd = fs.openSync(tempPath, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, YAML.stringify(candidate), 'utf-8');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tempPath, currentConfigFilePath);
    } catch (err) {
      try {
        fs.rmSync(tempPath, { force: true });
      } catch {
        // The original config is still intact even if temporary-file cleanup fails.
      }
      throw new Error(`Failed to save config file to ${currentConfigFilePath}`, { cause: err });
    }
  }

  currentYamlConfig = candidate;
  syncConfigObject();
  return currentYamlConfig;
}

export function getEffectiveConfig(): AppYamlConfig {
  return currentYamlConfig;
}

export function getDataDir(): string {
  return config.dataDir;
}

export function getThumbnailsDir(): string {
  return path.join(getDataDir(), 'thumbnails');
}

export function resetConfigForTesting(newConfig?: Partial<AppYamlConfig>): void {
  currentConfigFilePath = DEFAULT_CONFIG_FILE;
  isMemoryOnly = true;
  currentYamlConfig = {
    ...createDefaultYamlConfig(),
    ...(newConfig || {}),
  };
  syncConfigObject();
}

// Initial load. --generate-config only writes its own file, so it must not
// create or read the regular configuration.
if (parseCliGenerateConfigArg() === undefined) {
  loadConfigFile();
}
