/**
 * MomentLens — tailwind.config.js
 * NativeWind v4 (Tailwind CSS v3 engine). Lives in apps/mobile/.
 *
 * Source of truth for every color and type token in the app.
 * Per Engineering_Handbook_V3.md §15 / CLAUDE.md §15: NEVER hardcode a hex
 * value or a raw px font size in a component. Reference these tokens instead
 * — `bg-background`, `text-textPrimary`, `font-h1 text-h1`, etc. — so dark
 * mode and any future palette tweak happen in exactly one place.
 *
 * Colors resolve through CSS variables defined in ./global.css so that a
 * single `.dark` class flips every token at once (see the wiring notes at
 * the bottom of this file). Do not replace the `rgb(var(...) / <alpha-value>)`
 * pattern with plain hex strings — that's what makes `bg-accent/20` etc. work.
 *
 * Font weight is NOT set via a `font-weight` utility. Each role token in
 * `fontFamily` points at a specific loaded font FILE (e.g. Inter_600SemiBold),
 * because React Native does not synthesize weights for custom fonts the way
 * the web does. Always pair a `font-*` class with a `text-*` class from the
 * same role, e.g. className="font-h1 text-h1".
 */

/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: "class", // toggled explicitly via nativewind's colorScheme API —
                      // required because Settings > Appearance offers
                      // Light / Dark / System Default (spec §4.19), not just
                      // "follow the OS."
  content: [
    "./app/**/*.{js,jsx,ts,tsx}",
    "./components/**/*.{js,jsx,ts,tsx}",
  ],
  presets: [require("nativewind/preset")],
  theme: {
    extend: {
      colors: {
        // --- Base surfaces ---
        background: "rgb(var(--color-background) / <alpha-value>)",   // page background
        surface: "rgb(var(--color-surface) / <alpha-value>)",         // cards, sheets, modals
        surfaceMuted: "rgb(var(--color-surfaceMuted) / <alpha-value>)", // thumbnails, input tracks, recessed fills

        // --- Text ---
        textPrimary: "rgb(var(--color-textPrimary) / <alpha-value>)",     // headings, body copy
        textSecondary: "rgb(var(--color-textSecondary) / <alpha-value>)", // secondary text, subtitles
        textMuted: "rgb(var(--color-textMuted) / <alpha-value>)",         // captions, placeholders — large text only, borderline contrast at small sizes

        // --- Borders ---
        border: "rgb(var(--color-border) / <alpha-value>)",             // default 1px borders
        borderStrong: "rgb(var(--color-borderStrong) / <alpha-value>)", // input borders, card outlines

        // --- Accent (gold) ---
        accent: "rgb(var(--color-accent) / <alpha-value>)",                 // button fills, icons, focus rings, slider handles
        accentPressed: "rgb(var(--color-accentPressed) / <alpha-value>)",   // pressed/active state of the above
        accentTint: "rgb(var(--color-accentTint) / <alpha-value>)",         // subtle badge/highlight backgrounds
        accentText: "rgb(var(--color-accentText) / <alpha-value>)",         // gold used AS TEXT — do not substitute `accent` here, contrast differs by mode

        // --- Semantic ---
        danger: "rgb(var(--color-danger) / <alpha-value>)",         // destructive actions (Delete event)
        dangerTint: "rgb(var(--color-dangerTint) / <alpha-value>)", // destructive row/banner backgrounds
        success: "rgb(var(--color-success) / <alpha-value>)",       // confirmations, success states
      },

      fontFamily: {
        // Low-level family tokens — reach for these only when a role token
        // below doesn't fit.
        "fraunces-medium": ["Fraunces_500Medium"],
        "inter-regular": ["Inter_400Regular"],
        "inter-medium": ["Inter_500Medium"],
        "inter-semibold": ["Inter_600SemiBold"],

        // Role tokens — matches the type scale 1:1. Pair with the fontSize
        // token of the same name.
        display: ["Fraunces_500Medium"],       // Display (splash, rare)
        h1: ["Fraunces_500Medium"],            // H1 / Screen title
        h2: ["Inter_600SemiBold"],             // H2 / Section header
        body: ["Inter_400Regular"],            // Body (default)
        bodySecondary: ["Inter_400Regular"],   // Body secondary/muted
        buttonLabel: ["Inter_600SemiBold"],    // Button label
        fieldLabel: ["Inter_500Medium"],       // Field label
        caption: ["Inter_400Regular"],         // Caption / timestamp
        micro: ["Inter_600SemiBold"],          // Micro / badge
      },

      fontSize: {
        // Line-height is not finalized yet — left at the RN/font default.
        // Add it here as [size, { lineHeight: '...' }] once decided; don't
        // guess a number into this file.
        display: "32px",
        h1: "24px",
        h2: "18px",
        body: "15px",
        bodySecondary: "14px",
        buttonLabel: "15px",
        fieldLabel: "13px",
        caption: "12px",
        micro: "11px",
      },
    },
  },
  plugins: [],
};
