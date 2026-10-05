import {
  ALWAYS_CONFIRM_OPS,
  CAPTION_STYLE_PRESETS,
  FEATURE_PACKS,
  VOICE_EFFECT_PRESETS,
  type BaseClipRef,
  type Clip,
  type ClipRef,
  type EditOp,
  type EditOpOf,
  type EditPlan,
  type ExportPreset,
  type Pack,
  type PointTime,
  type Project,
  type Time,
  type Track,
} from "@studio/shared";
import {
  clipDuration,
  clipEnd,
  clipLabel,
  fmtSec,
  projectDuration,
  round3,
  sortClips,
  timelineScenes,
  trackCodes,
  type MediaLookup,
} from "./summary.js";

/**
 * Sprint 3: resolve the ClipRef / Time of an EditPlan against the project (ids and seconds), write
 * one Spanish preview line per op and list risks. Ambiguity or missing data never guesses: it
 * becomes an `unresolved` Spanish question. The same `resolveOp` runs again inside agent.apply
 * against the CURRENT project (ops before it may have changed the timeline): resolved refs pass
 * through unchanged; a `{scene: n}` deferred because a previous op detects scenes is computed then.
 */

export interface ResolveContext {
  project: Project;
  media: MediaLookup;
  /** Playhead (Time "cursor"). */
  cursor?: number;
  presets: readonly Pick<ExportPreset, "id" | "name" | "container" | "width" | "height">[];
  /** Imported media for add_audio / backgrounds (default: the assets used by the project). */
  assets?: readonly NonNullable<ReturnType<MediaLookup>>[];
  /** Workers GET /packs (undefined = unknown: no pack risk). */
  packs?: readonly Pick<Pack, "id" | "name_es" | "size_bytes" | "installed">[];
}

export interface OpResolution {
  /** Resolved op (ClipRef -> {id}, Time -> seconds) or null when something is unresolved. */
  op: EditOp | null;
  preview_es: string;
  risks: string[];
  unresolved: string[];
}

export interface PlanResolution {
  resolved: (EditOp | null)[];
  preview_es: string[];
  risks: string[];
  unresolved: string[];
}

interface Located {
  clip: Clip;
  track: Track;
  code: string;
}

/** Thrown inside resolution helpers; collected as an unresolved question. */
class Unresolved extends Error {}

const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\.[a-z0-9]{2,4}$/i, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** 4 exact, 3 prefix, 2 substring, 1 every query word starts a label word, 0 no match. */
export function nameScore(label: string, query: string): number {
  const l = norm(label);
  const q = norm(query);
  if (!q || !l) return 0;
  if (l === q) return 4;
  if (l.startsWith(q)) return 3;
  if (l.includes(q)) return 2;
  const words = l.split(" ");
  return q.split(" ").every((w) => words.some((x) => x.startsWith(w))) ? 1 : 0;
}

function allClips(project: Project): Located[] {
  const codes = trackCodes(project);
  const order = new Map(project.tracks.map((t, i) => [t.id, i]));
  const out: Located[] = [];
  for (const track of project.tracks)
    for (const clip of sortClips(track.clips))
      out.push({ clip, track, code: codes.get(track.id)! });
  return out.sort(
    (a, b) => a.clip.start - b.clip.start || order.get(a.track.id)! - order.get(b.track.id)! || 0,
  );
}

const describe = (l: Located, media: MediaLookup) =>
  `«${clipLabel(l.clip, media)}» (${l.code}, ${fmtSec(l.clip.start)}–${fmtSec(clipEnd(l.clip))})`;

function question(what: string, list: Located[], media: MediaLookup): string {
  const shown = list.slice(0, 4).map((l, i) => `${i + 1}) ${describe(l, media)}`);
  const more = list.length > 4 ? ` y ${list.length - 4} más` : "";
  return `¿Qué clip querés usar ${what}? Hay ${list.length} posibles: ${shown.join(", ")}${more}.`;
}

export type ClipFilter = (l: Located, media: MediaLookup) => boolean;

const hasAudio: ClipFilter = (l, media) => {
  if (!l.clip.assetId || (l.track.kind !== "video" && l.track.kind !== "audio")) return false;
  const a = media(l.clip.assetId);
  return !!a && a.kind !== "image" && a.hasAudio !== false;
};
const isVideoMedia: ClipFilter = (l, media) =>
  l.track.kind === "video" && !!l.clip.assetId && media(l.clip.assetId)?.kind === "video";
const isVisualMedia: ClipFilter = (l, media) =>
  l.track.kind === "video" &&
  !!l.clip.assetId &&
  ["video", "image"].includes(media(l.clip.assetId)?.kind ?? "");

interface Ctx extends ResolveContext {
  /** Ops before this one in the plan (deferral of scene times). */
  earlier: readonly EditOp[];
}

function resolvePointOrTime(t: Time | PointTime, ctx: Ctx, what: string): number | Time {
  if (typeof t === "number") {
    if (!Number.isFinite(t) || t < 0) throw new Unresolved(`El momento ${what} no es válido.`);
    return round3(t);
  }
  if (t === "start") return 0;
  if (t === "end") return projectDuration(ctx.project);
  if (t === "cursor") {
    if (ctx.cursor === undefined)
      throw new Unresolved(`¿En qué segundo ${what}? No sé dónde está el cabezal.`);
    return round3(ctx.cursor);
  }
  if ("scene" in t) {
    const scenes = timelineScenes(ctx.project, ctx.media);
    const s = scenes[t.scene - 1];
    if (s !== undefined) return s;
    if (ctx.earlier.some((o) => o.op === "detect_scenes")) return { scene: t.scene }; // deferred
    throw new Unresolved(
      scenes.length === 0
        ? `No hay escenas detectadas para ubicar ${what} en la escena ${t.scene}. ¿Detecto las escenas primero?`
        : `El video tiene ${scenes.length} escenas; no existe la escena ${t.scene}. ¿Cuál querés?`,
    );
  }
  const ref = resolveClip(t.after_clip, ctx, { what: `como referencia (${what})` });
  return round3(clipEnd(ref.clip));
}

/** Time -> seconds (or a deferred `{scene}` Time when a previous op detects scenes). */
export function resolveTime(t: Time, ctx: Ctx, what: string): number | Time {
  return resolvePointOrTime(t, ctx, what);
}

function seconds(t: Time, ctx: Ctx, what: string): number {
  const v = resolveTime(t, ctx, what);
  if (typeof v !== "number")
    throw new Unresolved(`No puedo ubicar ${what} hasta detectar las escenas.`);
  return v;
}

interface ClipQuery {
  what: string;
  filter?: ClipFilter;
  /** Label of what the filter requires (Spanish), for "no encontré". */
  need?: string;
}

/** ClipRef -> one clip, or Unresolved with a question listing the candidates. */
export function resolveClip(ref: ClipRef | BaseClipRef, ctx: Ctx, q: ClipQuery): Located {
  const media = ctx.media;
  const clips = allClips(ctx.project);
  if (ref.id) {
    const hit = clips.find((l) => l.clip.id === ref.id);
    if (!hit) throw new Unresolved(`No encontré el clip con id «${ref.id}» ${q.what}.`);
    if (q.filter && !q.filter(hit, media))
      throw new Unresolved(
        `El clip ${describe(hit, media)} no sirve ${q.what}${q.need ? `: ${q.need}` : ""}.`,
      );
    return hit;
  }
  let list = clips.filter((l) => !q.filter || q.filter(l, media));
  if (ref.track) list = list.filter((l) => l.track.kind === ref.track);
  if (ref.name) {
    const scored = list.map((l) => ({
      l,
      s: Math.max(
        nameScore(clipLabel(l.clip, media), ref.name!),
        nameScore(l.track.name, ref.name!) >= 4 ? 1 : 0,
      ),
    }));
    const best = Math.max(0, ...scored.map((x) => x.s));
    list = best > 0 ? scored.filter((x) => x.s === best).map((x) => x.l) : [];
    if (list.length === 0) {
      const any = clips.filter((l) => nameScore(clipLabel(l.clip, media), ref.name!) > 0);
      if (any.length === 1 && q.filter)
        throw new Unresolved(
          `El clip ${describe(any[0]!, media)} no sirve ${q.what}${q.need ? `: ${q.need}` : ""}.`,
        );
      throw new Unresolved(`No encontré un clip llamado «${ref.name}» ${q.what}. ¿Cuál es?`);
    }
  }
  if (ref.at !== undefined) {
    const t = resolvePointOrTime(ref.at, ctx, q.what);
    if (typeof t !== "number")
      throw new Unresolved(`No puedo ubicar el clip ${q.what} hasta detectar las escenas.`);
    const inside = list.filter((l) => l.clip.start <= t + 1e-3 && t < clipEnd(l.clip) - 1e-3);
    // Without a track kind, a video clip wins over overlays at the same instant.
    const video = inside.filter((l) => l.track.kind === "video");
    list = !ref.track && video.length > 0 && video.length < inside.length ? video : inside;
    if (list.length === 0)
      throw new Unresolved(`No hay ningún clip en ${fmtSec(t)} ${q.what}. ¿Cuál es?`);
  }
  if (ref.index !== undefined) {
    const i = ref.index > 0 ? ref.index - 1 : list.length + ref.index;
    const hit = list[i];
    if (!hit)
      throw new Unresolved(
        `Hay ${list.length} clip${list.length === 1 ? "" : "s"} ${ref.track ? `de ${ref.track} ` : ""}y pediste el número ${ref.index} ${q.what}. ¿Cuál es?`,
      );
    return hit;
  }
  if (list.length === 1) return list[0]!;
  if (list.length === 0)
    throw new Unresolved(
      `No encontré ningún clip ${q.what}${q.need ? ` (${q.need})` : ""}. ¿Cuál es?`,
    );
  throw new Unresolved(question(q.what, list, media));
}

/** Clips used when an optional ClipRef is omitted: media clips of the first track kind that has any. */
function defaultClips(ctx: Ctx, filter: ClipFilter): Located[] {
  const list = allClips(ctx.project).filter((l) => filter(l, ctx.media));
  const video = list.filter((l) => l.track.kind === "video");
  return video.length ? video : list;
}

const ref = (l: Located): ClipRef => ({ id: l.clip.id });

function packRisk(ctx: ResolveContext, packId: string): string | undefined {
  const pack = ctx.packs?.find((p) => p.id === packId);
  if (!pack || pack.installed) return undefined;
  const gb = (pack.size_bytes / 1e9).toFixed(2).replace(".", ",");
  return `Falta el paquete de IA «${pack.name_es}» (${gb} GB): hay que descargarlo antes (Ajustes → Paquetes).`;
}

const LONG_OP_SEC = 60;

function presetFor(ctx: ResolveContext, id: string) {
  const exact = ctx.presets.find((p) => p.id === id);
  if (exact) return exact;
  const scored = ctx.presets
    .map((p) => ({ p, s: Math.max(nameScore(p.id, id), nameScore(p.name, id)) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);
  if (scored.length === 1 || (scored.length > 1 && scored[0]!.s > scored[1]!.s))
    return scored[0]!.p;
  return undefined;
}

type Out = { op: EditOp; preview: string; risks: string[] };

function resolveInner(op: EditOp, ctx: Ctx): Out {
  const media = ctx.media;
  const risks: string[] = [];
  const label = (l: Located) => `«${clipLabel(l.clip, media)}»`;
  const many = (list: Located[]) =>
    list.length === 1 ? label(list[0]!) : `${list.length} clips (${list.map(label).join(", ")})`;
  const longIf = (sec: number, what: string) => {
    if (sec > LONG_OP_SEC)
      risks.push(`Operación larga: ${what} de ${fmtSec(sec)} puede tardar varios minutos.`);
  };
  const totalDur = (list: Located[]) => list.reduce((s, l) => s + clipDuration(l.clip), 0);
  const optionalClips = (
    clip: ClipRef | undefined,
    filter: ClipFilter,
    what: string,
    need: string,
  ) => {
    if (clip) return [resolveClip(clip, ctx, { what, filter, need })];
    const list = defaultClips(ctx, filter);
    if (list.length === 0)
      throw new Unresolved(`No hay ningún clip ${need} ${what}. ¿Importo uno?`);
    return list;
  };

  switch (op.op) {
    case "cut_silences": {
      const list = optionalClips(op.clip, hasAudio, "para cortar silencios", "con audio");
      longIf(totalDur(list), "cortar silencios");
      const opts = [
        `≥ ${op.min_silence_ms ?? 500} ms`,
        `margen ${op.padding_ms ?? 120} ms`,
        op.fillers === false ? "sin muletillas" : "con muletillas",
      ];
      const out = { ...op, ...(op.clip && { clip: ref(list[0]!) }) };
      return { op: out, preview: `Cortar silencios (${opts.join(", ")}) en ${many(list)}`, risks };
    }
    case "detect_scenes": {
      const list = optionalClips(op.clip, isVideoMedia, "para detectar escenas", "de video");
      const r = packRisk(ctx, FEATURE_PACKS.scenes);
      if (r) risks.push(r);
      const out = { ...op, ...(op.clip && { clip: ref(list[0]!) }) };
      return {
        op: out,
        preview: `Detectar escenas en ${many(list)}${op.split ? " y dividir en cada cambio" : ""}`,
        risks,
      };
    }
    case "split": {
      const l = resolveClip(op.clip, ctx, { what: "para dividir" });
      const t = seconds(op.t, ctx, "del corte");
      if (t <= l.clip.start + 0.04 || t >= clipEnd(l.clip) - 0.04)
        throw new Unresolved(
          `El corte en ${fmtSec(t)} cae fuera de ${describe(l, media)}. ¿En qué segundo lo divido?`,
        );
      if (l.track.locked) risks.push(`La pista «${l.track.name}» está bloqueada: va a fallar.`);
      return {
        op: { ...op, clip: ref(l), t },
        preview: `Dividir ${label(l)} en ${fmtSec(t)}`,
        risks,
      };
    }
    case "trim": {
      const l = resolveClip(op.clip, ctx, { what: "para recortar" });
      if (op.in === undefined && op.out === undefined)
        throw new Unresolved(`¿Dónde empieza y dónde termina ${label(l)} después del recorte?`);
      const tin = op.in !== undefined ? seconds(op.in, ctx, "del nuevo inicio") : undefined;
      const tout = op.out !== undefined ? seconds(op.out, ctx, "del nuevo final") : undefined;
      const a = tin ?? l.clip.start;
      const b = tout ?? clipEnd(l.clip);
      if (b - a < 0.04)
        throw new Unresolved(
          `El recorte deja ${label(l)} sin duración (${fmtSec(a)}–${fmtSec(b)}).`,
        );
      const speed = l.clip.speed || 1;
      if (l.clip.assetId && l.clip.in + (a - l.clip.start) * speed < -1e-3)
        throw new Unresolved(`${label(l)} no tiene material antes de ${fmtSec(l.clip.start)}.`);
      const parts = [
        tin !== undefined && `inicio ${fmtSec(tin)}`,
        tout !== undefined && `final ${fmtSec(tout)}`,
      ].filter(Boolean);
      return {
        op: {
          ...op,
          clip: ref(l),
          ...(tin !== undefined && { in: tin }),
          ...(tout !== undefined && { out: tout }),
        },
        preview: `Recortar ${label(l)}: ${parts.join(", ")}`,
        risks,
      };
    }
    case "delete_clip": {
      const l = resolveClip(op.clip, ctx, { what: "para borrar" });
      risks.push(`Borra el clip ${describe(l, media)} (se puede deshacer con «Deshacer todo»).`);
      return { op: { ...op, clip: ref(l), confirm: true }, preview: `Borrar ${label(l)}`, risks };
    }
    case "set_speed": {
      const l = resolveClip(op.clip, ctx, { what: "para cambiar la velocidad" });
      const dur = clipDuration(l.clip) * ((l.clip.speed || 1) / op.speed);
      return {
        op: { ...op, clip: ref(l) },
        preview: `Velocidad x${op.speed} en ${label(l)} (dura ${fmtSec(dur)})`,
        risks,
      };
    }
    case "add_text": {
      const t = seconds(op.t, ctx, "del texto");
      const dur = op.duration_s ?? 3;
      const pos = { top: "arriba", center: "al centro", bottom: "abajo" }[op.position ?? "bottom"];
      return {
        op: { ...op, t },
        preview: `Agregar texto «${op.text.slice(0, 60)}» en ${fmtSec(t)} durante ${fmtSec(dur)} (${pos})`,
        risks,
      };
    }
    case "add_motion": {
      const t = resolveTime(op.t, ctx, "del gráfico");
      let follow = op.follow;
      if (follow && follow !== "face") follow = ref(resolveClip(follow, ctx, { what: "a seguir" }));
      if (follow === "face")
        risks.push(
          "Seguir la cara: se agrega fijo si el clip no tiene seguimiento (Seguir objeto).",
        );
      return {
        op: { ...op, t: t as Time, ...(follow && { follow }) },
        preview: `Agregar motion «${op.template}» en ${typeof t === "number" ? fmtSec(t) : "la escena indicada"}${
          op.duration_s ? ` durante ${fmtSec(op.duration_s)}` : ""
        }`,
        risks,
      };
    }
    case "add_captions": {
      const list = optionalClips(op.clip, hasAudio, "para los subtítulos", "con voz");
      const style = CAPTION_STYLE_PRESETS.find((s) => s.id === (op.style ?? "clasico"));
      const needsTranscript = !list.every((l) =>
        ctx.project.subtitles.some((s) => s.end > l.clip.start && s.start < clipEnd(l.clip)),
      );
      if (needsTranscript) longIf(totalDur(list), "transcribir");
      return {
        op: { ...op, ...(op.clip && { clip: ref(list[0]!) }) },
        preview: `Subtítulos${op.animated ? " animados" : ""} estilo «${style?.name ?? op.style}» en ${many(list)}${
          needsTranscript ? " (transcribe primero)" : ""
        }`,
        risks,
      };
    }
    case "transcribe": {
      const list = optionalClips(op.clip, hasAudio, "para transcribir", "con voz");
      longIf(totalDur(list), "transcribir");
      if (ctx.project.subtitles.length)
        risks.push("Reemplaza los subtítulos existentes en el tramo de los clips transcriptos.");
      return {
        op: { ...op, ...(op.clip && { clip: ref(list[0]!) }) },
        preview: `Transcribir ${many(list)}`,
        risks,
      };
    }
    case "tts": {
      const t = seconds(op.t, ctx, "de la voz");
      const fx = op.effect ? VOICE_EFFECT_PRESETS.find((p) => p.id === op.effect)?.name : undefined;
      return {
        op: { ...op, t },
        preview: `Voz «${op.text.slice(0, 50)}» en ${fmtSec(t)}${op.voice ? ` (${op.voice})` : ""}${fx ? ` con efecto ${fx}` : ""}`,
        risks,
      };
    }
    case "voice_effect": {
      const l = resolveClip(op.clip, ctx, {
        what: "para el efecto de voz",
        filter: hasAudio,
        need: "con audio",
      });
      const fx = VOICE_EFFECT_PRESETS.find((p) => p.id === op.effect);
      return {
        op: { ...op, clip: ref(l) },
        preview: `Efecto de voz «${fx?.name ?? op.effect}» en ${label(l)}`,
        risks,
      };
    }
    case "denoise": {
      const l = resolveClip(op.clip, ctx, {
        what: "para limpiar la voz",
        filter: hasAudio,
        need: "con audio",
      });
      const r = packRisk(ctx, FEATURE_PACKS.denoise);
      if (r) risks.push(r);
      longIf(clipDuration(l.clip), "limpiar la voz");
      return { op: { ...op, clip: ref(l) }, preview: `Limpiar la voz de ${label(l)}`, risks };
    }
    case "add_audio": {
      const t = seconds(op.t, ctx, "del audio");
      let asset = op.asset;
      if (asset && !asset.id && asset.name) {
        const hits = allAssets(ctx)
          .map((a) => ({ a, s: nameScore(a.name, asset!.name!) }))
          .filter((x) => x.s > 0)
          .sort((x, y) => y.s - x.s);
        if (hits.length && (hits.length === 1 || hits[0]!.s > hits[1]!.s))
          asset = { id: hits[0]!.a.id, name: hits[0]!.a.name };
        else if (!op.query)
          throw new Unresolved(`No encontré un audio llamado «${asset.name}». ¿Cuál es?`);
        else asset = undefined;
      } else if (asset?.id && !ctx.media(asset.id))
        throw new Unresolved(`No encontré el archivo con id «${asset.id}».`);
      if (!asset && !op.query)
        throw new Unresolved("¿Qué audio agrego? Decime el nombre o qué buscar.");
      const what = asset
        ? `«${asset.name ?? ctx.media(asset.id!)?.name ?? asset.id}»`
        : `la búsqueda «${op.query}»`;
      const vol = op.volume_db !== undefined ? ` a ${op.volume_db} dB` : "";
      return {
        op: { ...op, t, ...(asset && { asset }) },
        preview: `Agregar audio ${what} en ${fmtSec(t)}${vol}${op.duck ? " (bajo la voz)" : ""}`,
        risks,
      };
    }
    case "remove_background": {
      const l = resolveClip(op.clip, ctx, {
        what: "para quitar el fondo",
        filter: isVisualMedia,
        need: "de video o imagen",
      });
      const image = ctx.media(l.clip.assetId!)?.kind === "image";
      const r = packRisk(ctx, image ? FEATURE_PACKS.mattingImage : FEATURE_PACKS.matting);
      if (r) risks.push(r);
      if (!image)
        risks.push(`Operación larga: recortar a la persona de ${label(l)} procesa todo el video.`);
      let background = op.background;
      if ((background.type === "image" || background.type === "video") && background.value) {
        const want = background.type;
        const hit = allAssets(ctx)
          .filter((a) => a.kind === want)
          .map((a) => ({
            a,
            s: a.id === background.value ? 5 : nameScore(a.name, background.value!),
          }))
          .filter((x) => x.s > 0)
          .sort((x, y) => y.s - x.s)[0];
        if (!hit)
          throw new Unresolved(
            `No encontré la ${want === "image" ? "imagen" : "video"} «${background.value}» para el fondo.`,
          );
        background = { type: want, value: hit.a.id };
      } else if (background.type === "image" || background.type === "video")
        throw new Unresolved(
          `¿Qué ${background.type === "image" ? "imagen" : "video"} va de fondo?`,
        );
      const bg = {
        color: `color ${background.value ?? "#00ff00"}`,
        image: "imagen",
        video: "video",
        blur: "desenfocado",
      }[background.type];
      return {
        op: { ...op, clip: ref(l), background },
        preview: `Quitar el fondo de ${label(l)} (fondo ${bg})`,
        risks,
      };
    }
    case "reframe": {
      const subject = op.subject ?? "face";
      if (subject === "face") {
        const r = packRisk(ctx, FEATURE_PACKS.reframe);
        if (r) risks.push(r);
        risks.push(
          `Operación larga: analiza las caras de todo el video (${fmtSec(projectDuration(ctx.project))}).`,
        );
      }
      if (!allClips(ctx.project).some((l) => isVideoMedia(l, media)))
        throw new Unresolved("No hay ningún clip de video para reencuadrar.");
      return {
        op,
        preview: `Reencuadrar a ${op.target} siguiendo ${subject === "face" ? "la cara" : "el centro"}`,
        risks,
      };
    }
    case "set_canvas": {
      const size = canvasSize(ctx.project, op.preset);
      if (size.w !== ctx.project.settings.width && size.h !== ctx.project.settings.height)
        risks.push("Cambia la orientación del lienzo: revisá la posición de textos y gráficos.");
      return { op, preview: `Lienzo ${size.w}×${size.h}`, risks };
    }
    case "set_publish": {
      const flags = Object.entries(op.flags ?? {})
        .filter(([, v]) => v)
        .map(
          ([k]) =>
            ({
              ai_face: "cara IA",
              ai_voice: "voz IA",
              ai_other: "otra IA",
              music: "música",
              third_party: "terceros",
            })[k] ?? k,
        );
      return {
        op,
        preview: `Revisión para redes: ${op.for_social ? "para redes" : "uso interno"}${
          flags.length ? ` (${flags.join(", ")})` : ""
        }${op.ai_label !== undefined ? `, etiqueta IA ${op.ai_label ? "sí" : "no"}` : ""}`,
        risks,
      };
    }
    case "export": {
      const preset = presetFor(ctx, op.preset);
      if (!preset)
        throw new Unresolved(
          `No conozco el preset «${op.preset}». ¿Cuál uso? (${ctx.presets.map((p) => p.id).join(", ")})`,
        );
      risks.push(
        `Exporta un archivo nuevo en exports/ con «${preset.name}» (nunca sobrescribe: le agrega fecha y hora).`,
      );
      longIf(projectDuration(ctx.project), "exportar un video");
      return {
        op: { ...op, preset: preset.id, confirm: true },
        preview: `Exportar con «${preset.name}» (${preset.width}×${preset.height}, ${preset.container})${
          op.name ? ` como «${op.name}»` : ""
        }`,
        risks,
      };
    }
    case "report_bug":
      return { op, preview: `Redactar reporte de error «${op.title.slice(0, 60)}»`, risks };
  }
}

function allAssets(ctx: ResolveContext) {
  if (ctx.assets) return [...ctx.assets];
  const seen = new Map<string, NonNullable<ReturnType<MediaLookup>>>();
  for (const t of ctx.project.tracks)
    for (const c of t.clips) {
      const a = c.assetId ? ctx.media(c.assetId) : undefined;
      if (a) seen.set(a.id, a);
    }
  return [...seen.values()];
}

/** Library assets beyond the project ones are looked up by the caller (agent.apply). */
export function canvasSize(
  project: Pick<Project, "settings">,
  preset: EditOpOf<"set_canvas">["preset"],
): { w: number; h: number } {
  if (typeof preset === "object") return { w: preset.w, h: preset.h };
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  const long = Math.max(project.settings.width, project.settings.height);
  const short = Math.min(project.settings.width, project.settings.height);
  if (preset === "16:9") return { w: long, h: even((long * 9) / 16) };
  if (preset === "9:16") return { w: even((long * 9) / 16), h: long };
  return { w: short, h: short };
}

/** Resolve one op (also used by agent.apply on the current project). */
export function resolveOp(
  op: EditOp,
  ctx: ResolveContext,
  earlier: readonly EditOp[] = [],
): OpResolution {
  try {
    const out = resolveInner(op, { ...ctx, earlier });
    const resolved = ALWAYS_CONFIRM_OPS.includes(out.op.op) ? { ...out.op, confirm: true } : out.op;
    return { op: resolved, preview_es: out.preview, risks: out.risks, unresolved: [] };
  } catch (err) {
    if (!(err instanceof Unresolved)) throw err;
    return {
      op: null,
      preview_es: `${opTitle(op)}: falta un dato`,
      risks: [],
      unresolved: [err.message],
    };
  }
}

const TITLES: Record<EditOp["op"], string> = {
  cut_silences: "Cortar silencios",
  detect_scenes: "Detectar escenas",
  split: "Dividir clip",
  trim: "Recortar clip",
  delete_clip: "Borrar clip",
  set_speed: "Cambiar velocidad",
  add_text: "Agregar texto",
  add_motion: "Agregar motion",
  add_captions: "Agregar subtítulos",
  transcribe: "Transcribir",
  tts: "Texto a voz",
  voice_effect: "Efecto de voz",
  denoise: "Limpiar voz",
  add_audio: "Agregar audio",
  remove_background: "Quitar fondo",
  reframe: "Reencuadrar",
  set_canvas: "Cambiar lienzo",
  set_publish: "Revisión para redes",
  export: "Exportar",
  report_bug: "Reportar error",
};

export const opTitle = (op: Pick<EditOp, "op">) => TITLES[op.op] ?? op.op;

/** Resolve every op of a plan against the project (the API answer of POST /api/agent/plan). */
export function resolvePlan(plan: EditPlan, ctx: ResolveContext): PlanResolution {
  const out: PlanResolution = { resolved: [], preview_es: [], risks: [], unresolved: [] };
  plan.ops.forEach((op, i) => {
    const r = resolveOp(op, ctx, plan.ops.slice(0, i));
    out.resolved.push(r.op);
    out.preview_es.push(r.preview_es);
    for (const risk of r.risks) if (!out.risks.includes(risk)) out.risks.push(risk);
    for (const q of r.unresolved) out.unresolved.push(`Operación ${i + 1}: ${q}`);
  });
  return out;
}
