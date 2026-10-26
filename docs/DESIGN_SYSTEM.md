# ContextFlow visual system

ContextFlow is one reading product across the website, Chrome extension and
desktop companion: warm paper, ink-like text and a restrained burnt-orange accent.
The desktop is a companion to reading, not a separate green dashboard brand.

## One source of truth

`src/core/design-tokens.js` defines colour, typography, radii, focus and shadow
tokens. Injected Shadow UI consumes that module directly. Static pages consume
generated CSS blocks in their existing stylesheets, without runtime scripts,
remote fonts or new requests.
Native startup background and website `theme-color` metadata are generated from
the same paper token, so the window cannot briefly show a different canvas.

After changing a token:

```sh
npm run design:sync
npm run design:check
npm run test:design
```

Never hand-edit a generated block. Extension, website and desktop builds reject
stale blocks. Use `--cf-*` tokens in components rather than creating another local
palette. Desktop form overrides should change density and placement only.

## Semantic rules

| Role | Use |
| --- | --- |
| Paper / raised paper / sunk | Canvas, cards and recessed regions |
| Ink / ink-soft / quote | Primary, secondary and supporting text |
| Accent / accent-hover / on-accent | Primary actions, current navigation and interaction |
| Ok / ok-soft / ok-line | Successful checks and verified results, not general branding |
| Bad / warning families | Errors, risks and unsaved changes |
| Focus-line / focus-ring | Visible keyboard and input focus |
| Sans / serif / mono | Controls and body UI / reading-oriented headings and quotes / paths and code |

Choosing a note location is not a successful write. An unconfirmed card stays
neutral; a confirmed location has a warm accent wash; green is reserved for
verified writing. Disabled controls remain visibly disabled; busy controls also
communicate progress. Colour never replaces the existing textual status.

## Tone and platform policy

- Website and desktop use deliberate light paper. Desktop Shadow settings are
  explicitly light too, including when the OS is dark.
- Extension standalone pages follow the OS using the same warm-charcoal palette.
- Injected reading UI follows the web page's actual canvas, with OS appearance
  only as a fallback. A white page stays light even on a dark OS.
- Marketing pages, compact reading panels and desktop settings use different
  densities. Matching the brand does not require matching every layout or size.
- Native window chrome, Dock and menu-bar icons keep platform conventions.

## Verification

`test/design-tokens.test.mjs` checks generation parity, token coverage and AA text
contrast. Existing theme tests guard page-driven appearance.

```sh
CONTEXTFLOW_DESKTOP_LAYOUT=1 node --test test/desktop-layout.test.mjs
CONTEXTFLOW_PLAYWRIGHT_DIR=/path/to/runtime/node_modules node test/extension-load-browser.test.mjs
npm run build:website
CONTEXTFLOW_PLAYWRIGHT_DIR=/path/to/runtime/node_modules node test/desktop-site-browser.test.mjs
```

These use isolated fixtures/profiles. Desktop checks include real computed
styles in the shell and Shadow settings, OS light/dark, keyboard focus, reduced
motion, narrow windows and 200% zoom. Inspect the generated screenshots as well;
passing a layout assertion alone is not a visual review.

Source validation does not update an installed desktop app or an already
submitted Chrome package. New visuals must be packaged under a new release;
never replace a frozen same-version ZIP or DMG to make it appear updated.
