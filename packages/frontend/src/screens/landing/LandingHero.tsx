import { useRef } from "react";
import { Link } from "react-router-dom";
import { DARK_PANEL_BG_CLASS, DARK_RAISED_CONTROL_BORDER_CLASS } from "../../theme/darkSurfaces";
import { LandingCub } from "./LandingCub";
import { LandingScenarioChips, LandingSessionDeck, useLandingScenarioDeck } from "./LandingSessionDeck";

export const PRIMARY_LINK =
  "inline-flex min-h-12 items-center justify-center gap-3 rounded-xl bg-primary-600 px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-primary-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary-500";

/**
 * The landing's page gutter, the approved hero's: 24 px on phones, 28 px from
 * md and 40 px from 1000 px, where Cub sits on the window's corner (his
 * corner drape and the peeking arm's curl hang in the margin right of the
 * window, so it must not be narrower than the approved hero's). The content
 * stays 1104 px wide at most, as before. The header and the sections under the
 * hero use it too, so every left edge lines up with the headline. 62.5rem is
 * 1000px, written in rem so it sorts after md.
 */
export const LANDING_GUTTER = "max-w-[74rem] px-6 md:px-7 min-[62.5rem]:px-10";

// The secondary entry is a bordered button on the page's surface fill, the
// same height as the primary one.
const SECONDARY_LINK = `inline-flex min-h-12 items-center justify-center rounded-xl border border-slate-200 bg-white px-5 py-3 text-sm font-medium text-brand-ink transition-colors hover:border-slate-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary-500 ${DARK_RAISED_CONTROL_BORDER_CLASS} ${DARK_PANEL_BG_CLASS} dark:text-slate-100 dark:hover:border-white/30`;

/**
 * The landing hero: paper with a 24px dot grid, the headline, sub copy and
 * entries stacked on the left with the scenario chips under them, an open cell
 * on the right, and the studio example window below.
 *
 * Stacking (the section is its own stacking context and clips its children):
 * - z-0: the paper and its dot grid, behind everything (Cub's light ink
 *   multiplies with them).
 * - auto: the content (copy, chips, window), in document order above the grid.
 * - z-3: Cub's canvases (LandingCub's layer has no z-index of its own),
 *   above the content and the window.
 * - z-[4]: the window's roster (landingStudioChrome.ts ROSTER), so the coins
 *   stay above Cub's arm as it taps them. The tab strip and the transcript
 *   are isolated so their own z-indexes stay below z-3.
 *
 * Cub reads the page through data-cub-anchor attributes (cub/landingCub.ts):
 * the headline, the sub copy, the entries and the chips here, and the
 * window, its panels, coins, messages and chrome in the deck.
 */
export function LandingHero({ entryLabel }: { entryLabel: string }) {
  // The first turn waits for Cub to say hello (LandingCub releases it), so a
  // first visit reads: Cub notices the visitor, then lends Octo an arm.
  const deck = useLandingScenarioDeck({ holdFirstTurn: true });
  const heroRef = useRef<HTMLElement | null>(null);

  return (
    <section
      ref={heroRef}
      aria-labelledby="landing-title"
      data-testid="landing-hero"
      data-cub-anchor="hero"
      className="relative isolate overflow-hidden pb-8"
    >
      <div
        aria-hidden="true"
        data-testid="landing-dot-grid"
        className="marketing-dot-grid pointer-events-none absolute inset-0 z-0 bg-[var(--marketing-canvas)]"
      />

      <LandingCub deck={deck} heroRef={heroRef} />

      <div className={`relative mx-auto w-full ${LANDING_GUTTER}`}>
        {/* Phones: the copy spans both columns, then the chips stack on the
            left with the open cell beside them (the copy and its entries row
            lay their children straight into the grid). md+: copy, entries and
            chips on the left, the open cell spanning both rows on the right.
            From 1184px (74rem, in rem so it sorts after md) the chips sit on
            the entries' row, beside the buttons, so the window comes up into
            the first view. */}
        <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-1.5 pt-3.5 md:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] md:grid-rows-[auto_1fr] md:gap-x-5 md:pt-[26px] lg:gap-x-8 md:[@media(min-height:921px)]:pt-11 min-[74rem]:[@media(max-height:799px)]:pt-3">
          <div className="contents md:col-start-1 md:row-start-1 md:block">
            <h1
              id="landing-title"
              className="col-span-2 break-words text-[clamp(2.5rem,11.8vw,3.625rem)] font-extrabold leading-[0.98] tracking-[-0.045em] text-brand-ink dark:text-slate-100 md:text-[clamp(2.875rem,6.4vw,5.75rem)] min-[74rem]:[@media(min-height:841px)_and_(max-height:960px)]:text-[4.75rem] min-[74rem]:[@media(min-height:800px)_and_(max-height:840px)]:text-[4rem] min-[74rem]:[@media(max-height:799px)]:text-[3.375rem]"
              data-testid="landing-hero-heading"
              data-cub-anchor="headline"
            >
              {/* One block per line. At the default text size each line fits
                  its column with room to spare; with larger user text a line
                  wraps (and a word wider than a small phone's column breaks)
                  rather than running under the open cell or past the hero's
                  clip. */}
              <span className="block">Good work</span>{" "}
              <span className="block">has company.</span>
            </h1>
            {/* 68.8125rem is 1101px, written in rem so it sorts after md. */}
            <p data-cub-anchor="sub" className="col-span-2 mt-3.5 max-w-[28em] text-base leading-normal text-slate-600 dark:text-slate-300 md:mt-5 md:max-w-[25em] md:text-[17px] md:leading-[1.55] min-[68.8125rem]:max-w-[28em] min-[68.8125rem]:text-[19px] md:[@media(min-height:921px)]:mt-6 min-[74rem]:[@media(max-height:799px)]:mt-3 min-[74rem]:[@media(max-height:799px)]:max-w-none min-[74rem]:[@media(max-height:799px)]:text-base min-[74rem]:[@media(max-height:799px)]:leading-normal">
              Bring your people, your AI, and your work into one place.
              <span className="hidden md:inline"> Work through the numbers, build a feature, or launch something together.</span>
            </p>
            <div
              data-testid="landing-entries-row"
              className="contents md:flex md:flex-col md:items-start min-[74rem]:w-max min-[74rem]:flex-row min-[74rem]:items-end min-[74rem]:gap-x-7"
            >
              <div className="col-span-2 mt-[18px] flex flex-wrap items-center gap-2.5 md:mt-[26px] md:gap-3 md:[@media(min-height:921px)]:mt-[30px] min-[74rem]:[@media(max-height:799px)]:mt-4">
                <Link to="/studio" className={PRIMARY_LINK} data-testid="landing-get-started-button" data-cub-anchor="cta">
                  {entryLabel} <span aria-hidden="true">↗</span>
                </Link>
                <Link to="/install" className={SECONDARY_LINK} data-testid="landing-install-button" data-cub-anchor="cta-secondary">
                  Install Instafy
                </Link>
              </div>

              {/* Beside the buttons from 1184px, centred on them (the row
                  aligns bottoms; the chips are 10px shorter). */}
              <LandingScenarioChips
                deck={deck}
                className="col-start-1 row-start-4 mt-[22px] self-start md:mt-5 md:[@media(min-height:921px)]:mt-[26px] min-[74rem]:mb-[5px] min-[74rem]:self-auto"
              />
            </div>
          </div>

          {/* Kept open on purpose: Cub's room above the window's top-right
              corner. Decorative and empty; nothing here is read or focusable,
              and it takes no pointer, so the chips' row, which runs into it
              from 1184px, stays clickable. Cub draws in his own layer above,
              never inside this cell. */}
          <div
            aria-hidden="true"
            data-testid="landing-cub-zone"
            data-cub-anchor="zone"
            className="pointer-events-none col-start-2 row-start-4 min-h-[150px] md:row-span-2 md:row-start-1 md:min-h-[200px]"
          />
        </div>

        {/* On a short, wide screen (a laptop's first view) the headline eases
            (76px up to 960px tall, 64px up to 840px) and the window comes up
            closer to the chips, so the whole window, which fits the first
            view from 1184px (landingStudioChrome.ts FRAME), is on screen.
            Under 800px tall (a 1366x768 or 1280x720 laptop once the browser's
            own chrome is drawn) the hero tightens further: a 54px headline,
            the sub copy on two lines and less room between the parts. */}
        <LandingSessionDeck
          deck={deck}
          joinToFor={(scenario) => `/studio?from=landing-${scenario.id}`}
          className="mt-10 min-[74rem]:[@media(min-height:800px)_and_(max-height:960px)]:mt-7 min-[74rem]:[@media(max-height:799px)]:mt-4"
        />
      </div>
    </section>
  );
}
