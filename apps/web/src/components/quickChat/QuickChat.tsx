import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { deriveThreadTitleSeed } from "@t3tools/client-runtime/operations";
import { availableScratchWorkspaceRoot } from "@t3tools/client-runtime/operations/projects";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { ArrowUpIcon, CheckIcon, ChevronDownIcon, XIcon } from "lucide-react";
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";

import { useRenderedAppearance } from "../../hooks/useTheme";
import { observeResize } from "../../lib/observeResize";
import { cn, newMessageId, newThreadId } from "../../lib/utils";
import { useProjects, useServerConfigs, useThreadShell } from "../../state/entities";
import {
  useEnvironmentMachines,
  useEnvironmentProviders,
  useEnvironments,
  usePrimaryEnvironmentId,
} from "../../state/environments";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { getTriggerDisplayModelLabel } from "../chat/providerIconUtils";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { resolveThreadStatusPill } from "../Sidebar.logic";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { resolveQuickChatEnvironmentId, resolveQuickChatLaunchDefaults } from "./QuickChat.logic";

interface StartedThread {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly title: string;
}

const COMMAND_OPTIONS = { reportFailure: false, reportDefect: false } as const;

function hideQuickChat() {
  void window.desktopBridge?.hideQuickChat?.().catch(() => undefined);
}

function commandFailureMessage(result: AtomCommandResult<unknown, unknown>): string | null {
  if (result._tag === "Success" || isAtomCommandInterrupted(result)) return null;
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : "Could not start the thread.";
}

/** The desktop quick chat window: one prompt that starts a thread without a project. */
export function QuickChat() {
  const bridge = window.desktopBridge;
  useRenderedAppearance();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const machines = useEnvironmentMachines();
  const serverConfigs = useServerConfigs();
  const providersByEnvironment = useEnvironmentProviders();
  const projects = useProjects();
  const openScratch = useAtomCommand(projectEnvironment.openScratch, COMMAND_OPTIONS);
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, COMMAND_OPTIONS);

  const [prompt, setPrompt] = useState("");
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<EnvironmentId | null>(null);
  const [choosingMachine, setChoosingMachine] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState<StartedThread | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  const offered = environments.filter(
    (environment) =>
      availableScratchWorkspaceRoot(environment.connection.phase, environment.serverConfig) !==
      null,
  );
  const environmentId = resolveQuickChatEnvironmentId(
    offered.map((environment) => environment.environmentId),
    primaryEnvironmentId,
    selectedEnvironmentId,
  );
  const environment = offered.find((entry) => entry.environmentId === environmentId) ?? null;
  // Subscribing also keeps the session loaded for the operate check when sending.
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const connecting = environments.some(
    (entry) => entry.connection.phase === "connecting" || entry.connection.phase === "reconnecting",
  );
  const providers = environmentId === null ? [] : (providersByEnvironment.get(environmentId) ?? []);
  const launchDefaultsFor = (projectId: ProjectId | null) =>
    environmentId === null
      ? null
      : resolveQuickChatLaunchDefaults({
          settings: serverConfigs.get(environmentId)?.settings ?? DEFAULT_SERVER_SETTINGS,
          providers,
          projectId,
        });
  const scratchProject =
    projects.find((project) => project.environmentId === environmentId && project.isScratch) ??
    null;
  const launchDefaults = launchDefaultsFor(scratchProject?.id ?? null);
  const selectedProvider = providers.find(
    (provider) => provider.instanceId === launchDefaults?.modelSelection.instanceId,
  );
  const selectedModel = selectedProvider?.models.find(
    (model) => model.slug === launchDefaults?.modelSelection.model,
  );
  const modelLabel = selectedModel ? getTriggerDisplayModelLabel(selectedModel) : null;

  // Report the card's height so the window hugs it.
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card || !bridge?.resizeQuickChat) return;
    return observeResize(card, () => {
      void bridge.resizeQuickChat?.(card.offsetHeight).catch(() => undefined);
    });
  }, [bridge]);

  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.quickChat = "";
    return () => {
      delete root.dataset.quickChat;
    };
  }, []);

  // Each summons starts on this machine; a started thread keeps running on its own.
  const reset = useEffectEvent(() => {
    setStarted(null);
    setSelectedEnvironmentId(null);
    setChoosingMachine(false);
    setError(null);
  });
  const focusPrompt = useEffectEvent(() => promptRef.current?.focus());
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") reset();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      hideQuickChat();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", focusPrompt);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", focusPrompt);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  const send = async () => {
    const text = prompt.trim();
    if (text.length === 0 || sending || environmentId === null || !canOperate) return;
    setSending(true);
    setError(null);
    try {
      const opened = await openScratch({ environmentId, input: {} });
      if (opened._tag === "Failure") {
        setError(commandFailureMessage(opened));
        return;
      }
      const defaults = launchDefaultsFor(opened.value.id);
      if (defaults === null) {
        setError(`No provider is ready on ${environment?.label ?? "this machine"}.`);
        return;
      }
      const threadId = newThreadId();
      const title = deriveThreadTitleSeed({ text, attachments: [] });
      const result = await startTurn({
        environmentId,
        input: {
          threadId,
          message: { messageId: newMessageId(), role: "user", text, attachments: [] },
          modelSelection: defaults.modelSelection,
          titleSeed: title,
          runtimeMode: defaults.runtimeMode,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          bootstrap: {
            createThread: {
              projectId: opened.value.id,
              title,
              modelSelection: defaults.modelSelection,
              runtimeMode: defaults.runtimeMode,
              interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
              branch: null,
              worktreePath: null,
              createdAt: new Date().toISOString(),
            },
          },
        },
      });
      if (result._tag === "Failure") {
        setError(commandFailureMessage(result));
        return;
      }
      setPrompt("");
      setStarted({ environmentId, threadId, title });
    } finally {
      setSending(false);
    }
  };

  return (
    <div ref={cardRef} className="fixed inset-x-0 bottom-0 p-3">
      <div className="overflow-hidden rounded-2xl border border-border bg-popover text-popover-foreground shadow-lg">
        {started ? (
          <StartedThreadRow
            started={started}
            machineLabel={
              environments.find((entry) => entry.environmentId === started.environmentId)?.label ??
              null
            }
            onOpen={() => void bridge?.openQuickChatThread?.(started).catch(() => undefined)}
            onClose={hideQuickChat}
          />
        ) : (
          <>
            <textarea
              ref={promptRef}
              autoFocus
              rows={1}
              value={prompt}
              placeholder="Ask T3 Code to do something…"
              aria-label="Message"
              disabled={sending}
              className="field-sizing-content block max-h-60 min-h-12 w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-base outline-none placeholder:text-muted-foreground"
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
                  return;
                }
                event.preventDefault();
                void send();
              }}
            />
            {choosingMachine ? (
              <div role="listbox" aria-label="Machine" className="flex flex-col gap-0.5 px-2 pb-1">
                {offered.map((entry) => (
                  <button
                    key={entry.environmentId}
                    type="button"
                    role="option"
                    aria-selected={entry.environmentId === environmentId}
                    className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
                    onClick={() => {
                      setSelectedEnvironmentId(entry.environmentId);
                      setChoosingMachine(false);
                      promptRef.current?.focus();
                    }}
                  >
                    <EnvironmentMachineIcon
                      kind={machines.get(entry.environmentId) ?? "server"}
                      className="size-3.5 shrink-0 text-muted-foreground"
                    />
                    <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                    {entry.environmentId === environmentId ? (
                      <CheckIcon aria-hidden className="size-3.5 shrink-0" />
                    ) : null}
                  </button>
                ))}
              </div>
            ) : null}
            {error ? <p className="px-4 pb-1 text-destructive text-xs">{error}</p> : null}
            <div className="flex items-center gap-1 px-2 pb-2">
              {environment && offered.length > 1 ? (
                <Button
                  variant="ghost"
                  size="xs"
                  aria-expanded={choosingMachine}
                  aria-label={`Run on ${environment.label}`}
                  onClick={() => setChoosingMachine((open) => !open)}
                >
                  <EnvironmentMachineIcon
                    kind={machines.get(environment.environmentId) ?? "server"}
                  />
                  {environment.label}
                  <ChevronDownIcon aria-hidden />
                </Button>
              ) : environment ? (
                <span className="flex items-center gap-1 px-2 text-muted-foreground text-xs">
                  <EnvironmentMachineIcon
                    kind={machines.get(environment.environmentId) ?? "server"}
                    className="size-3.5"
                  />
                  {environment.label}
                </span>
              ) : (
                <span className="px-2 text-muted-foreground text-xs">
                  {connecting ? "Connecting…" : "No machine can start a thread right now."}
                </span>
              )}
              {modelLabel ? (
                <span className="min-w-0 truncate text-muted-foreground text-xs">{modelLabel}</span>
              ) : null}
              <div className="flex-1" />
              <Button
                size="icon-sm"
                aria-label="Start thread"
                disabled={
                  sending || prompt.trim().length === 0 || environment === null || !canOperate
                }
                onClick={() => void send()}
              >
                {sending ? <Spinner /> : <ArrowUpIcon aria-hidden />}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function StartedThreadRow({
  started,
  machineLabel,
  onOpen,
  onClose,
}: {
  readonly started: StartedThread;
  readonly machineLabel: string | null;
  readonly onOpen: () => void;
  readonly onClose: () => void;
}) {
  const shell = useThreadShell(scopeThreadRef(started.environmentId, started.threadId));
  const status = shell ? resolveThreadStatusPill({ thread: shell }) : null;
  const statusLabel = status?.label ?? "Starting";

  return (
    <div className="flex items-center gap-3 py-2.5 pr-2.5 pl-4">
      <span
        aria-hidden
        className={cn("size-2 shrink-0 rounded-full", status?.dotClass ?? "bg-muted-foreground")}
      />
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium text-sm">{shell?.title ?? started.title}</p>
        <p className="truncate text-muted-foreground text-xs">
          {machineLabel ? `${statusLabel} on ${machineLabel}` : statusLabel}
        </p>
      </div>
      <Button size="sm" variant="outline" onClick={onOpen}>
        Open in T3 Code
      </Button>
      <Button size="icon-sm" variant="ghost" aria-label="Close" onClick={onClose}>
        <XIcon aria-hidden />
      </Button>
    </div>
  );
}
