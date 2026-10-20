import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveQuickChatEnvironmentId, resolveQuickChatLaunchDefaults } from "./QuickChat.logic";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");

function provider(
  instanceId: string,
  models: ReadonlyArray<string>,
  supportedRuntimeModes?: ServerProvider["supportedRuntimeModes"],
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(instanceId),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: models.map((slug, index) => ({
      slug,
      name: slug,
      isCustom: false,
      ...(index === 0 ? { isDefault: true } : {}),
      capabilities: {},
    })),
    slashCommands: [],
    skills: [],
    ...(supportedRuntimeModes ? { supportedRuntimeModes } : {}),
  };
}

describe("resolveQuickChatEnvironmentId", () => {
  it("defaults to the machine you are on", () => {
    expect(resolveQuickChatEnvironmentId([remote, local], local, null)).toBe(local);
  });

  it("keeps a chosen machine while it still offers threads without a project", () => {
    expect(resolveQuickChatEnvironmentId([local, remote], local, remote)).toBe(remote);
    expect(resolveQuickChatEnvironmentId([local], local, remote)).toBe(local);
  });

  it("falls back to another machine when this one cannot host the thread", () => {
    expect(resolveQuickChatEnvironmentId([remote], local, null)).toBe(remote);
    expect(resolveQuickChatEnvironmentId([], local, null)).toBeNull();
  });
});

describe("resolveQuickChatLaunchDefaults", () => {
  const providers = [provider("codex", ["gpt-5.5"]), provider("claudeAgent", ["claude-opus-4-8"])];

  it("uses the default model for new threads", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      defaultModelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-4-8",
      },
    };

    expect(resolveQuickChatLaunchDefaults({ settings, providers, projectId: null })).toEqual({
      modelSelection: settings.defaultModelSelection,
      runtimeMode: DEFAULT_SERVER_SETTINGS.defaultRuntimeMode,
    });
  });

  it("applies the project's own default", () => {
    const projectId = ProjectId.make("scratch");
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: {
        [projectId]: {
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("claudeAgent"),
            model: "claude-opus-4-8",
          },
        },
      },
    };

    expect(
      resolveQuickChatLaunchDefaults({ settings, providers, projectId })?.modelSelection,
    ).toEqual({ instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-4-8" });
  });

  it("falls back to the first ready provider's default model", () => {
    expect(
      resolveQuickChatLaunchDefaults({
        settings: DEFAULT_SERVER_SETTINGS,
        providers,
        projectId: null,
      })?.modelSelection,
    ).toEqual({ instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.5" });
  });

  it("uses an access mode the provider supports", () => {
    const settings = { ...DEFAULT_SERVER_SETTINGS, defaultRuntimeMode: "full-access" as const };

    expect(
      resolveQuickChatLaunchDefaults({
        settings,
        providers: [provider("codex", ["gpt-5.5"], ["approval-required"])],
        projectId: null,
      })?.runtimeMode,
    ).toBe("approval-required");
  });

  it("returns nothing when no provider is ready", () => {
    expect(
      resolveQuickChatLaunchDefaults({
        settings: DEFAULT_SERVER_SETTINGS,
        providers: [],
        projectId: null,
      }),
    ).toBeNull();
  });
});
