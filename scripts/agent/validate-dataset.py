"""Validate the local edit-agent dataset (Sprint 3, Fase D).

Checks every example of
  apps/workers/studio_workers/agent/dataset/{train,golden}.jsonl
  apps/workers/studio_workers/agent/prompts/fewshot_es.jsonl
against the EditPlan JSON Schema exported from packages/shared/src/agent.ts, plus the rules the
schema cannot express (refinements, ids that must exist in the example's project_summary, catalog
ids read from packages/shared / packages/remotion, golden coverage). Prints stats per op and per tag
and exits 1 when there is any error.

Usage:
  apps/workers/.venv/Scripts/python scripts/agent/validate-dataset.py          (Windows)
  apps/workers/.venv/bin/python scripts/agent/validate-dataset.py [--schema P] [--quiet]

Needs `jsonschema` (uv pip install jsonschema).
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import unicodedata
from collections import Counter
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
AGENT_DIR = ROOT / "apps/workers/studio_workers/agent"
DATASET_DIR = AGENT_DIR / "dataset"
PROMPTS_DIR = AGENT_DIR / "prompts"
SHARED = ROOT / "packages/shared/src"
REMOTION_SCHEMAS = ROOT / "packages/remotion/src/schemas"
PIPER_CATALOG = ROOT / "apps/workers/studio_workers/tts/piper_catalog.py"
SCHEMA_CANDIDATES = [
    AGENT_DIR / "editplan.schema.json",
    ROOT / "packages/shared/schemas/editplan.schema.json",
]

TRACK_KINDS = {"video", "audio", "text", "motion"}
ALWAYS_CONFIRM = {"delete_clip", "export"}
TIME_FIELDS = ("t", "in", "out")
GOLDEN_SIZE = 50
TRAIN_MIN = 200
FEWSHOT_SIZE = 8
GOLDEN_MIN_TAGS = {"ambiguo": 8, "multi_op": 5, "typo": 5, "fuera_de_alcance": 5}
TIME_FORMS = {"number", "start", "end", "cursor", "scene", "after_clip"}
REF_FORMS = {"id", "name", "index", "track", "at"}
SUMMARY_MAX = 160


# ---------- catalog ids parsed from the TS / Python sources ----------


def _read(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except OSError:
        return ""


def ts_const_array(text: str, name: str) -> list[str]:
    """Strings of `export const NAME = [ ... ] as const` (or without `as const`)."""
    m = re.search(
        rf"const\s+{re.escape(name)}\s*(?::[^=]+)?=\s*\[(.*?)\]", text, re.DOTALL
    )
    return re.findall(r'"([^"]+)"', m.group(1)) if m else []


def ts_block_ids(text: str, name: str) -> list[str]:
    """`id: "..."` entries inside `export const NAME ... = [ ... ];`."""
    m = re.search(
        rf"const\s+{re.escape(name)}\b.*?=\s*\[(.*?)\n\s*\];", text, re.DOTALL
    )
    return re.findall(r'\bid:\s*"([^"]+)"', m.group(1)) if m else []


def load_catalog() -> dict[str, set[str]]:
    agent = _read(SHARED / "agent.ts")
    motion = _read(SHARED / "motion.ts")
    export = _read(SHARED / "export.ts")
    voice = _read(SHARED / "voice.ts")
    vision = _read(SHARED / "vision.ts")
    subtitles = _read(SHARED / "subtitles.ts")
    cat = {
        "templates": set(ts_const_array(motion, "REMOTION_TEMPLATE_IDS")),
        "caption_styles": set(ts_const_array(subtitles, "CAPTION_STYLE_IDS"))
        or set(ts_const_array(agent, "CAPTION_STYLE_IDS")),
        "voice_effects": set(ts_block_ids(voice, "VOICE_EFFECT_PRESETS")),
        "agent_voice_effects": set(ts_const_array(agent, "VOICE_EFFECT_IDS")),
        "presets": set(ts_block_ids(export, "DEFAULT_EXPORT_PRESETS"))
        | set(ts_block_ids(export, "EXTRA_EXPORT_PRESETS")),
        "agent_presets": set(ts_const_array(agent, "AGENT_KNOWN_PRESET_IDS")),
        "track_aware": set(ts_const_array(vision, "TRACK_AWARE_TEMPLATES")),
        "voices": set(re.findall(r'CatalogVoice\(\s*"([^"]+)"', _read(PIPER_CATALOG))),
    }
    return cat


def load_template_props() -> dict[str, dict[str, set[str] | None]]:
    """{template: {prop: allowed enum values | None}} from packages/remotion/src/schemas."""
    out: dict[str, dict[str, set[str] | None]] = {}
    for path in sorted(REMOTION_SCHEMAS.glob("*.ts")):
        if path.stem in ("index", "common"):
            continue
        text = _read(path)
        consts = {
            m.group(1): set(re.findall(r'"([^"]+)"', m.group(2)))
            for m in re.finditer(r"export const (\w+)\s*=\s*\[(.*?)\]", text, re.DOTALL)
        }
        camel = re.sub(r"-(\w)", lambda m: m.group(1).upper(), path.stem) + "Schema"
        body = re.search(
            rf"const\s+{camel}\s*=\s*z\s*\.object\(\{{(.*?)\n\}}\)", text, re.DOTALL
        )
        if not body:
            continue
        props: dict[str, set[str] | None] = {}
        for m in re.finditer(r"^  (\w+):\s*(.*)$", body.group(1), re.MULTILINE):
            key, rest = m.group(1), m.group(2)
            enum: set[str] | None = None
            inline = re.match(r"z\s*\.enum\(\[(.*?)\]\)", rest)
            named = re.match(r"z\s*\.enum\((\w+)\)", rest)
            if inline:
                enum = set(re.findall(r'"([^"]+)"', inline.group(1)))
            elif named and named.group(1) in consts:
                enum = consts[named.group(1)]
            props[key] = enum
        if "...trackProps" in body.group(1):
            props.update({"track": None, "trackAnchor": None, "trackOffset": None})
        out[path.stem] = props
    return out


# ---------- helpers ----------


def norm(s: str) -> str:
    s = unicodedata.normalize("NFKD", s.lower())
    return "".join(c for c in s if not unicodedata.combining(c))


def all_clips(ps: dict) -> list[dict]:
    out = []
    for track in ps.get("tracks", []):
        for c in track.get("clips", []):
            out.append({**c, "kind": track.get("kind")})
    return out


def duration(ps: dict) -> float:
    return max((c["end"] for c in all_clips(ps)), default=0.0)


class Ctx:
    def __init__(self, ps: dict, errors: list[str], where: str):
        self.ps = ps
        self.errors = errors
        self.where = where
        self.clips = all_clips(ps)
        self.dur = duration(ps)

    def err(self, msg: str) -> None:
        self.errors.append(f"{self.where}: {msg}")

    def time(self, t: Any, field: str) -> float | None:
        """Resolve a Time to seconds (None if it cannot be resolved)."""
        if isinstance(t, bool):
            self.err(f"{field}: Time booleano")
            return None
        if isinstance(t, (int, float)):
            if t > self.dur + 1e-6 and self.clips:
                self.err(f"{field}: {t}s supera la duración del proyecto ({self.dur}s)")
            return float(t)
        if t == "start":
            return 0.0
        if t == "end":
            return self.dur
        if t == "cursor":
            return float(self.ps.get("cursor_s", 0.0))
        if isinstance(t, dict) and "scene" in t:
            scenes = {s["n"]: s["start"] for s in self.ps.get("scenes", [])}
            if t["scene"] not in scenes:
                self.err(
                    f"{field}: la escena {t['scene']} no está en project_summary.scenes"
                )
                return None
            return float(scenes[t["scene"]])
        if isinstance(t, dict) and "after_clip" in t:
            c = self.clip(t["after_clip"], f"{field}.after_clip")
            return float(c["end"]) if c else None
        self.err(f"{field}: Time desconocido {t!r}")
        return None

    def clip(self, ref: dict, field: str) -> dict | None:
        """Resolve a ClipRef against the summary; it must match exactly one clip."""
        cands = list(self.clips)
        if "id" in ref:
            cands = [c for c in cands if c["id"] == ref["id"]]
            if not cands:
                self.err(f"{field}: id {ref['id']!r} no existe en project_summary")
                return None
        if "track" in ref:
            if ref["track"] not in {c["kind"] for c in self.clips}:
                self.err(f"{field}: no hay pistas de tipo {ref['track']!r}")
                return None
            cands = [c for c in cands if c["kind"] == ref["track"]]
        if "name" in ref:
            n = norm(ref["name"])
            cands = [c for c in cands if n in norm(c["name"])]
            if not cands:
                self.err(f"{field}: ningún clip se llama como {ref['name']!r}")
                return None
        if "at" in ref:
            at = self.time(ref["at"], f"{field}.at")
            if at is None:
                return None
            cands = [c for c in cands if c["start"] - 1e-6 <= at < c["end"]]
        if "index" in ref:
            idx = ref["index"]
            if idx == 0:
                self.err(f"{field}: index 0 (empieza en 1 o -1)")
                return None
            cands.sort(key=lambda c: (c["start"], c["id"]))
            if abs(idx) > len(cands):
                self.err(
                    f"{field}: index {idx} fuera de rango ({len(cands)} candidatos)"
                )
                return None
            cands = [cands[idx - 1 if idx > 0 else idx]]
        if len(cands) != 1:
            names = ", ".join(c["name"] for c in cands) or "ninguno"
            self.err(
                f"{field}: ClipRef {ref} resuelve a {len(cands)} clips ({names}); usar questions"
            )
            return None
        return cands[0]

    def asset_name(self, name: str, field: str) -> None:
        names = [a["name"] for a in self.ps.get("assets", [])]
        if not any(norm(name) in norm(a) for a in names):
            self.err(f"{field}: {name!r} no está en project_summary.assets")


# ---------- per-example checks ----------


def check_summary_shape(ps: Any, err) -> bool:
    if not isinstance(ps, dict):
        err("project_summary no es un objeto")
        return False
    ok = True
    canvas = ps.get("canvas")
    if not (isinstance(canvas, dict) and {"w", "h"} <= canvas.keys()):
        err("project_summary.canvas debe tener w y h")
        ok = False
    if not isinstance(ps.get("cursor_s"), (int, float)):
        err("project_summary.cursor_s falta o no es número")
        ok = False
    tracks = ps.get("tracks")
    if not isinstance(tracks, list):
        err("project_summary.tracks debe ser una lista")
        return False
    seen: set[str] = set()
    for i, tr in enumerate(tracks):
        if tr.get("kind") not in TRACK_KINDS:
            err(f"tracks[{i}].kind inválido: {tr.get('kind')!r}")
            ok = False
        for c in tr.get("clips", []):
            if (
                not ({"id", "name", "start", "end"} <= c.keys())
                or c["end"] <= c["start"]
            ):
                err(f"tracks[{i}] clip mal formado: {c}")
                ok = False
            elif c["id"] in seen:
                err(f"clip id duplicado {c['id']}")
                ok = False
            seen.add(c["id"])
    allowed = {"canvas", "cursor_s", "tracks", "scenes", "assets", "transcript_excerpt"}
    extra = set(ps) - allowed
    if extra:
        err(f"project_summary con campos no previstos: {sorted(extra)}")
    return ok


def check_op(op: dict, i: int, ctx: Ctx, cat: dict, tprops: dict) -> None:
    f = f"ops[{i}]"
    name = op.get("op")
    if name in ALWAYS_CONFIRM and op.get("confirm") is not True:
        ctx.err(f"{f}: {name} debe llevar confirm: true")
    if op.get("confirm") is False:
        ctx.err(f"{f}: confirm false no se usa en el dataset")
    times: dict[str, float | None] = {}
    for k in TIME_FIELDS:
        if k in op:
            times[k] = ctx.time(op[k], f"{f}.{k}")
    clip = (
        ctx.clip(op["clip"], f"{f}.clip") if isinstance(op.get("clip"), dict) else None
    )

    t_split = times.get("t")
    if (
        name == "split"
        and clip
        and t_split is not None
        and not clip["start"] < t_split < clip["end"]
    ):
        ctx.err(f"{f}: el corte {t_split} no cae dentro de {clip['name']}")
    if name == "trim":
        if "in" not in op and "out" not in op:
            ctx.err(f"{f}: trim sin in ni out")
        if clip:
            for k in ("in", "out"):
                v = times.get(k)
                if (
                    v is not None
                    and not clip["start"] - 1e-6 <= v <= clip["end"] + 1e-6
                ):
                    ctx.err(
                        f"{f}.{k}: {v} fuera de {clip['name']} [{clip['start']}, {clip['end']}]"
                    )
        if (
            times.get("in") is not None
            and times.get("out") is not None
            and times["in"] >= times["out"]
        ):
            ctx.err(f"{f}: in >= out")
    if name == "add_motion":
        tpl = op.get("template")
        if tpl not in cat["templates"]:
            ctx.err(f"{f}.template {tpl!r} no está en REMOTION_TEMPLATE_IDS")
        props = tprops.get(tpl, {})
        for k, v in (op.get("params") or {}).items():
            if props and k not in props:
                ctx.err(f"{f}.params.{k}: no es un parámetro de {tpl}")
            elif props.get(k) and v not in props[k]:
                ctx.err(f"{f}.params.{k}={v!r}: valores válidos {sorted(props[k])}")
        follow = op.get("follow")
        if follow is not None:
            if tpl not in cat["track_aware"]:
                ctx.err(
                    f"{f}.follow: {tpl} no sigue objetos (solo {sorted(cat['track_aware'])})"
                )
            if isinstance(follow, dict):
                ctx.clip(follow, f"{f}.follow")
    if (
        name == "add_captions"
        and "style" in op
        and op["style"] not in cat["caption_styles"]
    ):
        ctx.err(f"{f}.style {op['style']!r} no está en CAPTION_STYLE_IDS")
    effect = op.get("effect") if name in ("tts", "voice_effect") else None
    if effect is not None and (
        effect not in cat["voice_effects"]
        or (cat["agent_voice_effects"] and effect not in cat["agent_voice_effects"])
    ):
        ctx.err(
            f"{f}.effect {effect!r} no está en VOICE_EFFECT_PRESETS/VOICE_EFFECT_IDS"
        )
    if name == "tts" and "voice" in op and op["voice"] not in cat["voices"]:
        ctx.err(f"{f}.voice {op['voice']!r} no está en el catálogo Piper")
    if name == "export" and op.get("preset") not in cat["presets"]:
        ctx.err(f"{f}.preset {op.get('preset')!r} no es un preset de export.ts")
    if name == "add_audio":
        if "query" not in op and "asset" not in op:
            ctx.err(f"{f}: add_audio necesita query o asset")
        asset = op.get("asset") or {}
        if "name" in asset:
            ctx.asset_name(asset["name"], f"{f}.asset.name")
        if "id" in asset and asset["id"] not in {
            a["id"] for a in ctx.ps.get("assets", [])
        }:
            ctx.err(f"{f}.asset.id {asset['id']!r} no existe")
    if name == "remove_background":
        bg = op.get("background", {})
        if bg.get("type") in ("image", "video"):
            if not bg.get("value"):
                ctx.err(f"{f}.background: {bg.get('type')} sin value")
            else:
                ctx.asset_name(bg["value"], f"{f}.background.value")
        if bg.get("type") == "color" and not re.fullmatch(
            r"#[0-9a-fA-F]{6}", bg.get("value", "")
        ):
            ctx.err(f"{f}.background.value debe ser #rrggbb")


def check_example(
    ex: Any,
    where: str,
    validator,
    cat: dict,
    tprops: dict,
    errors: list[str],
    needs_meta: bool,
) -> None:
    def err(msg: str) -> None:
        errors.append(f"{where}: {msg}")

    if not isinstance(ex, dict):
        err("la línea no es un objeto JSON")
        return
    keys = (
        {"id", "command", "project_summary", "plan", "tags"}
        if needs_meta
        else {"command", "project_summary", "plan"}
    )
    missing = keys - ex.keys()
    if missing:
        err(f"faltan campos {sorted(missing)}")
        return
    if not isinstance(ex["command"], str) or not ex["command"].strip():
        err("command vacío")
    plan = ex["plan"]
    for e in sorted(validator.iter_errors(plan), key=lambda e: list(e.absolute_path)):
        path = "/".join(str(p) for p in e.absolute_path) or "(raíz)"
        err(f"schema {path}: {e.message[:200]}")
    if not isinstance(plan, dict):
        return
    ops = plan.get("ops") or []
    qs = plan.get("questions") or []
    if not ops and not qs:
        err("plan sin ops ni questions")
    summary = plan.get("summary_es", "")
    if "\n" in summary or len(summary) > SUMMARY_MAX:
        err(f"summary_es debe ser una línea de ≤ {SUMMARY_MAX} caracteres")
    if not check_summary_shape(ex["project_summary"], err):
        return
    ctx = Ctx(ex["project_summary"], errors, where)
    for i, op in enumerate(ops):
        if isinstance(op, dict):
            check_op(op, i, ctx, cat, tprops)
    if needs_meta:
        tags = ex["tags"]
        if not isinstance(tags, list) or not all(isinstance(t, str) for t in tags):
            err("tags debe ser una lista de strings")
        elif not ops and not ({"ambiguo", "fuera_de_alcance"} & set(tags)):
            err("plan solo con questions sin tag 'ambiguo' o 'fuera_de_alcance'")
        elif "fuera_de_alcance" in tags and ops:
            err("fuera_de_alcance debe tener ops vacío")


# ---------- coverage / stats ----------


def time_form(t: Any) -> str:
    if isinstance(t, (int, float)) and not isinstance(t, bool):
        return "number"
    if isinstance(t, str):
        return t
    if isinstance(t, dict):
        return next(iter(t), "?")
    return "?"


def forms(plan: dict) -> tuple[set[str], set[str]]:
    """(time forms, ClipRef fields) used anywhere in the plan."""
    tf: set[str] = set()
    rf: set[str] = set()

    def ref(r: Any) -> None:
        if not isinstance(r, dict):
            return
        rf.update(k for k in r if k in REF_FORMS)
        if "at" in r:
            time(r["at"])

    def time(t: Any) -> None:
        tf.add(time_form(t))
        if isinstance(t, dict) and "after_clip" in t:
            ref(t["after_clip"])

    for op in plan.get("ops", []):
        ref(op.get("clip"))
        ref(op.get("follow"))
        for k in TIME_FIELDS:
            if k in op:
                time(op[k])
    return tf, rf


def load_jsonl(path: Path, errors: list[str]) -> list[tuple[str, Any]]:
    rows = []
    if not path.exists():
        errors.append(f"{path.relative_to(ROOT)}: no existe")
        return rows
    for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        where = f"{path.name}:{n}"
        try:
            rows.append((where, json.loads(line)))
        except json.JSONDecodeError as e:
            errors.append(f"{where}: JSON inválido ({e})")
    return rows


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument(
        "--schema", type=Path, help="EditPlan JSON Schema (default: el exportado)"
    )
    ap.add_argument("--quiet", action="store_true", help="solo errores y resultado")
    args = ap.parse_args()

    try:
        from jsonschema import Draft202012Validator
    except ImportError:
        print(
            "Falta jsonschema: uv pip install --python apps/workers/.venv jsonschema",
            file=sys.stderr,
        )
        return 2
    schema_path = args.schema or next(
        (p for p in SCHEMA_CANDIDATES if p.exists()), None
    )
    if not schema_path or not schema_path.exists():
        print(
            "No encuentro editplan.schema.json; corré `pnpm --filter @studio/shared export-schemas`.",
            file=sys.stderr,
        )
        return 2
    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    Draft202012Validator.check_schema(schema)
    validator = Draft202012Validator(schema)

    errors: list[str] = []
    cat = load_catalog()
    for key in (
        "templates",
        "caption_styles",
        "voice_effects",
        "presets",
        "voices",
        "track_aware",
    ):
        if not cat[key]:
            errors.append(f"catálogo vacío: {key} (¿cambió el código fuente?)")
    if cat["agent_presets"] and not cat["agent_presets"] <= cat["presets"]:
        errors.append(
            f"AGENT_KNOWN_PRESET_IDS con ids que no están en export.ts: "
            f"{sorted(cat['agent_presets'] - cat['presets'])}"
        )
    tprops = load_template_props()
    missing_t = cat["templates"] - tprops.keys()
    if missing_t:
        print(f"aviso: sin esquema de props para {sorted(missing_t)}", file=sys.stderr)

    files = {
        "train": DATASET_DIR / "train.jsonl",
        "golden": DATASET_DIR / "golden.jsonl",
        "fewshot": PROMPTS_DIR / "fewshot_es.jsonl",
    }
    data = {k: load_jsonl(p, errors) for k, p in files.items()}
    ids: Counter[str] = Counter()
    commands: dict[str, str] = {}
    for split, rows in data.items():
        for where, ex in rows:
            check_example(
                ex, where, validator, cat, tprops, errors, needs_meta=split != "fewshot"
            )
            if not isinstance(ex, dict):
                continue
            if split != "fewshot":
                ids[ex.get("id", "")] += 1
            key = norm(" ".join(str(ex.get("command", "")).split()))
            if key in commands:
                errors.append(f"{where}: comando repetido (ya está en {commands[key]})")
            commands.setdefault(key, where)
    for i, n in ids.items():
        if n > 1:
            errors.append(f"id repetido: {i} ({n} veces)")

    # sizes and golden coverage
    n_train, n_golden, n_few = (len(data[k]) for k in ("train", "golden", "fewshot"))
    if n_train < TRAIN_MIN:
        errors.append(f"train.jsonl tiene {n_train} ejemplos (mínimo {TRAIN_MIN})")
    if n_golden != GOLDEN_SIZE:
        errors.append(
            f"golden.jsonl tiene {n_golden} ejemplos (deben ser {GOLDEN_SIZE})"
        )
    if n_few != FEWSHOT_SIZE:
        errors.append(
            f"fewshot_es.jsonl tiene {n_few} pares (deben ser {FEWSHOT_SIZE})"
        )

    op_names = set(schema_op_names(schema))
    stats: dict[str, Counter[str]] = {}
    for split in ("train", "golden"):
        ops_c: Counter[str] = Counter()
        tags_c: Counter[str] = Counter()
        tf_all: set[str] = set()
        rf_all: set[str] = set()
        for _, ex in data[split]:
            if not isinstance(ex, dict) or not isinstance(ex.get("plan"), dict):
                continue
            for op in ex["plan"].get("ops", []):
                ops_c[op.get("op", "?")] += 1
            tags_c.update(ex.get("tags", []))
            tf, rf = forms(ex["plan"])
            tf_all |= tf
            rf_all |= rf
        stats[split + ".ops"] = ops_c
        stats[split + ".tags"] = tags_c
        need = 2 if split == "golden" else 1
        for name in sorted(op_names):
            if ops_c[name] < need:
                errors.append(
                    f"{split}: la op {name} aparece {ops_c[name]} veces (mínimo {need})"
                )
        if TIME_FORMS - tf_all:
            errors.append(
                f"{split}: faltan formas de Time {sorted(TIME_FORMS - tf_all)}"
            )
        if REF_FORMS - rf_all:
            errors.append(
                f"{split}: faltan formas de ClipRef {sorted(REF_FORMS - rf_all)}"
            )
    for tag, n in GOLDEN_MIN_TAGS.items():
        if stats["golden.tags"][tag] < n:
            errors.append(
                f"golden: tag {tag} = {stats['golden.tags'][tag]} (mínimo {n})"
            )

    # system prompt mentions every op and every caption/effect id it relies on
    system = _read(PROMPTS_DIR / "system_es.md")
    if not system:
        errors.append("prompts/system_es.md no existe")
    else:
        for name in sorted(op_names):
            if name not in system:
                errors.append(f"system_es.md no menciona la op {name}")

    if not args.quiet:
        print(f"schema: {schema_path}")
        print(f"ejemplos: train={n_train} golden={n_golden} fewshot={n_few}")
        for split in ("train", "golden"):
            ops_line = ", ".join(
                f"{k}={v}" for k, v in sorted(stats[split + ".ops"].items())
            )
            print(f"\n[{split}] ops por tipo: {ops_line}")
            tags = stats[split + ".tags"]
            plain = sorted((k, v) for k, v in tags.items() if ":" not in k)
            forms_ = sorted(
                (k, v) for k, v in tags.items() if ":" in k and not k.startswith("op:")
            )
            print(f"[{split}] tags: " + ", ".join(f"{k}={v}" for k, v in plain))
            print(f"[{split}] formas: " + ", ".join(f"{k}={v}" for k, v in forms_))
    if errors:
        print(f"\n{len(errors)} error(es):", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        return 1
    print("\nOK: dataset válido.")
    return 0


def schema_op_names(schema: dict) -> list[str]:
    """Every `op` const in the JSON Schema (the discriminator of EditOp)."""
    names: list[str] = []

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            props = node.get("properties")
            if isinstance(props, dict) and isinstance(props.get("op"), dict):
                op = props["op"]
                target = op
                if "$ref" in op:
                    target = resolve(schema, op["$ref"])
                if "const" in target:
                    names.append(target["const"])
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)

    walk(schema)
    return sorted(set(names))


def resolve(schema: dict, ref: str) -> dict:
    node: Any = schema
    for part in ref.lstrip("#/").split("/"):
        node = node[part]
    return node


if __name__ == "__main__":
    sys.exit(main())
