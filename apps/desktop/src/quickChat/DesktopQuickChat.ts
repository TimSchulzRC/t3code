import {
  type ClientSettings,
  DEFAULT_CLIENT_SETTINGS,
  type DesktopQuickChatThread,
  type DesktopSnapShotShortcutAvailability,
  QUICK_CHAT_APP_PATH,
  type SnapShotKeyChord,
} from "@t3tools/contracts";
import { promptLinkDeepLink } from "@t3tools/shared/promptLinks";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Electron from "electron";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as DesktopWebLinks from "../app/DesktopWebLinks.ts";
import { probeGlobalShortcut } from "../electron/ElectronGlobalShortcut.ts";
import { getDesktopUrl } from "../electron/ElectronProtocol.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import { snapShotShortcutSystemConflict, toElectronAccelerator } from "../snapShot/snapShot.ts";
import * as DesktopRendererHistory from "../telemetry/DesktopRendererHistory.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";

const QUICK_CHAT_WIDTH = 680;
const QUICK_CHAT_MIN_HEIGHT = 80;
const QUICK_CHAT_MAX_HEIGHT = 560;
// Clears the Dock or taskbar edge the work area already excludes.
const QUICK_CHAT_BOTTOM_MARGIN = 24;
// Holding a global shortcut repeats it on Windows; one press should toggle once.
const SHORTCUT_COOLDOWN_NS = 250_000_000n;

const { logWarning } = makeComponentLogger("desktop-quick-chat");

/** Centers the window horizontally and keeps its bottom edge above the work area's. */
export function quickChatBounds(workArea: Electron.Rectangle, height: number): Electron.Rectangle {
  const clampedHeight = Math.round(
    Math.min(Math.max(height, QUICK_CHAT_MIN_HEIGHT), QUICK_CHAT_MAX_HEIGHT, workArea.height),
  );
  const width = Math.min(QUICK_CHAT_WIDTH, workArea.width);
  return {
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.max(
      workArea.y,
      workArea.y + workArea.height - clampedHeight - QUICK_CHAT_BOTTOM_MARGIN,
    ),
    width,
    height: clampedHeight,
  };
}

export class DesktopQuickChat extends Context.Service<
  DesktopQuickChat,
  {
    readonly initialize: Effect.Effect<void>;
    readonly configure: (settings: ClientSettings) => Effect.Effect<void>;
    readonly checkShortcut: (
      shortcut: SnapShotKeyChord,
    ) => Effect.Effect<DesktopSnapShotShortcutAvailability>;
    readonly setShortcutSuppressed: (suppressed: boolean) => Effect.Effect<void>;
    readonly ownsSender: (senderId: number) => Effect.Effect<boolean>;
    /** Height in CSS pixels; the renderer reports it before the window is first shown. */
    readonly resize: (height: number) => Effect.Effect<void>;
    readonly hide: Effect.Effect<void>;
    readonly openThread: (thread: DesktopQuickChatThread) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/quickChat/DesktopQuickChat") {}

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const webLinks = yield* DesktopWebLinks.DesktopWebLinks;
  const rendererHistory = yield* DesktopRendererHistory.DesktopRendererHistory;
  const context = yield* Effect.context<never>();
  const runPromise = Effect.runPromiseWith(context);

  let registeredAccelerator: string | undefined;
  let shortcutSuppressed = false;
  let lastShortcutAt: bigint | undefined;
  let window: Electron.BrowserWindow | undefined;
  // The window stays hidden until the renderer has measured its content, so it
  // never flashes the boot screen at the wrong size.
  let contentHeight: number | undefined;
  let showWhenSized = false;
  let workArea: Electron.Rectangle | undefined;
  const watchedMainWindows = new WeakSet<Electron.BrowserWindow>();

  const liveWindow = () => (window !== undefined && !window.isDestroyed() ? window : undefined);

  const destroyWindow = () => {
    liveWindow()?.destroy();
    window = undefined;
  };

  const applyBounds = (target: Electron.BrowserWindow) => {
    if (workArea === undefined || contentHeight === undefined) return;
    const zoom = target.webContents.getZoomFactor();
    target.setBounds(quickChatBounds(workArea, contentHeight * zoom));
  };

  const reveal = (target: Electron.BrowserWindow) => {
    applyBounds(target);
    target.show();
    target.focus();
    // Booting unthrottled lets the hidden renderer measure itself. Once shown,
    // throttling keeps it cheap while hidden and lets it see hide and show.
    target.webContents.setBackgroundThrottling(true);
  };

  const createWindow = Effect.gen(function* () {
    const created = yield* electronWindow.create({
      width: QUICK_CHAT_WIDTH,
      height: QUICK_CHAT_MIN_HEIGHT,
      show: false,
      frame: false,
      // The renderer draws the rounded card and its shadow, so the window looks
      // the same on macOS and Windows.
      transparent: true,
      hasShadow: false,
      backgroundColor: "#00000000",
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      // A panel takes keyboard focus without activating the app, so the main
      // window stays where it is.
      ...(environment.platform === "darwin" ? { type: "panel" } : {}),
      title: environment.displayName,
      webPreferences: {
        preload: environment.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    yield* electronWindow.markAuxiliary(created);
    yield* rendererHistory.register(created.webContents, { surface: "quick-chat" });
    created.setAlwaysOnTop(true, environment.platform === "darwin" ? "floating" : "normal");
    if (environment.platform === "darwin") {
      created.setVisibleOnAllWorkspaces(true, {
        visibleOnFullScreen: true,
        skipTransformProcessType: true,
      });
    }
    created.webContents.on("render-process-gone", () => {
      if (window === created) destroyWindow();
    });
    created.on("closed", () => {
      if (window !== created) return;
      window = undefined;
      contentHeight = undefined;
      showWhenSized = false;
    });
    void created
      .loadURL(`${getDesktopUrl(environment.isDevelopment)}#${QUICK_CHAT_APP_PATH}`)
      .catch(() => {
        if (window === created) destroyWindow();
      });
    window = created;
    return created;
  });

  // Elsewhere the app quits once its last window closes, which a hidden quick
  // chat window would prevent.
  const followMainWindow = Effect.gen(function* () {
    if (environment.platform === "darwin") return;
    const main = yield* electronWindow.main;
    if (Option.isNone(main) || watchedMainWindows.has(main.value)) return;
    watchedMainWindows.add(main.value);
    main.value.once("closed", destroyWindow);
  });

  const show = Effect.gen(function* () {
    const target = liveWindow() ?? (yield* createWindow);
    yield* followMainWindow;
    workArea = Electron.screen.getDisplayNearestPoint(
      Electron.screen.getCursorScreenPoint(),
    ).workArea;
    if (contentHeight === undefined) {
      showWhenSized = true;
      return;
    }
    reveal(target);
  });

  const hide = Effect.sync(() => {
    showWhenSized = false;
    liveWindow()?.hide();
  });

  const toggle = Effect.gen(function* () {
    const current = liveWindow();
    if (current?.isVisible() && current.isFocused()) {
      yield* hide;
      return;
    }
    yield* show;
  }).pipe(
    Effect.catch((error) => logWarning("could not show quick chat", { message: error.message })),
    Effect.withSpan("desktop.quickChat.toggle"),
  );

  const onShortcut = () => {
    void runPromise(
      Effect.gen(function* () {
        if (shortcutSuppressed) return;
        const now = yield* Clock.currentTimeNanos;
        if (lastShortcutAt !== undefined && now - lastShortcutAt < SHORTCUT_COOLDOWN_NS) return;
        lastShortcutAt = now;
        yield* toggle;
      }),
    );
  };

  const releaseShortcut = () => {
    if (registeredAccelerator !== undefined) {
      Electron.globalShortcut.unregister(registeredAccelerator);
      registeredAccelerator = undefined;
    }
  };

  const configure = Effect.fn("desktop.quickChat.configure")(function* (settings: ClientSettings) {
    const accelerator = settings.quickChatEnabled
      ? toElectronAccelerator(settings.quickChatShortcut)
      : undefined;
    if (accelerator === registeredAccelerator) return;
    releaseShortcut();
    if (accelerator === undefined) {
      destroyWindow();
      return;
    }
    const registered = yield* Effect.try(() =>
      Electron.globalShortcut.register(accelerator, onShortcut),
    ).pipe(Effect.orElseSucceed(() => false));
    if (registered) {
      registeredAccelerator = accelerator;
    } else {
      yield* logWarning("could not register quick chat shortcut", { accelerator });
    }
  });

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      releaseShortcut();
      destroyWindow();
    }),
  );

  return DesktopQuickChat.of({
    initialize: clientSettings.get.pipe(
      Effect.flatMap((stored) =>
        configure(Option.getOrElse(stored, () => DEFAULT_CLIENT_SETTINGS)),
      ),
      Effect.ignore,
    ),
    configure,
    checkShortcut: (shortcut) =>
      Effect.sync(() => {
        const systemConflict = snapShotShortcutSystemConflict(shortcut);
        if (systemConflict) return { available: false, message: systemConflict };
        const accelerator = toElectronAccelerator(shortcut);
        return accelerator === registeredAccelerator
          ? { available: true, message: null }
          : probeGlobalShortcut(accelerator);
      }),
    setShortcutSuppressed: (suppressed) =>
      Effect.sync(() => {
        shortcutSuppressed = suppressed;
      }),
    ownsSender: (senderId) => Effect.sync(() => liveWindow()?.webContents.id === senderId),
    resize: (height) =>
      Effect.sync(() => {
        const target = liveWindow();
        if (target === undefined) return;
        contentHeight = height;
        if (showWhenSized) {
          showWhenSized = false;
          reveal(target);
          return;
        }
        if (target.isVisible()) applyBounds(target);
      }),
    hide,
    openThread: Effect.fn("desktop.quickChat.openThread")(function* (thread) {
      yield* hide;
      yield* desktopWindow.revealOrCreateMain.pipe(Effect.ignore);
      yield* webLinks.receive(promptLinkDeepLink(`/${thread.environmentId}/${thread.threadId}`));
    }),
  });
});

export const layer = Layer.effect(DesktopQuickChat, make);
