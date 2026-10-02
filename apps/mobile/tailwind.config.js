/**
 * MomentLens — tailwind.config.js
 * NativeWind v4 (Tailwind CSS v3 engine). Lives in apps/mobile/.
 *
 * Source of truth for every color and type token in the app.
 * Per EngineeringHandbook.md §15 and apps/mobile/AGENTS.md: NEVER hardcode a hex
 * value or a raw px font size in a component. Reference these tokens instead
 * — `bg-background`, `text-textPrimary`, `font-h1 text-h1`, etc. — so dark
 * mode and any future palette tweak happen in exactly one place.
 *
 * Colors resolve through CSS variables defined in ./global.css so that a
 * single `.dark` class flips every token at once (see the wiring notes at
 * the bottom of this file). Do not replace the `rgb(var(...) / <alpha-value>)`
 * pattern with plain hex strings — that's what makes `bg-accent/20` etc. work.
 *
 * Type follows D-124: Fraunces for event names, sub-event names and large titles, and the system
 * font (SF Pro on iOS, Roboto on Android) for everything else. A Fraunces role points at a loaded
 * font FILE (Fraunces_600SemiBold), because React Native does not synthesize weights for a custom
 * font. A system-font role sets no family at all, so each platform draws its own face, and carries
 * its weight through the plugin at the bottom. Either way, pair a `font-*` class with the `text-*`
 * class of the same role, e.g. className="font-h2 text-h2".
 */

const { platformSelect } = require('nativewind/theme');
const plugin = require('tailwindcss/plugin');

// One size per platform, resolved when the style is read on the phone. iOS takes Apple's default
// Dynamic Type sizes and Android the Material 3 type scale, so body text reads at the size each
// platform's own apps use (D-112).
const sized = (ios, android) => platformSelect({ ios, android, default: android });

/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class', // toggled explicitly via nativewind's colorScheme API —
  // required because Settings > Appearance offers
  // Light / Dark / System Default (spec §4.19), not just
  // "follow the OS."
  content: ['./src/**/*.{js,jsx,ts,tsx}'],
  presets: [require('nativewind/preset')],
  theme: {
    extend: {
      colors: {
        // --- Base surfaces ---
        background: 'rgb(var(--color-background) / <alpha-value>)', // page background
        surface: 'rgb(var(--color-surface) / <alpha-value>)', // cards, sheets, modals
        surfaceMuted: 'rgb(var(--color-surfaceMuted) / <alpha-value>)', // thumbnails, input tracks, recessed fills

        // --- Text ---
        textPrimary: 'rgb(var(--color-textPrimary) / <alpha-value>)', // headings, body copy
        textSecondary: 'rgb(var(--color-textSecondary) / <alpha-value>)', // secondary text, subtitles
        textMuted: 'rgb(var(--color-textMuted) / <alpha-value>)', // captions, placeholders — large text only, borderline contrast at small sizes

        // --- Borders ---
        border: 'rgb(var(--color-border) / <alpha-value>)', // default 1px borders
        borderStrong: 'rgb(var(--color-borderStrong) / <alpha-value>)', // input borders, card outlines

        // --- Accent (gold) ---
        accent: 'rgb(var(--color-accent) / <alpha-value>)', // button fills, icons, focus rings, slider handles
        accentPressed: 'rgb(var(--color-accentPressed) / <alpha-value>)', // pressed/active state of the above
        accentTint: 'rgb(var(--color-accentTint) / <alpha-value>)', // subtle badge/highlight backgrounds
        accentText: 'rgb(var(--color-accentText) / <alpha-value>)', // gold used AS TEXT — do not substitute `accent` here, contrast differs by mode

        // --- Semantic ---
        danger: 'rgb(var(--color-danger) / <alpha-value>)', // destructive actions (Delete event)
        dangerTint: 'rgb(var(--color-dangerTint) / <alpha-value>)', // destructive row/banner backgrounds
        success: 'rgb(var(--color-success) / <alpha-value>)', // confirmations, success states

        // --- Platform chrome and the Live card (D-124) ---
        surfaceContainer: 'rgb(var(--color-surfaceContainer) / <alpha-value>)', // Android's navigation bar, one tone off the page
        hero: 'rgb(var(--color-hero) / <alpha-value>)', // the Live card: ink in light mode, a raised warm surface in dark
        onHero: 'rgb(var(--color-onHero) / <alpha-value>)', // text on hero
        onPhoto: 'rgb(var(--color-onPhoto) / <alpha-value>)', // text over a cover or photo
        scrim: 'rgb(var(--color-scrim) / <alpha-value>)', // the shade under that text, used with an alpha
      },

      fontFamily: {
        // Fraunces, the brand's serif. The system-font roles are in the plugin below.
        'fraunces-semibold': ['Fraunces_600SemiBold'],
        display: ['Fraunces_600SemiBold'], // Display (launch, rare)
        title: ['Fraunces_600SemiBold'], // A tab's large title (D-125)
        h1: ['Fraunces_600SemiBold'], // H1: an event or sub-event name
      },

      fontSize: {
        // Line-height is not finalized yet — left at the RN/font default.
        // Add it here as [size, { lineHeight: '...' }] once decided; don't
        // guess a number into this file.
        //
        // iOS column: Large Title, Title 1, Title 3, Body, Subheadline, Headline, Subheadline,
        // Footnote, Caption 1. Android column: Display Small, Headline Medium, Title Large, Body
        // Large, Body Medium, a medium button's label, Label Large, Body Small, Label Small.
        display: sized('34px', '36px'),
        // iOS's Large Title and Material 3's large top app bar title (Headline Medium).
        title: sized('34px', '28px'),
        h1: '28px',
        h2: sized('20px', '22px'),
        body: sized('17px', '16px'),
        bodySecondary: sized('15px', '14px'),
        buttonLabel: sized('17px', '16px'),
        fieldLabel: sized('15px', '14px'),
        caption: sized('13px', '12px'),
        micro: sized('12px', '11px'),
        wordmark: sized('15px', '16px'),
      },
    },
  },
  // The system-font roles. They set a weight and no family, so iOS draws SF Pro and Android Roboto
  // at that weight (D-124).
  plugins: [
    plugin(({ addUtilities }) => {
      addUtilities({
        '.font-body': { 'font-weight': '400' },
        '.font-bodySecondary': { 'font-weight': '400' },
        '.font-h2': { 'font-weight': '600' },
        '.font-buttonLabel': { 'font-weight': '600' },
        '.font-fieldLabel': { 'font-weight': '500' },
        '.font-caption': { 'font-weight': '400' },
        '.font-micro': { 'font-weight': '600' },
        '.font-wordmark': { 'font-weight': '600' },
      });
    }),
  ],
};
