# BIGREEL redesign — "The Manifest" (design direction)

Subject: BIGREEL as a freight broker for files. Title in → manifest of items out.
Audience knows quality/size jargon. Page's single job: title in, working file link out.

## Information model (rename throughout UI)
- servers → **carriers** (Elite, Naija Plus, Prime, Index, Swift, Nexus, …)
- sources → **items**: class (quality), weight (size), carrier, clearance
- direct link → **DIRECT** (stamp, red) · locked → **HOLD** (stamp, ochre)
- jargon banned: "locked", "provider", "source" never appear to users

## Tokens
Color:
- paper #F4F2EA (page bg)
- bar   #E3EBD9 (green-bar row stripes)
- ink   #1A211B (text, rules)
- stamp #C2401F (DIRECT marks, primary buttons)
- hold  #A06A12 (HOLD marks)
- mute  #5A6157 (secondary text, perforations)

Type:
- Display: Anton (condensed poster caps; masthead, titles, stamped words)
- Data: IBM Plex Mono (filenames, sizes, quality, status — carries the most meaning)
- Body: IBM Plex Sans (helper copy only)

## Signature
Green-bar continuous-stationery listing: mono columns on bar-striped paper,
tractor-feed holes on the left margin, statuses as rubber stamps
(DIRECT −2° rotation, HOLD flat), "END OF MANIFEST" footer with perforation.

## Motion (single orchestrated moment)
Rows print in top-to-bottom on load (30ms stagger, 4px rise, like a line
printer). Stamps: single scale-in. prefers-reduced-motion: disable both.

## Copy voice — freight-plain
- "12 items on this manifest."
- HOLD: "Held at host — open in a browser to clear."
- Empty: "No items matched this title. Try the original-language title."
- Buttons: Download (direct) / Open at host (held). Per-row: Copy link.

## Functional upgrades
1. Flat item view across carriers, sortable (size, quality), filters in URL
2. Copy-link per row (download-manager audience)
3. Honest states: loading = "Printing manifest…", carrier failures named
4. Mobile: rows fold to two lines (name+size / stamp+button)

## Pages
- Home: masthead, search ("file a request"), 3-step sequence, carriers table
- /find?q= and /dl/* results: title block, filter toolbar, manifest listing
- Search page: folded into home (search IS the page)

## Rejected alternatives (do not drift back)
- Dark "projection booth" amber — too close to generic dark default
- Card-grid media wall — every stream site already does this

## Self-critique checklist before shipping
- Not cream+terracotta-serif default (no serif display; stamp red ≠ terracotta)
- Green-bar listing encodes real data, not decoration
- Boldness spent in one place (listing); rest quiet
- Focus states visible on paper bg; contrast ≥ 4.5:1 for body text
