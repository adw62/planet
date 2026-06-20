Background music tracks.

Drop .mp3 files here — they're cycled as a quiet bed under the SFX.

The app loads `tracks.json` (a list of filenames). This manifest is REQUIRED
on static hosts like GitHub Pages, which don't serve directory listings.
(On a local `python -m http.server` it can fall back to the directory listing,
so the manifest is optional there.)

Whenever you add / remove / rename tracks, regenerate the manifest:

    cd sound
    ls *.mp3 | python3 -c "import sys,json;print(json.dumps([l.strip() for l in sys.stdin]))" > tracks.json

Then commit tracks.json alongside the mp3s.
