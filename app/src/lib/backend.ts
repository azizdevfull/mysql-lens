import type { Backend } from './types';
import { mockBackend } from '@/mock/backend';
import { tauriBackend } from './tauriBackend';
import { httpBackend } from './httpBackend';

/** The desktop app's web access marks the page it serves. */
const servedByApp = !!document.querySelector('meta[name="lens-web"]');

/** Inside the desktop app the Rust backend is used; from its web access, HTTP; elsewhere, the demo data. */
export const backend: Backend = '__TAURI_INTERNALS__' in window ? tauriBackend : servedByApp ? httpBackend : mockBackend;
