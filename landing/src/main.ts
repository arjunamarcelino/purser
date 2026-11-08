import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "../../app/src/styles/tokens.css";
import "./styles.css";
import { initMotion } from "./motion.ts";

const THEME_KEY = "purser.theme";
const NEXT_THEME = { system: "dark", dark: "light", light: "system" } as const;
type Theme = keyof typeof NEXT_THEME;

function readTheme(): Theme {
  const set = document.documentElement.dataset.theme;
  return set === "dark" || set === "light" ? set : "system";
}

function initTheme() {
  const button = document.querySelector<HTMLButtonElement>(".theme-toggle");
  if (!button) return;
  const show = (theme: Theme) => {
    button.textContent = `Theme: ${theme}`;
  };
  show(readTheme());
  button.addEventListener("click", () => {
    const next = NEXT_THEME[readTheme()];
    if (next === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = next;
    try {
      if (next === "system") localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, next);
    } catch {
      // Private browsing can refuse storage: the choice still applies to this visit.
    }
    show(next);
    document.dispatchEvent(new CustomEvent("purser:theme"));
  });
}

function initMenu() {
  const button = document.querySelector<HTMLButtonElement>(".menu-toggle");
  const nav = document.querySelector<HTMLElement>(".site-nav");
  if (!button || !nav) return;
  const setOpen = (open: boolean) => {
    nav.classList.toggle("open", open);
    button.setAttribute("aria-expanded", String(open));
    button.textContent = open ? "Close" : "Menu";
  };
  button.addEventListener("click", () => setOpen(!nav.classList.contains("open")));
  nav.addEventListener("click", (e) => {
    if (e.target instanceof HTMLAnchorElement) setOpen(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && nav.classList.contains("open")) {
      setOpen(false);
      button.focus();
    }
  });
}

function initCopy() {
  const status = document.querySelector<HTMLElement>("[data-copy-status]");
  document.querySelectorAll<HTMLButtonElement>("[data-copy]").forEach((button) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    button.addEventListener("click", async () => {
      clearTimeout(timer);
      try {
        await navigator.clipboard.writeText(button.dataset.copy ?? "");
        button.textContent = "Copied";
        button.dataset.state = "done";
        if (status) status.textContent = `Copied: ${button.dataset.copy}`;
      } catch {
        if (status) status.textContent = "This browser blocked copying. Select the command and copy it by hand.";
      }
      timer = setTimeout(() => {
        button.textContent = "Copy";
        delete button.dataset.state;
      }, 1800);
    });
  });
}

initTheme();
initMenu();
initCopy();
initMotion().catch(() => {
  // A failed animation setup must never hide the page: the headline's guard class comes off here.
  document.documentElement.classList.remove("js-motion");
});
