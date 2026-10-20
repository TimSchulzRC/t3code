import { useAtomValue } from "@effect/atom-react";
import {
  type ClientSettingsPatch,
  isModifierPairShortcut,
  type SnapShotKeyChord,
} from "@t3tools/contracts";
import { useState } from "react";

import { updateClientSettings, useClientSettings } from "../../hooks/useSettings";
import { getDesktopSnapShotBridge } from "../../lib/desktopSnapShot";
import { sameSnapShotShortcut, snapShotKeybindingConflict } from "../../lib/snapShotShortcut";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { Switch } from "../ui/switch";
import { commandLabel } from "./KeybindingsSettings.logic";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSnapShotShortcutRecorder } from "./useSnapShotShortcutRecorder";

// Pauses SnapShots too, so recording either shortcut never triggers a capture.
const suppressGlobalShortcuts = (suppressed: boolean) => {
  const bridge = window.desktopBridge;
  if (!bridge?.setQuickChatShortcutSuppressed) return undefined;
  return Promise.all([
    bridge.setQuickChatShortcutSuppressed(suppressed),
    getDesktopSnapShotBridge()?.setSnapShotShortcutSuppressed(suppressed),
  ]).then(() => undefined);
};

export function QuickChatSettingsRow() {
  const bridge = window.desktopBridge;
  const enabled = useClientSettings((settings) => settings.quickChatEnabled);
  const shortcut = useClientSettings((settings) => settings.quickChatShortcut);
  const snapShotShortcut = useClientSettings((settings) =>
    settings.snapShotEnabled ? settings.snapShotShortcut : null,
  );
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const save = async (patch: ClientSettingsPatch) => {
    setPending(true);
    try {
      await updateClientSettings(patch);
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Could not save the quick chat shortcut.",
      );
    } finally {
      setPending(false);
    }
  };

  const checkAndSave = async (candidate: SnapShotKeyChord) => {
    const conflict = snapShotKeybindingConflict(candidate, keybindings);
    if (conflict) {
      setMessage(`T3 Code already uses this for "${commandLabel(conflict)}".`);
      return;
    }
    if (snapShotShortcut !== null && sameSnapShotShortcut(candidate, snapShotShortcut)) {
      setMessage("SnapShots already use this shortcut.");
      return;
    }
    const availability = await bridge?.checkQuickChatShortcut?.(candidate).catch(() => ({
      available: false,
      message: "Could not check this shortcut.",
    }));
    if (availability && !availability.available) {
      setMessage(availability.message);
      return;
    }
    await save({ quickChatShortcut: candidate });
  };

  const recorder = useSnapShotShortcutRecorder({
    shortcut,
    name: "quick chat",
    disabled: pending,
    allowModifierPairs: false,
    suppressShortcuts: suppressGlobalShortcuts,
    onStart: () => setMessage(null),
    onRecord: (recorded) => {
      if (!isModifierPairShortcut(recorded)) void checkAndSave(recorded);
    },
    onError: setMessage,
  });

  if (!bridge?.checkQuickChatShortcut) return null;

  return (
    <SettingsRow
      {...searchableSetting("quick-chat")}
      description="Press a shortcut anywhere to start a thread without a project from a small window."
      status={recorder.recording ? "Press your shortcut. Esc cancels." : message}
      control={
        <div className="flex items-center gap-2">
          {recorder.input}
          <Switch
            checked={enabled}
            disabled={pending}
            onCheckedChange={(checked) => void save({ quickChatEnabled: checked })}
            aria-label="Quick chat"
          />
        </div>
      }
    />
  );
}
