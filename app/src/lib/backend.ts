import type { Backend } from './types';
import { mockBackend } from '@/mock/backend';
import { tauriBackend } from './tauriBackend';

/** Inside the desktop app the Rust backend is used; in a plain browser, the demo data. */
export const backend: Backend = '__TAURI_INTERNALS__' in window ? tauriBackend : mockBackend;
