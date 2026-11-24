# NSW palette mapping

The maintained NSW styles use the colors from the QLD half of the same named
style. Readable, Mobile 2x and Mobile 3x are the sources; Readable Light and Hiking
Light are regenerated from them. Classic is unchanged. No layers or tile
requests are added, and the default style is unchanged.

| NSW feature | QLD color reference |
| --- | --- |
| Map background | Mainland's light tan |
| NPWS national parks | National Park fill and label ink |
| NPWS nature reserves | Nature Refuge fill |
| Other NPWS reserves | Conservation Area fill |
| State forests | State Forest fill and label ink |
| Built-up areas and buildings | Urban Area and Building Areas (Geoscape) |
| Lakes, dams, reservoirs and water areas | Lake (Large Scale) |
| River areas and waterways | Watercourse Areas and Watercourse (Large Scale) |
| Sea and bay areas | Seas |
| Shorelines | Shoreline |
| Major and intermediate/minor contours | Medium Scale index and intermediate contours |
| Contour labels and spot heights | Medium Scale contour label ink |
| Motorways and primary roads | Highway/Motorway surface and casing |
| Arterial and subarterial roads | Secondary road surface and casing |
| Distributor roads | Connector road surface and casing |
| Local roads and urban service lanes | Local road surface and casing |
| Paths, vehicle tracks, access ways, busways | Paths, Vehicular Track, Restricted, Busway |
| Railways | Corresponding operational, proposed or disused railway |
| Dams, breakwaters, wharves and ramps | Major Dam Wall and Marine Structures |
| Mountain names and symbols | Mountain ink; other landform classes stay distinct |
| Locality, road, water and park labels | Corresponding QLD label class |
| Label halos | QLD's warm off-white, with a separate contour halo |

Constant park and water fill opacities also match their QLD counterpart so the
visible tint matches over tan land. Existing opacity expressions, which control
zoom-dependent fading, remain unchanged. White bridge/track separation strokes
retain their purpose; they use the neutral local-road surface color rather than
being treated as another road category.

The prior layer survey observed NSW source tiles around Katoomba, Sydney,
Kosciuszko and Broken Hill. It confirmed the contour, road and landform symbol
classes used here; the source's sparse tile tree means display zoom and native
tile zoom can differ. This color pass does not change source resolution or
contour intervals, and does not assume a feature missing from those samples is
absent statewide.

There are deliberate limits to the match:

- NSW Crown land does not mean QLD national park or forest. Its existing fill
  remains distinct.
- NSW's DLS landform textures, including swamp, sand and mangrove patterns, are
  bitmap sprites. Their texture and embedded color remain unchanged.
- NSW does not expose all the same vegetation polygons as QLD. No forest cover
  or other geometry is invented to make the states look identical.
- NSW POI sprites and white/transparent icon components retain their meanings.
  Only safely comparable paint colors are changed.
- Unmatched cadastral, infrastructure and construction classes retain their
  existing NSW treatment.

`scripts/match-nsw-colors.js` applies this mapping without altering drawing
order, filters, geometry, zoom thresholds, line widths, label sizes or collision
rules. Its road role lookup uses the unchanged original `nsw.style.json` to
distinguish a white separator from a colored casing. Repeating the command is
idempotent. The output remains in the human-aligned style JSON format.
