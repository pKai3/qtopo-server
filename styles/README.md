# Map styles

All map appearance files live here. `style.json` and `nsw.style.json` are the
original standalone styles used by Classic. Named files such as `mobile-3x.json`
contain a complete QLD/NSW pair plus a profile ID and display name; that ID selects
the URL. The older `profiles.json` contains settings for `generate_styles.js`.

On the server the equivalent folder is `/data/styles`. Live files take precedence
over bundled defaults and image updates never overwrite edits. Upgrading moves
files and history from the former `/data/profiles` default automatically. Existing
files in `styles` win any conflict; the older copy is retained in `styles/history`.
An explicit custom `PROFILE_DIR` is still honoured.

Use `node scripts/profiles.js export <id> <output>` to export a named profile and
`node scripts/profiles.js sync <file>` to validate and install it without a restart.
Classic remains protected from named-profile overrides.

JSON uses two-space indentation, aligned short columns and one complete layer per
row. `node scripts/format-styles.js` formats this folder; pass filenames to format
other exports, or `--check` to check without writing. Export, sync and generation
use this layout automatically. Values, key order and drawing order are preserved.

Live cartography revisions are maintained on `codex/live-styles`. Pushes to that
branch do not trigger the Docker release workflow. Application releases remain
on `master`; style changes can be synced independently.
