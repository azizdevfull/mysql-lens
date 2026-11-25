import { toast } from 'sonner';
import { backend } from './backend';

const SKIP_KEY = 'updater.skipVersion';

function skipped(): string | null {
  try {
    return localStorage.getItem(SKIP_KEY);
  } catch {
    return null;
  }
}

/**
 * Checks GitHub Releases for a newer signed build. Automatic checks are silent
 * unless an update exists; `manual` also reports "up to date" and errors.
 */
export async function checkForUpdates(manual = false): Promise<void> {
  if (!backend.native) {
    if (manual) toast.info('Updates are available in the desktop app.');
    return;
  }
  const [{ check }, { getVersion }] = await Promise.all([import('@tauri-apps/plugin-updater'), import('@tauri-apps/api/app')]);
  const current = await getVersion();
  let update;
  try {
    update = await check({ timeout: 15000 });
  } catch (e) {
    if (manual) toast.error('Could not check for updates', { description: String(e) });
    else console.warn('update check failed', e);
    return;
  }
  if (!update) {
    if (manual) toast.success(`MySQL Lens ${current} is the latest version`);
    return;
  }
  if (!manual && skipped() === update.version) return;
  const notes = (update.body ?? '').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 3).join(' · ');
  toast(`MySQL Lens ${update.version} is available`, {
    description: notes || `You have ${current}.`,
    duration: Infinity,
    action: { label: 'Update now', onClick: () => void install(update) },
    cancel: {
      label: 'Later',
      onClick: () => {
        try {
          localStorage.setItem(SKIP_KEY, update.version);
        } catch {
          // ignore
        }
      },
    },
  });
}

async function install(update: import('@tauri-apps/plugin-updater').Update): Promise<void> {
  const id = toast.loading(`Downloading MySQL Lens ${update.version}…`);
  let total = 0;
  let got = 0;
  try {
    await update.downloadAndInstall((ev) => {
      if (ev.event === 'Started') total = ev.data.contentLength ?? 0;
      else if (ev.event === 'Progress') {
        got += ev.data.chunkLength;
        if (total) toast.loading(`Downloading MySQL Lens ${update.version}… ${Math.round((got / total) * 100)}%`, { id });
      } else if (ev.event === 'Finished') toast.loading('Installing… the app will restart', { id });
    });
    // On Windows the installer closes the app itself; elsewhere restart explicitly.
    const { relaunch } = await import('@tauri-apps/plugin-process');
    await relaunch();
  } catch (e) {
    toast.error('Update failed', { id, description: String(e) });
  }
}
