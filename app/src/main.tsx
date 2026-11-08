import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./styles/tokens.css";
import "./styles/app.css";
import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";

// Belt and braces with COOP: drop any handle to a window that opened this board.
try {
  window.opener = null;
} catch {
  /* read-only in some contexts */
}

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");
// Dev only: the whole branch is compiled out of a production build, chunk included.
const Comparison = import.meta.env.DEV && new URLSearchParams(location.search).get("baseline") === "1" ? lazy(() => import("./baseline/BaselinePage.tsx")) : null;
createRoot(root).render(
  <StrictMode>
    {Comparison ? (
      <Suspense fallback={null}>
        <Comparison />
      </Suspense>
    ) : (
      <App />
    )}
  </StrictMode>,
);
