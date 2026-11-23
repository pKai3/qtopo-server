# Live map styles

This branch (`codex/live-styles`) records the map styles used by Tower's Latest
server. Pushes here do not trigger the Docker release workflow. Application code
and image releases are maintained separately on `master`.

- `style.json` and `nsw.style.json`: the original live QLD and NSW styles.
- `readable.json`: desktop Readable, with darker terrain and tan open land.
- `mobile-2x.json` and `mobile-3x.json`: mobile variants with earlier fine contours,
  readable elevation labels and later small city detail.
- `base.style.json`, `style.mobile.json` and `profiles.json`: the older generator's
  source, output and settings, retained for reference.

Named variants contain both states. Their `id` determines their existing tile
URL. Sync a selected file using the server's `scripts/profiles.js sync` command;
committing or pushing it alone does not deploy it. The server keeps original and named styles together under `/data/styles`.

JSON uses two-space indentation, aligned short columns and one complete layer per
row. Drawing order is significant. The formatter preserves values and key order.
The original QLD/NSW files were captured from the live server; the three named
variants match the validated terrain revision activated on 23 November 2026.

The follow-up contour label revision enlarges QLD elevation labels by another
25%: Readable 12.5 px, Mobile 2x 20 px and Mobile 3x 27.5 px. Linework and zoom
thresholds are unchanged.

Light choices: `readable-light.json` uses desktop sizing and `mobile-light.json`
uses Mobile 3x sizing. They omit buildings, utilities, parcel detail and minor
urban POIs. Contours, tracks, water, road hierarchy, locality names, outdoor
landmarks and emergency/transit navigation features are retained. The detailed
Readable and Mobile files stay available and are the source of truth.

Run `node scripts/build-light-styles.js` after editing the detailed styles to
regenerate both light choices. This changes style files only; it does not build
or deploy a container. The default source remains Classic.
