// Every animation here shows a ledger fact changing. All of it runs through gsap.matchMedia, so reduced motion is live.

import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { SplitText } from "gsap/SplitText";
import { DotLottie } from "@lottiefiles/dotlottie-web";
// Bundled through a relative path (the package doesn't export it) so the page makes no third-party request.
import wasmUrl from "../node_modules/@lottiefiles/dotlottie-web/dist/dotlottie-player.wasm?url";
import { RACE_FRAMES, buildRaceAnimation } from "./race-lottie.ts";

gsap.registerPlugin(ScrollTrigger, SplitText);

const $ = <T extends Element>(selector: string) => document.querySelector<T>(selector);
const text = (selector: string, value: number | string) => {
  const el = $(selector);
  if (el) el.textContent = String(value);
};

function setBar(completed: number, outstanding: number) {
  text("[data-bar-completed]", completed);
  text("[data-bar-outstanding]", outstanding);
  text("[data-bar-used]", completed + outstanding);
}

const palette = () => {
  const css = getComputedStyle(document.documentElement);
  const token = (name: string) => css.getPropertyValue(name).trim();
  return { track: token("--border-strong"), gate: token("--text"), agent: token("--text-dim"), admitted: token("--ok"), refused: token("--warn") };
};

// Keeps the frame across a theme reload, and reports a failed runtime so the page can say so.
function createRacePlayer(canvas: HTMLCanvasElement) {
  DotLottie.setWasmUrl(wasmUrl);
  let frame = RACE_FRAMES - 1;
  const showFallback = () => {
    canvas.hidden = true;
    const note = $<HTMLElement>("[data-race-fallback]");
    if (note) note.hidden = false;
  };
  const player = new DotLottie({ canvas, data: JSON.stringify(buildRaceAnimation(palette())), autoplay: false, loop: false, renderConfig: { autoResize: true } });
  player.addEventListener("load", () => player.setFrame(frame));
  player.addEventListener("loadError", showFallback);
  const onTheme = () => player.load({ data: JSON.stringify(buildRaceAnimation(palette())), autoplay: false, loop: false });
  document.addEventListener("purser:theme", onTheme);
  matchMedia("(prefers-color-scheme: light)").addEventListener("change", onTheme);
  return {
    setProgress(p: number) {
      frame = Math.min(RACE_FRAMES - 1, p * (RACE_FRAMES - 1));
      player.setFrame(frame);
    },
    playOnce() {
      player.stop();
      player.play();
      frame = RACE_FRAMES - 1;
    },
  };
}

function initHero() {
  const title = $<HTMLElement>(".hero-title");
  if (!title) return;
  gsap.set(title, { visibility: "visible" });
  const split = SplitText.create(title, {
    type: "lines",
    mask: "lines",
    autoSplit: true,
    onSplit: (self) => gsap.from(self.lines, { yPercent: 105, duration: 0.8, stagger: 0.09, ease: "power4.out" }),
  });
  return () => split.revert();
}

function initNaiveCount() {
  const fill = $(".cap-fill");
  const spent = { value: 0 };
  gsap
    .timeline({ scrollTrigger: { trigger: ".naive", start: "top 75%", once: true } })
    .fromTo(spent, { value: 0 }, { value: 120, duration: 1.1, ease: "power2.out", onUpdate: () => text("[data-naive-spent]", Math.round(spent.value)) }, 0)
    .fromTo(fill, { scaleX: 0 }, { scaleX: 1, duration: 1.1, ease: "power2.out" }, 0);
}

function barFollowsPage(raceDrivesBar: boolean) {
  ScrollTrigger.create({
    trigger: "#race",
    start: "top 60%",
    onEnter: () => setBar(raceDrivesBar ? 60 : 90, 0),
    onLeaveBack: () => setBar(0, 0),
  });
}

function pinnedRace(player: ReturnType<typeof createRacePlayer>) {
  document.documentElement.classList.add("js-pinned");
  const steps = gsap.utils.toArray<HTMLElement>(".race-step");
  const rows = gsap.utils.toArray<HTMLElement>("[data-race-row]");
  const race = { remaining: 40 };
  const tl = gsap.timeline({
    defaults: { ease: "none" },
    scrollTrigger: {
      trigger: ".race-pin",
      start: "top top",
      end: "+=220%",
      pin: true,
      scrub: 0.4,
      anticipatePin: 1,
      onUpdate: (self) => {
        player.setProgress(self.progress);
        const p = self.progress;
        if (p < 0.36) setBar(60, 0);
        else if (p < 0.7) setBar(60, 30);
        else setBar(90, 0);
      },
    },
  });
  gsap.set(steps.slice(1), { autoAlpha: 0 });
  gsap.set(rows, { autoAlpha: 0 });
  text("[data-race-remaining]", 40);
  tl.to(steps[0]!, { autoAlpha: 0, duration: 0.06 }, 0.3)
    .to(steps[1]!, { autoAlpha: 1, duration: 0.06 }, 0.34)
    .to(rows[0]!, { autoAlpha: 1, duration: 0.05 }, 0.38)
    .to(race, { remaining: 10, duration: 0.1, onUpdate: () => text("[data-race-remaining]", Math.round(race.remaining)) }, 0.38)
    .to(steps[1]!, { autoAlpha: 0, duration: 0.06 }, 0.62)
    .to(steps[2]!, { autoAlpha: 1, duration: 0.06 }, 0.66)
    .to(rows.slice(1), { autoAlpha: 1, duration: 0.05, stagger: 0.04 }, 0.68)
    .to({}, { duration: 0.2 }, 0.8);
  return () => {
    document.documentElement.classList.remove("js-pinned");
    text("[data-race-remaining]", 10);
  };
}

function freeRace(player: ReturnType<typeof createRacePlayer>, autoplay: boolean) {
  const replay = $<HTMLButtonElement>("[data-race-replay]");
  const play = () => player.playOnce();
  player.setProgress(1);
  if (replay) {
    replay.hidden = false;
    replay.addEventListener("click", play);
  }
  if (autoplay) ScrollTrigger.create({ trigger: ".race-stage", start: "top 70%", once: true, onEnter: play });
  return () => {
    if (replay) {
      replay.hidden = true;
      replay.removeEventListener("click", play);
    }
  };
}

function initHowLine() {
  gsap.fromTo("[data-how-line]", { scaleY: 0 }, { scaleY: 1, ease: "none", scrollTrigger: { trigger: ".how-grid", start: "top 70%", end: "bottom 70%", scrub: 0.3 } });
}

function initZero() {
  gsap.from("[data-evidence-zero]", { autoAlpha: 0, y: 24, duration: 0.6, ease: "power3.out", scrollTrigger: { trigger: ".evidence-grid", start: "top 80%", once: true } });
}

export async function initMotion() {
  await document.fonts.ready;
  const canvas = $<HTMLCanvasElement>("[data-race-canvas]");
  const player = canvas ? createRacePlayer(canvas) : null;

  setBar(0, 0);
  const mm = gsap.matchMedia();
  mm.add(
    {
      pinnable: "(min-width: 900px) and (min-height: 760px) and (prefers-reduced-motion: no-preference)",
      motion: "(prefers-reduced-motion: no-preference)",
      reduce: "(prefers-reduced-motion: reduce)",
    },
    (context) => {
      const { pinnable, motion, reduce } = context.conditions as { pinnable: boolean; motion: boolean; reduce: boolean };
      const cleanups: ((() => void) | undefined)[] = [];
      if (motion) {
        cleanups.push(initHero());
        initNaiveCount();
        initHowLine();
        initZero();
      }
      barFollowsPage(pinnable);
      if (player) cleanups.push(pinnable ? pinnedRace(player) : freeRace(player, motion && !reduce));
      return () => cleanups.forEach((cleanup) => cleanup?.());
    },
  );
  document.documentElement.classList.remove("js-motion");
}
