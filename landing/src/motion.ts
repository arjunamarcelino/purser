// Every animation here shows a ledger fact changing, in text. All of it runs through gsap.matchMedia, so reduced motion is live.

import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { RACE_REFUSED, RACE_RESERVED, RACE_SETTLED, capBar, gauge, raceFrame, railFrame, revealFrame, scrambleFrame } from "./ascii.ts";

gsap.registerPlugin(ScrollTrigger);

const $ = <T extends Element>(selector: string) => document.querySelector<T>(selector);
const text = (selector: string, value: number | string) => {
  const el = $(selector);
  if (el) el.textContent = String(value);
};

function columnsOf(el: HTMLElement): number {
  const css = getComputedStyle(el);
  const probe = document.createElement("canvas").getContext("2d")!;
  probe.font = css.font;
  const inner = el.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight);
  return Math.max(20, Math.floor(inner / probe.measureText("0").width));
}

function setBar(completed: number, outstanding: number) {
  text("[data-bar-completed]", completed);
  text("[data-bar-outstanding]", outstanding);
  text("[data-bar-used]", completed + outstanding);
  text("[data-bar-gauge]", gauge(completed + outstanding, 100, 12));
}

function createRaceStage(el: HTMLElement) {
  const rows = raceFrame(1, 40).map(() => el.appendChild(document.createElement("span")));
  let progress = 1;
  const draw = (p: number) => {
    progress = p;
    raceFrame(p, columnsOf(el)).forEach((row, i) => {
      rows[i]!.textContent = row.text || " ";
      rows[i]!.dataset.tone = row.tone;
    });
  };
  new ResizeObserver(() => draw(progress)).observe(el);
  draw(1);
  return {
    draw,
    play() {
      const state = { p: 0 };
      gsap.to(state, { p: 1, duration: 3.5, ease: "none", onUpdate: () => draw(state.p) });
    },
  };
}
type RaceStage = ReturnType<typeof createRaceStage>;

function decode(el: HTMLElement, duration: number, scrollTrigger?: ScrollTrigger.Vars) {
  const original = el.textContent ?? "";
  const state = { p: 0 };
  el.textContent = scrambleFrame(original, 0);
  gsap.to(state, {
    p: 1,
    duration,
    ease: "none",
    ...(scrollTrigger ? { scrollTrigger } : {}),
    onUpdate: () => {
      el.textContent = scrambleFrame(original, state.p);
    },
    onComplete: () => {
      el.textContent = original;
    },
  });
  return () => {
    el.textContent = original;
  };
}

function initHero() {
  const title = $<HTMLElement>(".hero-title");
  if (!title) return;
  gsap.set(title, { visibility: "visible" });
  return decode(title, 1.1);
}

function initHeadings() {
  return gsap.utils.toArray<HTMLElement>("h2").map((heading) => decode(heading, 0.7, { trigger: heading, start: "top 85%", once: true }));
}

function initDiagrams() {
  return gsap.utils.toArray<HTMLElement>("[data-ascii-reveal]").map((el) => {
    const source = el.textContent ?? "";
    const state = { p: 0 };
    el.textContent = revealFrame(source, 0);
    gsap.to(state, {
      p: 1,
      duration: 1.2,
      ease: "none",
      scrollTrigger: { trigger: el, start: "top 80%", once: true },
      onUpdate: () => {
        el.textContent = revealFrame(source, state.p);
      },
    });
    return () => {
      el.textContent = source;
    };
  });
}

function naiveBar(spent: number) {
  const el = $<HTMLElement>("[data-naive-bar]");
  if (el) el.textContent = capBar(spent, 100, 120, columnsOf(el));
  text("[data-naive-spent]", Math.round(spent));
}

function initNaiveCount() {
  const state = { spent: 0 };
  naiveBar(0);
  gsap.to(state, { spent: 120, duration: 1.1, ease: "power2.out", scrollTrigger: { trigger: ".naive", start: "top 75%", once: true }, onUpdate: () => naiveBar(state.spent) });
}

function createRail() {
  const rail = $<HTMLElement>("[data-how-rail]");
  const list = $<HTMLElement>(".how-steps");
  if (!rail || !list) return () => {};
  const lineHeight = parseFloat(getComputedStyle(rail).lineHeight);
  let progress = 1;
  const draw = (p: number) => {
    progress = p;
    rail.textContent = railFrame(p, Math.floor(list.offsetHeight / lineHeight));
  };
  new ResizeObserver(() => draw(progress)).observe(list);
  draw(1);
  return draw;
}

function barFollowsPage(raceDrivesBar: boolean) {
  ScrollTrigger.create({
    trigger: "#race",
    start: "top 60%",
    onEnter: () => setBar(raceDrivesBar ? 60 : 90, 0),
    onLeaveBack: () => setBar(0, 0),
  });
}

function pinnedRace(stage: RaceStage) {
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
        const p = self.progress;
        stage.draw(p);
        if (p < RACE_RESERVED) setBar(60, 0);
        else if (p < RACE_SETTLED) setBar(60, 30);
        else setBar(90, 0);
      },
    },
  });
  gsap.set(steps.slice(1), { autoAlpha: 0 });
  gsap.set(rows, { autoAlpha: 0 });
  text("[data-race-remaining]", 40);
  stage.draw(0);
  tl.to(steps[0]!, { autoAlpha: 0, duration: 0.06 }, 0.3)
    .to(steps[1]!, { autoAlpha: 1, duration: 0.06 }, 0.34)
    .to(rows[0]!, { autoAlpha: 1, duration: 0.05 }, RACE_RESERVED)
    .to(race, { remaining: 10, duration: 0.1, onUpdate: () => text("[data-race-remaining]", Math.round(race.remaining)) }, RACE_RESERVED)
    .to(steps[1]!, { autoAlpha: 0, duration: 0.06 }, 0.58)
    .to(steps[2]!, { autoAlpha: 1, duration: 0.06 }, RACE_REFUSED)
    .to(rows.slice(1), { autoAlpha: 1, duration: 0.05, stagger: 0.04 }, RACE_REFUSED)
    .to({}, { duration: 0.2 }, 0.8);
  return () => {
    document.documentElement.classList.remove("js-pinned");
    text("[data-race-remaining]", 10);
    stage.draw(1);
  };
}

function freeRace(stage: RaceStage, autoplay: boolean) {
  const replay = $<HTMLButtonElement>("[data-race-replay]");
  const play = () => stage.play();
  stage.draw(1);
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

export async function initMotion() {
  await document.fonts.ready;
  const stageEl = $<HTMLElement>("[data-race-stage]");
  const stage = stageEl ? createRaceStage(stageEl) : null;
  const drawRail = createRail();

  naiveBar(120);
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
        cleanups.push(initHero(), ...initHeadings(), ...initDiagrams());
        initNaiveCount();
        ScrollTrigger.create({ trigger: ".how-grid", start: "top 70%", end: "bottom 70%", onUpdate: (self) => drawRail(self.progress) });
        drawRail(0);
      } else {
        naiveBar(120);
        drawRail(1);
      }
      barFollowsPage(pinnable);
      if (stage) cleanups.push(pinnable ? pinnedRace(stage) : freeRace(stage, motion && !reduce));
      return () => cleanups.forEach((cleanup) => cleanup?.());
    },
  );
  document.documentElement.classList.remove("js-motion");
}
