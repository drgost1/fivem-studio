// Docks an external top-level window (the running FiveM or RedM game client)
// over Studio's viewport, using raw Win32 window management — SetWindowLongPtr,
// SetWindowPos — via koffi bindings to user32.dll. This does not touch the
// target process's memory in any way; it's the same kind of operation any
// window-docking/tiling utility performs.
//
// Deliberately NOT SetParent/WS_CHILD embedding. That was measured against a
// live FiveM client: the reparent itself succeeds (GetLastError 0, GetParent
// confirms), the child receives input (clicks reach the game, which answers
// with audio) — but its flip-model swap chain stops presenting the moment the
// window becomes a child of another process's window, so the viewport stays
// black. Reparenting also provokes the client into destroying and recreating
// its render window. The same client renders perfectly as a top-level window.
//
// So the window is kept top-level (rendering keeps working), its caption and
// frame are stripped, Studio's window is set as its OWNER (GWL_HWNDPARENT) so
// it rides above Studio and out of alt-tab, and Studio positions it over the
// viewport rect in screen coordinates. Because the client can still destroy
// and recreate its window (e.g. on an in-game screen-type change), setRect
// re-acquires a recreated window by pid and re-applies the overlay.
//
// Windows-only. The GetWindowThreadProcessId/GetWindowText pattern below
// follows koffi's own documented Win32 example (see node_modules/koffi/doc/output.md).

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { BrowserWindow } from "electron";
import {
  getFreshCandidate,
  isCfxClientProcessName,
  matchesDiscoveredWindow,
  type DiscoveredWindowCandidate,
} from "./windowEmbedValidation";

// Electron's main process is CommonJS, while Koffi exposes separate ESM and
// CommonJS entry points. A type query keeps its public API without asking
// TypeScript's Node16 resolver to emit an invalid static ESM import here.
const koffi = require("koffi") as typeof import("koffi", { with: { "resolution-mode": "import" } }).default;

const user32 = koffi.load("user32.dll");
const kernel32 = koffi.load("kernel32.dll");
const gdi32 = koffi.load("gdi32.dll");

const HANDLE = koffi.pointer("HANDLE", koffi.opaque());
const HWND = koffi.alias("HWND", HANDLE);
const POINT = koffi.struct("POINT", { x: "long", y: "long" });
const RECT = koffi.struct("RECT", { left: "long", top: "long", right: "long", bottom: "long" });
void POINT;
void RECT;

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
const ClientToScreen = user32.func("bool __stdcall ClientToScreen(HWND hWnd, _Inout_ POINT *lpPoint)");
const GetClientRect = user32.func("bool __stdcall GetClientRect(HWND hWnd, _Out_ RECT *lpRect)");
const GetWindowRect = user32.func("bool __stdcall GetWindowRect(HWND hWnd, _Out_ RECT *lpRect)");
const SetWindowRgn = user32.func("int __stdcall SetWindowRgn(HWND hWnd, void *hRgn, bool bRedraw)");
const CreateRectRgn = gdi32.func("void * __stdcall CreateRectRgn(int x1, int y1, int x2, int y2)");
const SetWindowLongPtr = user32.func("int64_t __stdcall SetWindowLongPtrA(HWND hWnd, int nIndex, int64_t dwNewLong)");
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
/** The window's OWNER on 64-bit; this is ownership, not parenting. */
const GWL_HWNDPARENT = -8;
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
const SWP_SHOWWINDOW = 0x0040;
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

/** PID -> image name (e.g. "FiveM_GTAProcess.exe" or "RDR2.exe"), via `tasklist` — far simpler than the extra
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
    // false-positive on anything with "fivem" or "redm" in its title: Explorer windows browsing a
    // folder named similarly, Windows' own jump-list popups, etc. The game render surfaces run as
    // GTA5*/RDR2* processes rather than the FiveM.exe/RedM.exe bootstrapper, so include both families.
    if (!isCfxClientProcessName(processName)) continue;

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

  // The actual game render surface is far more likely to be the wanted window than the Cfx
  // bootstrapper window — surface GTA5*/RDR2* processes first.
  results.sort((a, b) => Number(/^(gta5|rdr2)/i.test(b.processName)) - Number(/^(gta5|rdr2)/i.test(a.processName)));

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

interface AttachedWindow {
  hwnd: bigint;
  pid: number;
  originalStyle: number;
  /** Previous owner (GWL_HWNDPARENT), restored on detach. Usually 0. */
  originalOwner: bigint;
  /** Studio's own top-level window; the overlay's owner and coordinate origin. */
  hostHwnd: bigint;
  wasVisible: boolean;
  /** Viewport rect in the HOST's client coordinates (physical pixels). */
  lastRect: { x: number; y: number; width: number; height: number } | null;
  /** When the client destroyed its window and no replacement has appeared yet. */
  missingSince: number | null;
  /** Last applied clip region, as "l,t,r,b" or "" for unclipped. */
  lastClip: string | null;
}

export type OverlayFitMode = "native" | "stretch";

/** How the docked window fills the viewport stage.
 *  - "native": the game window is never resized. It keeps whatever resolution
 *    its own settings chose, is centered on the stage, and anything past the
 *    stage is clipped. The viewport owns its shape; the game owns its
 *    resolution — resizing the game on every layout change caused constant
 *    swap-chain re-initialisation and in-game resolution churn.
 *  - "stretch": the window is resized to the stage, so the game adopts the
 *    stage as its render resolution. */
let fitMode: OverlayFitMode = "native";

export function setFitMode(mode: OverlayFitMode): void {
  if (mode !== "native" && mode !== "stretch") return;
  if (fitMode === mode) return;
  fitMode = mode;
  if (attached && attached.wasVisible && attached.lastRect) {
    attached.lastClip = null;
    applyOverlayRect(attached, attached.lastRect, false);
  }
}

let attached: AttachedWindow | null = null;
let anchorTimer: NodeJS.Timeout | null = null;

/** The client repositions and resizes its own window on internal events (it
 * favours 800x600), and destroys/recreates it on others. The renderer only
 * re-measures when Studio's DOM changes, so neither is corrected from there.
 * This tick re-asserts the overlay rect and re-acquires recreated windows. */
function startAnchorTimer(): void {
  if (anchorTimer) return;
  anchorTimer = setInterval(() => {
    if (!attached) return;
    if (!ensureLiveWindow() || !attached) return;
    // An in-game video-mode change re-applies the client's own window
    // configuration on the SAME hwnd — measured: owner and region were wiped
    // while the handle survived. Position alone kept ticking, which left the
    // window unclipped and unowned. Verify ownership and re-assert the whole
    // overlay when the client has reset it.
    const ownerNow = BigInt(GetWindowLongPtr(attached.hwnd, GWL_HWNDPARENT) as number | bigint as never);
    if (ownerNow !== attached.hostHwnd) {
      applyOverlay(attached.hwnd, attached.hostHwnd);
      attached.lastClip = null;
    }
    if (attached.wasVisible && attached.lastRect) applyOverlayRect(attached, attached.lastRect, false);
  }, 500);
  anchorTimer.unref?.();
}

function stopAnchorTimer(): void {
  if (!anchorTimer) return;
  clearInterval(anchorTimer);
  anchorTimer = null;
}

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
    if (!initial) return { ok: false, error: "That window is no longer an approved Cfx client candidate. Scan again and select it from the list." };

    detach();

    // detach() can take long enough for a target to exit, so make the final
    // identity check directly before changing its parent or style.
    const current = await resolveCurrentCandidate(candidateId);
    if (!current || current.hwnd !== initial.hwnd) {
      return { ok: false, error: "That window changed before it could be attached. Scan again and select it from the list." };
    }

    const hwnd = current.hwnd;
    const hostHwnd = win.getNativeWindowHandle().readBigUInt64LE(0);
    const { originalStyle, originalOwner } = applyOverlay(hwnd, hostHwnd);

    // Ownership is the one part that can silently not take; read it back and
    // say so rather than reporting an attach that did not happen.
    const ownerNow = BigInt(GetWindowLongPtr(hwnd, GWL_HWNDPARENT) as number | bigint as never);
    if (ownerNow !== hostHwnd) {
      SetWindowLongPtr(hwnd, GWL_STYLE, originalStyle);
      SetWindowLongPtr(hwnd, GWL_HWNDPARENT, originalOwner);
      return { ok: false, error: "Could not take ownership of that window. Scan again and retry." };
    }

    attached = {
      hwnd,
      pid: current.candidate.pid,
      originalStyle,
      originalOwner,
      hostHwnd,
      wasVisible: false,
      lastRect: null,
      missingSince: null,
      lastClip: null,
    };
    startAnchorTimer();
    return { ok: true };
  } catch (err) {
    attached = null;
    return { ok: false, error: (err as Error).message };
  }
}

/** Strips the frame and takes ownership; the window stays top-level so its
 * swap chain keeps presenting. Returns what detach() must restore. */
function applyOverlay(hwnd: bigint, hostHwnd: bigint): { originalStyle: number; originalOwner: bigint } {
  const originalStyle = GetWindowLongPtr(hwnd, GWL_STYLE) as number;
  const originalOwner = BigInt(GetWindowLongPtr(hwnd, GWL_HWNDPARENT) as number | bigint as never);
  const newStyle = originalStyle & ~WS_CAPTION & ~WS_THICKFRAME & ~WS_SYSMENU & ~WS_MINIMIZEBOX & ~WS_MAXIMIZEBOX;
  SetWindowLongPtr(hwnd, GWL_STYLE, newStyle);
  SetWindowLongPtr(hwnd, GWL_HWNDPARENT, hostHwnd);
  SetWindowPos(hwnd, null, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED | SWP_NOACTIVATE);
  return { originalStyle, originalOwner };
}

/** The host's client-area size (physical pixels). */
function hostClientSize(hostHwnd: bigint): { width: number; height: number } | null {
  const rect = { left: 0, top: 0, right: 0, bottom: 0 };
  try {
    if (!GetClientRect(hostHwnd, rect)) return null;
  } catch {
    return null;
  }
  return { width: rect.right - rect.left, height: rect.bottom - rect.top };
}

/** The host's client origin in screen coordinates (physical pixels). */
function hostClientOrigin(hostHwnd: bigint): { x: number; y: number } | null {
  const pt = { x: 0, y: 0 };
  try {
    if (!ClientToScreen(hostHwnd, pt)) return null;
  } catch {
    return null;
  }
  return { x: pt.x, y: pt.y };
}

/** Finds the client's recreated main window: same pid, visible, titled. The
 * process keeps invisible helper windows (input, IME) that must not match. */
function reacquireWindow(pid: number): bigint | null {
  for (let hwnd: bigint | null = GetTopWindow(null); hwnd; hwnd = GetWindow(hwnd, GW_HWNDNEXT)) {
    if (!IsWindowVisible(hwnd)) continue;
    const info = getWindowThreadAndPid(hwnd);
    if (info.pid !== pid) continue;
    if (getWindowTitle(hwnd).length === 0) continue;
    return hwnd;
  }
  return null;
}

/** The overlay window's current outer size (physical pixels). */
function overlayWindowSize(hwnd: bigint): { width: number; height: number } | null {
  const rect = { left: 0, top: 0, right: 0, bottom: 0 };
  try {
    if (!GetWindowRect(hwnd, rect)) return null;
  } catch {
    return null;
  }
  return { width: rect.right - rect.left, height: rect.bottom - rect.top };
}

/** Positions the overlay over the given stage rect (host-client coordinates).
 * Screen position is recomputed from the host window every time, so a moved
 * host stays covered. In "native" fit the window is positioned but NEVER
 * resized; in "stretch" fit it is sized to the stage. */
function applyOverlayRect(target: AttachedWindow, rect: { x: number; y: number; width: number; height: number }, raise: boolean): void {
  const origin = hostClientOrigin(target.hostHwnd);
  if (!origin) return;
  // Passing null as insertAfter without SWP_NOZORDER means HWND_TOP; an owned
  // window already rides above its owner, so steady-state keeps NOZORDER and
  // only the rising edge raises explicitly.
  const baseFlags = raise ? SWP_NOACTIVATE | SWP_SHOWWINDOW : SWP_NOZORDER | SWP_NOACTIVATE;

  let windowClient: { x: number; y: number; width: number; height: number };
  if (fitMode === "native") {
    const size = overlayWindowSize(target.hwnd);
    if (!size || size.width <= 0 || size.height <= 0) return;
    windowClient = {
      x: rect.x + Math.round((rect.width - size.width) / 2),
      y: rect.y + Math.round((rect.height - size.height) / 2),
      width: size.width,
      height: size.height,
    };
    SetWindowPos(target.hwnd, null, origin.x + windowClient.x, origin.y + windowClient.y, 0, 0, baseFlags | SWP_NOSIZE);
  } else {
    windowClient = rect;
    SetWindowPos(target.hwnd, null, origin.x + rect.x, origin.y + rect.y, rect.width, rect.height, baseFlags);
    // The client re-asserts its own configured windowed resolution and can
    // refuse an external resize (measured: applying video settings pins it).
    // Stretch used to leave the refused, larger window hanging off the
    // stage's top-left corner, so everything past the stage was amputated on
    // the right and bottom. Measure what the window actually is now; when
    // the game kept its own size, center that real size on the stage so the
    // clip crops evenly on all sides instead.
    const actual = overlayWindowSize(target.hwnd);
    if (actual && actual.width > 0 && actual.height > 0
      && (Math.abs(actual.width - rect.width) > 4 || Math.abs(actual.height - rect.height) > 4)) {
      windowClient = {
        x: rect.x + Math.round((rect.width - actual.width) / 2),
        y: rect.y + Math.round((rect.height - actual.height) / 2),
        width: actual.width,
        height: actual.height,
      };
      SetWindowPos(target.hwnd, null, origin.x + windowClient.x, origin.y + windowClient.y, 0, 0, baseFlags | SWP_NOSIZE);
    }
  }
  clipOverlay(target, windowClient, rect);
}

/** A top-level overlay obeys no parent bounds, so it must be clipped to the
 * part of it that lies inside BOTH the stage rect and the host's client area
 * — otherwise it spills past Studio's edges onto the desktop, and in native
 * fit a game larger than the stage would cover Studio's own UI. Clipping the
 * region keeps render resolution intact and simply does not draw the rest.
 * The system owns a region once set, so nothing is freed here. */
function clipOverlay(
  target: AttachedWindow,
  windowClient: { x: number; y: number; width: number; height: number },
  stage: { x: number; y: number; width: number; height: number },
): void {
  const client = hostClientSize(target.hostHwnd);
  if (!client) return;
  // Visible bounds in host-client coordinates: stage ∩ host client area.
  const boundLeft = Math.max(stage.x, 0);
  const boundTop = Math.max(stage.y, 0);
  const boundRight = Math.min(stage.x + stage.width, client.width);
  const boundBottom = Math.min(stage.y + stage.height, client.height);
  // Translated into overlay-local coordinates and intersected with the window.
  const left = Math.max(0, boundLeft - windowClient.x);
  const top = Math.max(0, boundTop - windowClient.y);
  const right = Math.min(windowClient.width, boundRight - windowClient.x);
  const bottom = Math.min(windowClient.height, boundBottom - windowClient.y);

  const fullyVisible = left === 0 && top === 0 && right === windowClient.width && bottom === windowClient.height;
  const clipKey = fullyVisible ? "" : `${left},${top},${Math.max(left, right)},${Math.max(top, bottom)}`;
  if (target.lastClip === clipKey) return;
  try {
    if (fullyVisible) {
      SetWindowRgn(target.hwnd, null, true);
    } else if (right <= left || bottom <= top) {
      // Entirely outside the visible bounds — an empty region hides it without
      // touching visibility state the show/hide logic owns.
      SetWindowRgn(target.hwnd, CreateRectRgn(0, 0, 0, 0), true);
    } else {
      SetWindowRgn(target.hwnd, CreateRectRgn(left, top, right, bottom), true);
    }
    target.lastClip = clipKey;
  } catch {
    // best-effort — an unclipped overlay is the pre-existing behaviour
  }
}

/** Keeps `attached` pointing at a live window, re-acquiring a recreated one.
 * Returns false while there is nothing usable this tick. */
function ensureLiveWindow(): boolean {
  if (!attached) return false;
  if (!attachedWindowStillOwned(attached)) {
    // The client destroys and recreates its render window — measured on an
    // in-game screen-type change and after reparent attempts. Losing the
    // handle is therefore normal operation, not the end of the attachment:
    // re-acquire by pid and re-apply the overlay. Give a recreation five
    // seconds to appear before concluding the client actually exited.
    const replacement = reacquireWindow(attached.pid);
    if (!replacement) {
      if (attached.missingSince === null) {
        attached.missingSince = Date.now();
      } else if (Date.now() - attached.missingSince > 5_000) {
        attached = null;
      }
      return false;
    }
    const restored = applyOverlay(replacement, attached.hostHwnd);
    attached.hwnd = replacement;
    attached.originalStyle = restored.originalStyle;
    attached.originalOwner = restored.originalOwner;
    attached.missingSince = null;
    attached.lastClip = null;
    // The renderer only re-sends the rect when its DOM measurement changes,
    // and a recreated game window does not change Studio's DOM — so the
    // overlay must be re-applied here, immediately, from the last known
    // rect. Losing it left the fresh window unpositioned and unclipped,
    // sprawling over Studio's other panels.
    if (attached.wasVisible && attached.lastRect) {
      applyOverlayRect(attached, attached.lastRect, true);
      ShowWindow(attached.hwnd, SW_SHOWNOACTIVATE);
    } else {
      attached.wasVisible = false;
      attached.lastRect = null;
    }
  }
  attached.missingSince = null;
  return true;
}

export function setRect(x: number, y: number, width: number, height: number, visible: boolean): void {
  if (!ensureLiveWindow() || !attached) return;
  if (!visible) {
    if (attached.wasVisible) ShowWindow(attached.hwnd, SW_HIDE);
    attached.wasVisible = false;
    return;
  }
  const nextRect = {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  };
  const risingEdge = !attached.wasVisible; // covers both the initial attach and switching back into the tab after hiding
  const rectChanged =
    !attached.lastRect ||
    attached.lastRect.x !== nextRect.x ||
    attached.lastRect.y !== nextRect.y ||
    attached.lastRect.width !== nextRect.width ||
    attached.lastRect.height !== nextRect.height;
  if (rectChanged || risingEdge) {
    applyOverlayRect(attached, nextRect, risingEdge);
    attached.lastRect = nextRect;
  }
  if (risingEdge) ShowWindow(attached.hwnd, SW_SHOWNOACTIVATE);
  attached.wasVisible = true;
  // No automatic focus: the overlay is an ordinary top-level window, so
  // clicking it focuses it natively. The old child-window focus hand-off is
  // actively harmful here — it fired on every Studio focus gain, so every
  // click on Studio's own UI (the aspect picker, tabs, buttons) had its focus
  // yanked straight back to the game, killing dropdowns mid-open.
}

/** The renderer only re-measures when the DOM rect changes, and moving the
 * whole Studio window does not change it — so the main process re-anchors the
 * overlay on host move/resize itself. */
export function refreshOverlayPosition(): void {
  if (!attached || !attached.wasVisible || !attached.lastRect) return;
  if (!attachedWindowStillOwned(attached)) return;
  applyOverlayRect(attached, attached.lastRect, false);
}

export function detach(): void {
  stopAnchorTimer();
  if (!attached) return;
  const previous = attached;
  attached = null;
  if (!attachedWindowStillOwned(previous)) return;
  const hwnd = previous.hwnd;
  try {
    SetWindowRgn(hwnd, null, true);
    SetWindowLongPtr(hwnd, GWL_STYLE, previous.originalStyle);
    SetWindowLongPtr(hwnd, GWL_HWNDPARENT, previous.originalOwner);
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
/** Whether a window is currently docked, for renderer state reconciliation. */
export function isAttached(): boolean {
  return attached !== null;
}

export function onHostFocusGained(): void {
  // Deliberately nothing. In overlay mode the game takes focus when clicked,
  // and handing focus to it whenever Studio regains focus made Studio's own
  // controls unusable while attached.
}
