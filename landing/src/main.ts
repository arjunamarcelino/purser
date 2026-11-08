import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-mono/600.css";
import "../../app/src/styles/tokens.css";
import "./theme.css";
import "./styles.css";
import { initAsciiArt } from "./ascii-scene.ts";
import { initMotion } from "./motion.ts";

// Waits for the font so the glyphs measure and draw as IBM Plex Mono from the first frame.
function initArt() {
  void document.fonts.ready.then(() => document.querySelectorAll<HTMLCanvasElement>("[data-ascii-art]").forEach(initAsciiArt));
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

initMenu();
initCopy();
initArt();
initMotion().catch(() => {
  // A failed animation setup must never hide the page: the headline's guard class comes off here.
  document.documentElement.classList.remove("js-motion");
});
