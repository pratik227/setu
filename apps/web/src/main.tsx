import { ThemeProvider, TooltipProvider } from "@setu/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { EngineProvider } from "./engine/EngineProvider";
import { SessionProvider } from "./features/identity/SessionProvider";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Nostr data arrives via store subscriptions, not query polling; React
      // Query is here for request-shaped work (NIP-05 checks, link previews).
      staleTime: 60_000,
      refetchOnWindowFocus: false,
    },
  },
});

const container = document.getElementById("root");
if (!container) throw new Error("#root not found");

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <TooltipProvider>
          {/* Session is outermost: the engine needs the signed-in pubkey to decide
            whether it may rebroadcast a protected (NIP-70) event, and the store
            is scoped per account. SessionProvider has no engine dependency, so
            this direction is the one that works. */}
          <SessionProvider>
            <EngineProvider>
              <App />
            </EngineProvider>
          </SessionProvider>
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
);
