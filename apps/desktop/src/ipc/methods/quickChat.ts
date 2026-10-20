import {
  DesktopQuickChatThread,
  DesktopSnapShotShortcutAvailability,
  SnapShotKeyChord,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopQuickChat from "../../quickChat/DesktopQuickChat.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

class QuickChatIpcUnauthorizedSenderError extends Schema.TaggedError<QuickChatIpcUnauthorizedSenderError>()(
  "QuickChatIpcUnauthorizedSenderError",
  {},
) {
  override get message(): string {
    return "Quick chat request was rejected.";
  }
}

// Settings edit the shortcut from the main window.
const ensureMainSender = Effect.fn("desktop.ipc.quickChat.ensureMainSender")(function* (
  event: DesktopIpc.DesktopIpcInvokeEvent | undefined,
) {
  const main = yield* (yield* ElectronWindow.ElectronWindow).main;
  if (event === undefined || Option.isNone(main) || main.value.webContents.id !== event.sender.id) {
    return yield* new QuickChatIpcUnauthorizedSenderError();
  }
});

// Only the quick chat window may move, hide, or hand off from itself.
const ensureQuickChatSender = Effect.fn("desktop.ipc.quickChat.ensureQuickChatSender")(function* (
  event: DesktopIpc.DesktopIpcInvokeEvent | undefined,
) {
  const quickChat = yield* DesktopQuickChat.DesktopQuickChat;
  if (event === undefined || !(yield* quickChat.ownsSender(event.sender.id))) {
    return yield* new QuickChatIpcUnauthorizedSenderError();
  }
  return quickChat;
});

export const checkQuickChatShortcut = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.CHECK_QUICK_CHAT_SHORTCUT_CHANNEL,
  payload: SnapShotKeyChord,
  result: DesktopSnapShotShortcutAvailability,
  handler: Effect.fn("desktop.ipc.quickChat.checkShortcut")(function* (shortcut, event) {
    yield* ensureMainSender(event);
    return yield* (yield* DesktopQuickChat.DesktopQuickChat).checkShortcut(shortcut);
  }),
});

export const setQuickChatShortcutSuppressed = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SET_QUICK_CHAT_SHORTCUT_SUPPRESSED_CHANNEL,
  payload: Schema.Boolean,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.quickChat.setShortcutSuppressed")(function* (suppressed, event) {
    yield* ensureMainSender(event);
    yield* (yield* DesktopQuickChat.DesktopQuickChat).setShortcutSuppressed(suppressed);
  }),
});

export const resizeQuickChat = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.RESIZE_QUICK_CHAT_CHANNEL,
  payload: Schema.Finite.check(Schema.isGreaterThan(0)),
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.quickChat.resize")(function* (height, event) {
    yield* (yield* ensureQuickChatSender(event)).resize(height);
  }),
});

export const hideQuickChat = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.HIDE_QUICK_CHAT_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.quickChat.hide")(function* (_, event) {
    yield* (yield* ensureQuickChatSender(event)).hide;
  }),
});

export const openQuickChatThread = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.OPEN_QUICK_CHAT_THREAD_CHANNEL,
  payload: DesktopQuickChatThread,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.quickChat.openThread")(function* (thread, event) {
    yield* (yield* ensureQuickChatSender(event)).openThread(thread);
  }),
});
