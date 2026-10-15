import { spawn } from 'node:child_process';

/** Best-effort desktop notification; never throws and never blocks the caller. */
export function notifyUser(title: string, message: string, env: NodeJS.ProcessEnv = process.env): void {
  if (env.AI_E2E_NO_NOTIFY) return;
  const clean = (text: string): string => text.replace(/[\u0000-\u001f]+/g, ' ').slice(0, 240);
  let command: string;
  let args: string[];
  if (process.platform === 'darwin') {
    command = 'osascript';
    args = ['-e', `display notification ${JSON.stringify(clean(message))} with title ${JSON.stringify(clean(title))} sound name "Glass"`];
  } else if (process.platform === 'linux') {
    command = 'notify-send';
    args = [clean(title), clean(message)];
  } else {
    return;
  }
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.once('error', () => undefined);
    child.unref();
  } catch {
    // notifications are a convenience only
  }
}
