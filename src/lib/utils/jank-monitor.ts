/**
 * Attributes main-thread stalls. When the log level is "debug"
 * (`window.__spliceLog.setLevel("debug")`), an animation-frame loop measures the
 * gap between frames; a gap over the threshold is logged together with what the
 * app was doing in that window: terminal frames decoded (count and bytes), file
 * tree reloads, git status refreshes. Off (a 1 s poll) at other log levels, so a
 * release build pays nothing until someone turns it on to investigate.
 */
import { log, getLogLevel } from "./log";

export const workCounters = {
  terminalFrames: 0,
  terminalBytes: 0,
  treeReloads: 0,
  gitRefreshes: 0,
  fileReloads: 0,
};

const GAP_THRESHOLD_MS = 90;
const LOG_COOLDOWN_MS = 1000;

export function startJankMonitor(): () => void {
  let stopped = false;
  let last = performance.now();
  let lastLogged = 0;
  let snapshot = { ...workCounters };
  let rafId = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const tick = () => {
    if (stopped) return;
    if (getLogLevel() !== "debug") {
      // Idle: poll for the level to flip rather than waking every frame.
      timer = setTimeout(() => { last = performance.now(); snapshot = { ...workCounters }; tick(); }, 1000);
      return;
    }
    const now = performance.now();
    const gap = now - last;
    last = now;
    if (gap > GAP_THRESHOLD_MS && now - lastLogged > LOG_COOLDOWN_MS) {
      lastLogged = now;
      const d = {
        frames: workCounters.terminalFrames - snapshot.terminalFrames,
        kb: Math.round((workCounters.terminalBytes - snapshot.terminalBytes) / 1024),
        tree: workCounters.treeReloads - snapshot.treeReloads,
        git: workCounters.gitRefreshes - snapshot.gitRefreshes,
        files: workCounters.fileReloads - snapshot.fileReloads,
      };
      log.debug(
        `[jank] ${Math.round(gap)}ms frame gap | since last frame: terminal frames=${d.frames} (${d.kb} KB), tree reloads=${d.tree}, git refreshes=${d.git}, file reloads=${d.files}`,
      );
    }
    snapshot = { ...workCounters };
    rafId = requestAnimationFrame(tick);
  };
  tick();
  return () => {
    stopped = true;
    if (rafId) cancelAnimationFrame(rafId);
    if (timer) clearTimeout(timer);
  };
}
