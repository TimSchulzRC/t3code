import { createFileRoute } from "@tanstack/react-router";

import { QuickChat } from "../components/quickChat/QuickChat";

export const Route = createFileRoute("/quick-chat")({
  component: QuickChat,
});
