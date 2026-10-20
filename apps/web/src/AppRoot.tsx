import { RouterProvider } from "@tanstack/react-router";
import { QUICK_CHAT_APP_PATH } from "@t3tools/contracts";
import { useEffect } from "react";

import { subscribeComposerDraftModelReconciliation } from "./composerDraftStore";
import { environmentThreadShells } from "./state/threads";
import { environmentShell } from "./state/shell";

import { BrowserProfileReporter } from "./browser/BrowserProfileReporter";
import { ElectronBrowserHost } from "./browser/ElectronBrowserHost";
import { QuitHoldOverlay } from "./components/QuitHoldOverlay";
import { appAtomRegistry, AppAtomRegistryProvider } from "./rpc/atomRegistry";
import type { AppRouter } from "./router";

/**
 * The Electron browser host intentionally sits outside the router so its
 * webviews survive route transitions, but it must share the same atom registry
 * as routed UI.
 */
export function AppRoot({ router }: { readonly router: AppRouter }) {
  // The desktop quick chat window shares this origin's storage with the main
  // window, so it must not write drafts or host the main window's surfaces.
  const quickChat = router.state.location.pathname === QUICK_CHAT_APP_PATH;
  useEffect(
    () =>
      quickChat
        ? undefined
        : subscribeComposerDraftModelReconciliation({
            registry: appAtomRegistry,
            threadShellAtom: environmentThreadShells.threadShellAtom,
            threadRefsAtom: environmentThreadShells.threadRefsAtom,
            shellStateAtom: environmentShell.stateAtom,
          }),
    [quickChat],
  );
  return (
    <AppAtomRegistryProvider>
      <RouterProvider router={router} />
      {quickChat ? null : (
        <>
          <ElectronBrowserHost />
          <BrowserProfileReporter />
          <QuitHoldOverlay />
        </>
      )}
    </AppAtomRegistryProvider>
  );
}
