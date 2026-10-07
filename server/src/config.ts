import path from 'path';
import os from 'os';
import fs from 'fs';

export interface ServerConfig {
  port: number;
  host: string;
  defaultLibraryPath: string;
  defaultActiveProjectPath: string;
  appDataDir: string;
  cacheDirName: string; // '.assettlor'
}

const defaultLibraryPath = path.join(process.cwd(), 'sample', 'assets');
const defaultActiveProjectPath = path.join(process.cwd(), 'sample', 'game-project');

const userHome = os.homedir();
const appDataDir = path.join(userHome, '.assettlor');

// Ensure base app data dir exists for global settings if needed
if (!fs.existsSync(appDataDir)) {
  try {
    fs.mkdirSync(appDataDir, { recursive: true });
  } catch (err) {
    // ignore
  }
}

export const config: ServerConfig = {
  port: Number(process.env.PORT) || 3001,
  host: process.env.HOST || '0.0.0.0',
  defaultLibraryPath,
  defaultActiveProjectPath,
  appDataDir,
  cacheDirName: '.assettlor',
};
