// Embeds an external top-level window (the running FiveM game client) into
// Studio's own window, using raw Win32 window management — SetParent,
// SetWindowLongPtr, SetWindowPos — via koffi bindings to user32.dll. This
// does not touch the target process's memory in any way; it's the same kind
// of operation any window-docking/tiling utility performs.
//
// Windows-only. FiveM must be running windowed/borderless — an exclusive
// fullscreen window generally can't be reparented as a child window.
//
// The GetWindowThreadProcessId/GetWindowText pattern below follows koffi's
// own documented Win32 example (see node_modules/koffi/doc/output.md).

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import koffi from "koffi";
import type { BrowserWindow } from "electron";
import {
  getFreshCandidate,
  matchesDiscoveredWindow,
  type DiscoveredWindowCandidate,
} from "./windowEmbedValidation";

const user32 = koffi.load("user32.dll");
const kernel32 = koffi.load("kernel32.dll");

const HANDLE = koffi.pointer("HANDLE", koffi.opaque());
const HWND = koffi.alias("HWND", HANDLE);

const GetTopWindow = user32.func("HWND __stdcall GetTopWindow(HWND hWnd)");
const GetWindow = user32.func("HWND __stdcall GetWindow(HWND hWnd, uint32_t uCmd)");
const IsWindow = user32.func("bool __stdcall IsWindow(HWND hWnd)");
const IsWindowVisible = user32.func("bool __stdcall IsWindowVisible(HWND hWnd)");
const GetWindowThreadProcessId = user32.func(
  "uint32_t __stdcall GetWindowThreadProcessId(HWND hWnd, _Out_ uint32_t *lpdwProcessId)",
);
const GetWindowTextLength = user32.func("int __stdcall GetWindowTextLengthA(HWND hWnd)");
const GetWindowText = user32.func("int __stdcall GetWindowTextA(HWND hWnd, _Out_ uint8_t *lpString, int nMaxCount)");
const GetWindowLongPtr = user32.func("int64_t __stdcall GetWindowLongPtrA(HWND hWnd, int nIndex)");
const SetWindowLongPtr = user32.func("int64_t __stdcall SetWindowLongPtrA(HWND hWnd, int nIndex, int64_t dwNewLong)");
const SetParent = user32.func("HWND __stdcall SetParent(HWND hWndChild, HWND hWndNewParent)");
const SetWindowPos = user32.func(
  "bool __stdcall SetWindowPos(HWND hWnd, HWND hWndInsertAfter, int X, int Y, int cx, int cy, uint32_t uFlags)",
);
const ShowWindow = user32.func("bool __stdcall ShowWindow(HWND hWnd, int nCmdShow)");
const SetForegroundWindow = user32.func("bool __stdcall SetForegroundWindow(HWND hWnd)");
const SetFocus = user32.func("HWND __stdcall SetFocus(HWND hWnd)");
const AttachThreadInput = user32.func("bool __stdcall AttachThreadInput(uint32_t idAttach, uint32_t idAttachTo, bool fAttach)");
const GetCurrentThreadId = kernel32.func("uint32_t __stdcall GetCurrentThreadId()");

// DPI-awareness-context APIs (Windows 10 1607+) — guarded because older Windows lacks them.
let GetWindowDpiAwarenessContext: ((hwnd: bigint) => bigint) | null = null;
let SetThreadDpiAwarenessContext: ((ctx: bigint) => bigint) | null = null;
try {
  GetWindowDpiAwarenessContext = user32.func("void * __stdcall GetWindowDpiAwarenessContext(HWND hWnd)");
  SetThreadDpiAwarenessContext = user32.func("void * __stdcall SetThreadDpiAwarenessContext(void *dpiContext)");
} catch {
  // Pre-1607 Windows — mixed DPI-awareness positioning quirks below just won't be compensated for.
}

const GW_HWNDNEXT = 2;
const GWL_STYLE = -16;
const WS_CHILD = 0x40000000;
const WS_POPUP = 0x80000000;
const WS_CAPTION = 0x00c00000;
const WS_THICKFRAME = 0x00040000;
const WS_SYSMENU = 0x00080000;
const WS_MINIMIZEBOX = 0x00020000;
const WS_MAXIMIZEBOX = 0x00010000;
const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOZORDER = 0x0004;
const SWP_NOACTIVATE = 0x0010;
const SWP_FRAMECHANGED = 0x0020;
const SW_HIDE = 0;
const SW_SHOWNOACTIVATE = 4;

export interface WindowCandidate {
  id: string;
  title: string;
  processName: string;
  pid: number;
}

const CANDIDATE_TTL_MS = 60_000;
const discoveredCandidates = new Map<string, DiscoveredWindowCandidate>();

function getWindowTitle(hwnd: bigint): string {
  const length = GetWindowTextLength(hwnd);
  if (length <= 0) return "";
  const buf = Buffer.alloc(length + 1);
  const written = GetWindowText(hwnd, buf, buf.length);
  return written > 0 ? (koffi.decode(buf, "char", written) as string) : "";
}

function getWindowThreadAndPid(hwnd: bigint): { tid: number; pid: number } {
  const out = [0];
  const tid = GetWindowThreadProcessId(hwnd, out) as number; // return value is the thread id; the out-param is the pid
  return { tid, pid: out[0] };
}

/** PID -> image name (e.g. "FiveM_GTAProcess.exe"), via `tasklist` — far simpler than the extra
 * Win32 calls (OpenProcess + QueryFullProcessImageName) it'd otherwise take to get this ourselves. */
function processNames(): Promise<Map<number, string>> {
  return new Promise((resolve) => {
    execFile("tasklist", ["/fo", "csv", "/nh"], (err, stdout) => {
      const map = new Map<number, string>();
      if (err || !stdout) {
        resolve(map);
        return;
      }
      for (const line of stdout.split(/\r?\n/)) {
        const cols = line.match(/"([^"]*)"/g)?.map((c) => c.slice(1, -1));
        if (!cols || cols.length < 2) continue;
        const pid = Number(cols[1]);
        if (Number.isFinite(pid)) map.set(pid, cols[0]);
      }
      resolve(map);
    });
  });
}

export async function listCandidates(): Promise<WindowCandidate[]> {
  const names = await processNames();
  const results: WindowCandidate[] = [];
  discoveredCandidates.clear();

  for (let hwnd: bigint | null = GetTopWindow(null); hwnd; hwnd = GetWindow(hwnd, GW_HWNDNEXT)) {
    if (!IsWindowVisible(hwnd)) continue;

    const { pid } = getWindowThreadAndPid(hwnd);
    if (pid === process.pid) continue; // never offer Studio's own window, however it ends up (re)named

    const processName = names.get(pid) ?? "";
    // Match on process name only — matching on window title too (as a first cut) turned out to
    // false-positive on anything with "fivem" anywhere in its title: Explorer windows browsing a
    // folder named similarly, Windows' own jump-list popups, etc. FiveM's newer builds render the
    // actual game through a GTA5 Enhanced Edition process, not FiveM.exe itself, hence "gta5" here.
    if (!/^(fivem|gta5|redm)/i.test(processName)) continue;

    const title = getWindowTitle(hwnd);
    const id = randomUUID();
    const record: DiscoveredWindowCandidate = {
      id,
      hwndId: hwnd.toString(),
      pid,
      processName,
      expiresAt: Date.now() + CANDIDATE_TTL_MS,
    };
    discoveredCandidates.set(id, record);
    results.push({ id, title, processName, pid });
  }

  // The actual game render surface (gta5*.exe) is far more likely to be the wanted window than
  // FiveM.exe's own bootstrapper window — surface it first.
  results.sort((a, b) => Number(/^gta5/i.test(b.processName)) - Number(/^gta5/i.test(a.processName)));

  return results;
}

/**
 * GTA5 (and by extension FiveM's Enhanced-edition render process) pauses/blanks its own rendering
 * when it isn't the focused window — a WS_CHILD window we've just reparented doesn't have real OS
 * keyboard focus, so it stays in that paused state (a black box) until something focuses it, which
 * is exactly what alt-tabbing onto it manually does. SetForegroundWindow/SetFocus only work across
 * threads if the calling and target threads share input state, hence AttachThreadInput around them
 * — the standard, well-documented pattern for focusing a window owned by another process/thread.
 */
function focusEmbeddedWindow(hwnd: bigint): void {
  try {
    const { tid } = getWindowThreadAndPid(hwnd);
    const currentTid = GetCurrentThreadId() as number;
    const needsAttach = tid !== 0 && tid !== currentTid;
    if (needsAttach) AttachThreadInput(currentTid, tid, true);
    SetForegroundWindow(hwnd);
    SetFocus(hwnd);
    if (needsAttach) AttachThreadInput(currentTid, tid, false);
  } catch {
    // best-effort — worst case the user has to click/alt-tab into it once, same as before this fix
  }
}

/**
 * If Studio and the target window declare different DPI awareness (common: a CEF-based UI window
 * that hasn't opted into per-monitor DPI awareness, vs. our own per-monitor-aware Electron window),
 * Windows silently rescales the coordinates a differently-aware process passes to SetWindowPos —
 * producing exactly the kind of badly-distorted (e.g. squashed to a sliver) sizing seen on FiveM's
 * own menu/server-browser window. Temporarily matching our thread's DPI-awareness context to the
 * target's for the duration of the call is the documented fix for this cross-process scenario.
 */
function withTargetDpiAwareness<T>(hwnd: bigint, fn: () => T): T {
  if (!GetWindowDpiAwarenessContext || !SetThreadDpiAwarenessContext) return fn();
  let previous: bigint | null = null;
  try {
    const targetContext = GetWindowDpiAwarenessContext(hwnd);
    if (targetContext) previous = SetThreadDpiAwarenessContext(targetContext);
  } catch {
    return fn();
  }
  try {
    return fn();
  } finally {
    if (previous !== null) {
      try {
        SetThreadDpiAwarenessContext(previous);
      } catch {
        // best-effort restore
      }
    }
  }
}

let attached: { hwnd: bigint; pid: number; originalStyle: number; wasVisible: boolean } | null = null;

function attachedWindowStillOwned(value: NonNullable<typeof attached>): boolean {
  if (!IsWindow(value.hwnd)) return false;
  const { tid, pid } = getWindowThreadAndPid(value.hwnd);
  return tid !== 0 && pid === value.pid;
}

async function resolveCurrentCandidate(candidateId: string): Promise<{ hwnd: bigint; candidate: DiscoveredWindowCandidate } | null> {
  const candidate = getFreshCandidate(discoveredCandidates, candidateId);
  if (!candidate) return null;

  let hwnd: bigint;
  try {
    hwnd = BigInt(candidate.hwndId);
  } catch {
    return null;
  }
  if (!IsWindow(hwnd)) return null;

  const { tid, pid } = getWindowThreadAndPid(hwnd);
  if (tid === 0 || pid === 0) return null;
  const names = await processNames();
  if (candidate.expiresAt < Date.now()) return null;
  const processName = names.get(pid);
  if (!processName || !matchesDiscoveredWindow(candidate, { pid, processName })) return null;
  return { hwnd, candidate };
}

export async function attach(candidateId: string, win: BrowserWindow): Promise<{ ok: boolean; error?: string }> {
  try {
    // Resolve after scanning and immediately before mutation. This blocks both
    // renderer-invented HWNDs and a stale/reused HWND from another process.
    const initial = await resolveCurrentCandidate(candidateId);
    if (!initial) return { ok: false, error: "That window is no longer an approved FiveM candidate. Scan again and select it from the list." };

    detach();

    // detach() can take long enough for a target to exit, so make the final
    // identity check directly before changing its parent or style.
    const current = await resolveCurrentCandidate(candidateId);
    if (!current || current.hwnd !== initial.hwnd) {
      return { ok: false, error: "That window changed before it could be attached. Scan again and select it from the list." };
    }

    const hwnd = current.hwnd;
    const originalStyle = GetWindowLongPtr(hwnd, GWL_STYLE) as number;
    const newStyle =
      (originalStyle & ~WS_POPUP & ~WS_CAPTION & ~WS_THICKFRAME & ~WS_SYSMENU & ~WS_MINIMIZEBOX & ~WS_MAXIMIZEBOX) | WS_CHILD;
    SetWindowLongPtr(hwnd, GWL_STYLE, newStyle);

    const parentHandle = win.getNativeWindowHandle().readBigUInt64LE(0);
    SetParent(hwnd, parentHandle);
    withTargetDpiAwareness(hwnd, () => SetWindowPos(hwnd, null, 0, 0, 0, 0, SWP_NOZORDER | SWP_FRAMECHANGED | SWP_NOACTIVATE));

    attached = { hwnd, pid: current.candidate.pid, originalStyle, wasVisible: false };
    return { ok: true };
  } catch (err) {
    attached = null;
    return { ok: false, error: (err as Error).message };
  }
}

export function setRect(x: number, y: number, width: number, height: number, visible: boolean): void {
  if (!attached) return;
  if (!attachedWindowStillOwned(attached)) {
    attached = null;
    return;
  }
  if (!visible) {
    if (attached.wasVisible) ShowWindow(attached.hwnd, SW_HIDE);
    attached.wasVisible = false;
    return;
  }
  const risingEdge = !attached.wasVisible; // covers both the initial attach and switching back into the tab after hiding
  withTargetDpiAwareness(attached.hwnd, () =>
    SetWindowPos(attached!.hwnd, null, Math.round(x), Math.round(y), Math.round(width), Math.round(height), SWP_NOZORDER | SWP_NOACTIVATE),
  );
  ShowWindow(attached.hwnd, SW_SHOWNOACTIVATE);
  attached.wasVisible = true;
  if (risingEdge) focusEmbeddedWindow(attached.hwnd);
}

export function detach(): void {
  if (!attached) return;
  const previous = attached;
  attached = null;
  if (!attachedWindowStillOwned(previous)) return;
  const hwnd = previous.hwnd;
  try {
    SetWindowLongPtr(hwnd, GWL_STYLE, previous.originalStyle);
    SetParent(hwnd, null);
    SetWindowPos(hwnd, null, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED | SWP_NOACTIVATE);
    // Handing it back as a normal top-level window doesn't by itself give it real focus again —
    // without this it can come back stuck in the same paused/black-box state embedding leaves it in.
    focusEmbeddedWindow(hwnd);
  } catch {
    // best-effort — if the target process is already gone there's nothing left to restore
  }
}

/** Re-focus the currently-embedded window when Studio itself regains OS focus (e.g. alt-tabbing
 * back from another app) — the internal tab-switch rising-edge in setRect() doesn't cover this,
 * since Studio's own window can regain focus without any of our tabs changing. */
export function onHostFocusGained(): void {
  if (attached && attached.wasVisible && attachedWindowStillOwned(attached)) focusEmbeddedWindow(attached.hwnd);
}
