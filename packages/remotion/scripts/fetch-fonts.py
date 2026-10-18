"""Download and freeze the bundled OFL fonts (Sprint 6 M2, decision 9: no render uses the network).

Run once by a maintainer (NOT at install/render time); the output is committed to the repo:

    python -m venv .ft && .ft/bin/pip install fonttools==4.* brotli
    .ft/bin/python packages/remotion/scripts/fetch-fonts.py

Source: github.com/google/fonts (raw files, every family is OFL — see each OFL.txt). Variable
fonts are instanced to static 400/700/900 TTFs (fontTools.varLib.instancer) and subset to Latin +
Latin Extended (Spanish, Portuguese, punctuation, currency, arrows) to keep the bundle small.
Every face gets name ID 1 = the family, so libass (fontsdir) matches `Fontname: <Family>` and picks
the weight from OS/2 usWeightClass. Single-weight display families keep one file; manifest.json maps
the three weights to the files available (browsers then never synthesize a fake bold).
"""

from __future__ import annotations

import io
import json
import sys
import urllib.request
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

RAW = "https://raw.githubusercontent.com/google/fonts/main/ofl"
OUT = Path(__file__).resolve().parents[1] / "public" / "fonts"
WEIGHTS = (400, 700, 900)
WEIGHT_NAMES = {400: "Regular", 700: "Bold", 900: "Black"}

# family -> (google/fonts folder, variable file or {weight: static file})
FAMILIES: dict[str, tuple[str, str | dict[int, str]]] = {
    "Inter": ("inter", "Inter[opsz,wght].ttf"),
    "Montserrat": ("montserrat", "Montserrat[wght].ttf"),
    "Poppins": (
        "poppins",
        {400: "Poppins-Regular.ttf", 700: "Poppins-Bold.ttf", 900: "Poppins-Black.ttf"},
    ),
    "Roboto": ("roboto", "Roboto[wdth,wght].ttf"),
    "Oswald": ("oswald", "Oswald[wght].ttf"),
    "Playfair Display": ("playfairdisplay", "PlayfairDisplay[wght].ttf"),
    "Bebas Neue": ("bebasneue", {400: "BebasNeue-Regular.ttf"}),
    "Anton": ("anton", {400: "Anton-Regular.ttf"}),
    "Archivo Black": ("archivoblack", {400: "ArchivoBlack-Regular.ttf"}),
    "Bangers": ("bangers", {400: "Bangers-Regular.ttf"}),
}

# Basic Latin, Latin-1, Latin Extended-A/B, general punctuation, currency, arrows, math basics.
UNICODES = (
    list(range(0x20, 0x7F))
    + list(range(0xA0, 0x250))
    + list(range(0x2000, 0x2070))
    + list(range(0x20A0, 0x20C1))
    + [0x2122, 0x2190, 0x2191, 0x2192, 0x2193, 0x2212, 0x2215, 0x25CF, 0xFEFF, 0xFFFD]
)


def fetch(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=60) as r:  # noqa: S310 (fixed https host)
        return r.read()


def file_stem(family: str) -> str:
    return family.replace(" ", "")


def axis_range(font: TTFont, tag: str) -> tuple[float, float, float] | None:
    if "fvar" not in font:
        return None
    for a in font["fvar"].axes:
        if a.axisTag == tag:
            return a.minValue, a.defaultValue, a.maxValue
    return None


def set_names(font: TTFont, family: str, weight: int) -> None:
    style = WEIGHT_NAMES[weight]
    name = font["name"]
    for rec in list(name.names):
        if rec.nameID in (16, 17, 21, 22, 25):
            name.removeNames(nameID=rec.nameID)
    for pid, eid, lid in ((3, 1, 0x409), (1, 0, 0)):
        name.setName(family, 1, pid, eid, lid)
        name.setName(style, 2, pid, eid, lid)
        name.setName(f"{family} {style}", 4, pid, eid, lid)
        name.setName(f"{file_stem(family)}-{style}", 6, pid, eid, lid)
    font["OS/2"].usWeightClass = weight
    # Regular/Bold flags for RIBBI-aware apps; Black is just a heavier weight of the family.
    fs = font["OS/2"].fsSelection & ~0b1100001
    font["OS/2"].fsSelection = fs | (0b100000 if weight == 700 else 0b1000000 if weight == 400 else 0)
    font["head"].macStyle = 1 if weight >= 700 else 0


def subset_font(font: TTFont) -> TTFont:
    opts = subset.Options()
    opts.layout_features = ["*"]
    opts.name_IDs = ["*"]
    opts.name_languages = ["*"]
    opts.notdef_outline = True
    opts.hinting = False
    opts.drop_tables += ["DSIG"]
    sub = subset.Subsetter(opts)
    sub.populate(unicodes=UNICODES)
    sub.subset(font)
    return font


def save(font: TTFont, dest: Path) -> int:
    buf = io.BytesIO()
    font.save(buf)
    dest.write_bytes(buf.getvalue())
    return len(buf.getvalue())


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    manifest: dict[str, dict[str, object]] = {}
    total = 0
    for family, (folder, source) in FAMILIES.items():
        fam_dir = OUT / family
        fam_dir.mkdir(exist_ok=True)
        (fam_dir / "OFL.txt").write_bytes(fetch(f"{RAW}/{folder}/OFL.txt"))
        files: dict[int, str] = {}
        if isinstance(source, str):
            var = fetch(f"{RAW}/{folder}/{urllib.parse.quote(source)}")
            for w in WEIGHTS:
                font = TTFont(io.BytesIO(var))
                rng = axis_range(font, "wght")
                assert rng, f"{family}: no wght axis"
                wv = min(max(w, rng[0]), rng[2])
                limits: dict[str, float] = {"wght": wv}
                for extra in ("opsz", "wdth"):
                    r = axis_range(font, extra)
                    if r:
                        limits[extra] = r[1]
                real = int(wv)
                if real in files:
                    files[w] = files[real]
                    continue
                static = instancer.instantiateVariableFont(font, limits, updateFontNames=False)
                set_names(static, family, real)
                subset_font(static)
                fname = f"{file_stem(family)}-{real}.ttf"
                total += save(static, fam_dir / fname)
                files[real] = fname
                files[w] = fname
        else:
            for w, src in source.items():
                font = TTFont(io.BytesIO(fetch(f"{RAW}/{folder}/{src}")))
                set_names(font, family, w)
                subset_font(font)
                fname = f"{file_stem(family)}-{w}.ttf"
                total += save(font, fam_dir / fname)
                files[w] = fname
            for w in WEIGHTS:
                if w not in files:
                    files[w] = files[max(k for k in source if k <= w)]
        manifest[family] = {
            "dir": family,
            "license": "OFL-1.1",
            "source": f"github.com/google/fonts/tree/main/ofl/{folder}",
            "weights": {str(w): files[w] for w in WEIGHTS},
        }
        print(f"{family}: {sorted(set(files.values()))}")
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"total {total / 1e6:.2f} MB")
    return 0


if __name__ == "__main__":
    import urllib.parse  # noqa: F401  (used above)

    sys.exit(main())
