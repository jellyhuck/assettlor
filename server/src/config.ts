import path from 'path';
import os from 'os';
import fs from 'fs';
import YAML from 'yaml';

export interface ServerYamlConfig {
  port?: number;
  host?: string;
}

export interface PipelineYamlConfig {
  thumbnail_quality?: number;
  auto_stack_animations?: boolean;
  auto_stack_audio?: boolean;
  default_fps?: number;
}

export interface AppYamlConfig {
  server?: ServerYamlConfig;
  data_dir?: string;
  libraries?: string[];
  projects?: string[];
  classifiers?: Record<string, Record<string, unknown>>;
  pipeline?: PipelineYamlConfig;
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
      host: '0.0.0.0',
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
  };
}

export function parseCliConfigArg(): string | undefined {
  for (let i = 0; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === '--config' && i + 1 < process.argv.length) {
      return process.argv[i + 1];
    }
    if (arg.startsWith('--config=')) {
      return arg.split('=')[1];
    }
  }
  return undefined;
}

export function resolveConfigPath(rawPath: string, configDir: string): string {
  if (!rawPath) return rawPath;
  if (rawPath.startsWith('~/')) {
    return path.join(os.homedir(), rawPath.slice(2));
  }
  if (path.isAbsolute(rawPath)) {
    return rawPath;
  }
  const relCwd = path.resolve(process.cwd(), rawPath);
  if (fs.existsSync(relCwd)) {
    return relCwd;
  }
  const relConfig = path.resolve(configDir, rawPath);
  if (fs.existsSync(relConfig)) {
    return relConfig;
  }
  if (rawPath.startsWith('./sample/') || rawPath.startsWith('sample/')) {
    return relCwd;
  }
  return relConfig;
}

export function resolveDataDir(inputDir: string): string {
  const resolved = path.resolve(inputDir);
  const base = path.basename(resolved);
  if (base === '.assettlor' || base === 'data' || base === 'cache') {
    return resolved;
  }
  return path.join(resolved, '.assettlor');
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
  host: process.env.HOST || '0.0.0.0',
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
  config.port = Number(process.env.PORT) || currentYamlConfig.server?.port || 3001;
  config.host = process.env.HOST || currentYamlConfig.server?.host || '0.0.0.0';
  config.dataDir = resolveDataDir(currentYamlConfig.data_dir || DEFAULT_DATA_DIR);
  config.libraries = currentYamlConfig.libraries || [];
  config.projects = currentYamlConfig.projects || [];
  config.configFilePath = currentConfigFilePath;
}

export function loadConfigFile(customPath?: string): AppYamlConfig {
  const cliArg = parseCliConfigArg();
  const envArg = process.env.ASSETTLOR_CONFIG || process.env.CONFIG_PATH;
  const targetPath = customPath || cliArg || envArg || DEFAULT_CONFIG_FILE;

  currentConfigFilePath = path.resolve(targetPath);
  isMemoryOnly = Boolean(
    process.env.VITEST && !customPath && !cliArg && !envArg
  );

  const defaults = createDefaultYamlConfig();
  const configDir = path.dirname(currentConfigFilePath);

  if (fs.existsSync(currentConfigFilePath)) {
    try {
      const content = fs.readFileSync(currentConfigFilePath, 'utf-8');
      const parsed = (YAML.parse(content) || {}) as Partial<AppYamlConfig>;

      currentYamlConfig = {
        server: { ...defaults.server, ...(parsed.server || {}) },
        data_dir: parsed.data_dir
          ? resolveConfigPath(parsed.data_dir, configDir)
          : defaults.data_dir,
        libraries: Array.isArray(parsed.libraries)
          ? parsed.libraries.map((p) => resolveConfigPath(String(p).trim(), configDir)).filter(Boolean)
          : defaults.libraries,
        projects: Array.isArray(parsed.projects)
          ? parsed.projects.map((p) => resolveConfigPath(String(p).trim(), configDir)).filter(Boolean)
          : defaults.projects,
        classifiers: {
          ...defaults.classifiers,
          ...(parsed.classifiers || {}),
        },
        pipeline: { ...defaults.pipeline, ...(parsed.pipeline || {}) },
      };
    } catch (err) {
      console.warn(`Failed to parse config file at ${currentConfigFilePath}:`, err);
      currentYamlConfig = defaults;
    }
  } else {
    currentYamlConfig = defaults;
    if (!isMemoryOnly) {
      try {
        if (!fs.existsSync(configDir)) {
          fs.mkdirSync(configDir, { recursive: true });
        }
        fs.writeFileSync(currentConfigFilePath, YAML.stringify(currentYamlConfig), 'utf-8');
      } catch (err) {
        console.warn(`Could not create default config file at ${currentConfigFilePath}:`, err);
      }
    }
  }

  syncConfigObject();
  return currentYamlConfig;
}

export function saveConfigFile(partial: Partial<AppYamlConfig>): AppYamlConfig {
  const configDir = path.dirname(currentConfigFilePath);

  if (partial.server) {
    currentYamlConfig.server = { ...currentYamlConfig.server, ...partial.server };
  }
  if (partial.data_dir !== undefined) {
    currentYamlConfig.data_dir = partial.data_dir;
  }
  if (partial.libraries !== undefined) {
    currentYamlConfig.libraries = partial.libraries;
  }
  if (partial.projects !== undefined) {
    currentYamlConfig.projects = partial.projects;
  }
  if (partial.classifiers !== undefined) {
    currentYamlConfig.classifiers = {
      ...currentYamlConfig.classifiers,
      ...partial.classifiers,
    };
  }
  if (partial.pipeline !== undefined) {
    currentYamlConfig.pipeline = {
      ...currentYamlConfig.pipeline,
      ...partial.pipeline,
    };
  }

  if (!isMemoryOnly) {
    try {
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }
      fs.writeFileSync(currentConfigFilePath, YAML.stringify(currentYamlConfig), 'utf-8');
    } catch (err) {
      console.warn(`Failed to save config file to ${currentConfigFilePath}:`, err);
    }
  }

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

// Initial load
loadConfigFile();
