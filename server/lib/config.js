import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DECRYPTED_CANDIDATES = [process.env.RADMIR_DECRYPTED, path.join(APP_ROOT, 'decrypted'), path.resolve(APP_ROOT, '..', 'decrypted')].filter(Boolean);
export const DECRYPTED = DECRYPTED_CANDIDATES.find((p) => fs.existsSync(p)) || path.resolve(APP_ROOT, '..', 'decrypted');
export const GAME_IMPORT = path.join(APP_ROOT, 'resources', 'game-import');
export const CACHE = path.join(APP_ROOT, 'cache');
export const PROFILES = path.join(APP_ROOT, 'profiles');
export const PROJECTS = path.join(APP_ROOT, 'projects');
export const IMPORTS = path.join(APP_ROOT, 'user-imports');
export const APP_STATIC = path.join(APP_ROOT, 'app');
export const DOCS = path.join(APP_ROOT, 'docs');
export const DEFAULT_GAME_DIR = 'C:\\Program Files (x86)\\RADMIR Games\\RADMIR CRMP';
export const PORT = Number(process.env.RADMIR_VIEWER_PORT || 8777);

export const ROOTS = { decrypted: DECRYPTED, 'game-import': GAME_IMPORT };
