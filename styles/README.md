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
committing or pushing it alone does not deploy it. The server keeps original and
named styles together under `/data/styles`. Live files override bundled defaults;
image updates never overwrite them. Upgrading moves files from the former
`/data/profiles` default automatically. An explicit custom `PROFILE_DIR` is still
honoured.

JSON uses two-space indentation, aligned short columns and one complete layer per
row. Drawing order is significant. The formatter preserves values and key order.
Use `node scripts/format-styles.js --check` to check the layout, or omit `--check`
to format local files. Export, sync and generation use this layout automatically.
The original QLD/NSW files were captured from the live server; the three named
variants match the validated terrain revision activated on 23 November 2026.

The follow-up contour label revision enlarges QLD elevation labels by another
25%: Readable 12.5 px, Mobile 2x 20 px and Mobile 3x 27.5 px. Linework and zoom
thresholds are unchanged.

Line-following text now uses a `text-max-angle` limit of 20 degrees, with 30
degrees for contour elevations, across Classic, detailed and light styles in
both states. This limits changes in direction between characters, rather than
specifying a radius in metres. Unsuitable placements are skipped. QLD contour
label spacing is capped at 400 style pixels to offer more placement opportunities
on gentler sections; existing closer spacing is preserved. Font sizes, halos,
road-label spacing and all contour linework and zoom thresholds are unchanged.
The change was compared in native raster renders around Government House and
Birdwood Terrace at z16 using Hiking Light's mobile sizing.

Light choices: `readable-light.json` uses desktop sizing and `mobile-light.json`
uses Mobile 3x sizing. They omit buildings, utilities, parcel detail and minor
urban POIs. Contours, tracks, water, road hierarchy, locality names, outdoor
landmarks and emergency/transit navigation features are retained. The detailed
Readable and Mobile files stay available and are the source of truth.

Run `node scripts/build-light-styles.js` after editing the detailed styles to
regenerate both light choices. This changes style files only; it does not build
or deploy a container. The default source remains Classic.

Preview the light choices on Latest:

- [Readable Light](https://topo-latest.csinger.com/?profile=readable-light&mode=raster)
- [Hiking Light](https://topo-latest.csinger.com/?profile=mobile-light&mode=raster)

Gaia tile templates:

```
https://topo-latest.csinger.com/readable-light/{z}/{x}/{y}.png
https://topo-latest.csinger.com/mobile-light/{z}/{x}/{y}.png
```

In controlled warm-resource samples on Tower, Hiking Light reduced rendering
plus PNG encoding time by about 28% in Brisbane CBD at z16 and 47% in Sydney at
z16. Terrain-only Mt Barney samples at z16/z17 were essentially unchanged: the
contours remain. These are sample render timings, not a promise about network or
Gaia performance. The separate lossless PNG encoder improvement benefits both
light and detailed variants.

Mountain names and elevations are 25% larger in every QLD choice. The NSW
MountainLike class receives the same increase without resizing other landforms.
Ferry icons and names in the named QLD styles switch to valid z17 point data
from z17 upward. The upstream z18+ ferry records contain an unsupported empty
symbol value that native symbol rendering drops even with its filter removed.
The icon and name share a symbol to prevent self-collision. Two combined rules
(one below z17, one above) and one capped source keep those landmarks visible while
all other layers, including 1 m contours, retain their existing source resolution.
Verified with native previews at West End z18, UQ St Lucia z19 and Guyatt Park z17.

Fine 1 m contours are unlabelled in all five named styles. The 5 m/index
contours retain elevation labels, including at z17 for phone downloads.

NSW colors in Readable, Mobile 2x, Mobile 3x and their Light derivatives now use
the corresponding QLD palette. Open land is tan, water blue, protected land
muted green, contours brown, and road colors follow the same hierarchy. These
edits preserve NSW geometry, feature classes, layer order, zoom thresholds,
line widths and label placement. Classic remains unchanged.

Run `node scripts/match-nsw-colors.js` to repeat the semantic color matching after
editing a detailed QLD palette; it also regenerates both Light styles. It only
writes the five named style files. See [NSW palette mapping](NSW-palette.md) for
the layer mapping and the cases that intentionally retain their NSW treatment.

NSW paved roads use the corresponding QLD width curves at twice their weight,
independently of label sizing, to distinguish streets from parcel boundaries.
Local roads remain narrower than connectors, secondary roads and
highways. The same continuous curve spans NSW's zoom-specific layer switches,
removing the sudden increase at z16. In Mobile at z16, local-road outer widths
are about 8.8 style pixels and highway widths about 18.6, instead of 52 for both.
The first correction (4.4 and 9.3 pixels) was too thin in the phone comparison.
Tunnel edges meet the running surface, and bridge outlines stay outside their
separation strokes. Service lanes stay narrower than local roads. NSW paths,
vehicle tracks and access ways retain their widths from before the road-width
correction, including their bridge and tunnel strokes. The road-width recipe
does not resize trails. Dash patterns, colors, labels, source detail and Classic
are unchanged.

Run `node scripts/match-nsw-road-widths.js` after changing the maintained QLD
road widths. It updates Readable, Mobile 2x and Mobile 3x and regenerates both
Light choices. Repeating it does not compound sizing. Sync the five named style
files to apply the correction; no application image or server restart is needed.

Town, village, suburb and general-locality names disappear at z15 in all five
named styles, in both states. Their settlement dots disappear with them where
those dots are separate layers. Street and landmark names, including historic
sites that share NSW's PlacePoint source, retain their existing zoom ranges.
`node scripts/limit-place-label-zoom.js` reapplies that limit and rebuilds the
Light choices. Labels whose minimum zoom is already 15 have an empty display
range deliberately; retaining their definitions makes the limit easy to revise.
