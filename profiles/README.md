# Bundled profile files

Approved live profiles can be committed here as `<id>.json`. They become defaults in the next image. Files in `/data/profiles` take precedence and are never overwritten by an image update. Classic is protected and cannot be replaced by a profile file.

Use `node scripts/profiles.js export <id> <output>` in the running container to export its complete QLD and NSW styles. Validate with `node scripts/profiles.js validate <file>` before committing. The same file can be synced live with `node scripts/profiles.js sync <file>`; the filename is determined by its `id`.
