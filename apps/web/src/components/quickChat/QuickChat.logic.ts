import type {
  EnvironmentId,
  ModelSelection,
  ProjectId,
  RuntimeMode,
  ServerProvider,
  ServerSettings,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";

import { resolveDefaultProviderModelSelection } from "../../providerInstances";

/** The machine you are on, unless it cannot host threads without a project. */
export function resolveQuickChatEnvironmentId(
  offered: ReadonlyArray<EnvironmentId>,
  primary: EnvironmentId | null,
  selected: EnvironmentId | null,
): EnvironmentId | null {
  if (selected !== null && offered.includes(selected)) return selected;
  if (primary !== null && offered.includes(primary)) return primary;
  return offered[0] ?? null;
}

export interface QuickChatLaunchDefaults {
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
}

/**
 * Starts like a new thread in the project: its default model, else the first ready
 * provider's default, in the default access mode that provider supports.
 */
export function resolveQuickChatLaunchDefaults(input: {
  readonly settings: ServerSettings;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly projectId: ProjectId | null;
}): QuickChatLaunchDefaults | null {
  const { settings } = resolveProjectSettings(input.settings, input.projectId);
  const modelSelection = resolveDefaultProviderModelSelection(
    input.providers,
    settings.defaultModelSelection,
  );
  if (modelSelection === null) return null;
  const supportedRuntimeModes = input.providers.find(
    (provider) => provider.instanceId === modelSelection.instanceId,
  )?.supportedRuntimeModes;
  const runtimeMode =
    supportedRuntimeModes === undefined ||
    supportedRuntimeModes.length === 0 ||
    supportedRuntimeModes.includes(settings.defaultRuntimeMode)
      ? settings.defaultRuntimeMode
      : supportedRuntimeModes[0]!;
  return { modelSelection, runtimeMode };
}
