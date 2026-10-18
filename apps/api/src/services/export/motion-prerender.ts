import type { Clip, Job, Project } from "@studio/shared";
import type { AppContext } from "../../context.js";
import { JobAbortedError } from "../../jobs/state.js";
import { clipDuration } from "../ffmpeg/timeline.js";

const EPS = 1e-6;

/**
 * Sprint 6 (integration, M2 cross request 1): motion clips the export renders by itself instead of
 * blocking — clips on a visible motion track with a spec and no usable render (`renderedAssetId`
 * missing or deleted). `range` limits them to the exported span.
 */
export function pendingMotionClips(
  project: Pick<Project, "tracks">,
  hasAsset: (id: string) => boolean,
  range?: { start: number; end: number },
): Clip[] {
  const out: Clip[] = [];
  for (const track of project.tracks) {
    if (track.kind !== "motion" || track.hidden) continue;
    for (const c of track.clips) {
      if (!c.motion) continue;
      const id = c.renderedAssetId ?? c.assetId;
      if (id && hasAsset(id)) continue;
      const end = c.start + clipDuration(c);
      if (range && (end <= range.start + EPS || c.start >= range.end - EPS)) continue;
      out.push(c);
    }
  }
  return out;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new JobAbortedError());
    const onAbort = () => {
      clearTimeout(t);
      reject(new JobAbortedError());
    };
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });

/**
 * Render the pending motion clips of a project as `motion.render` jobs (motion lane, with
 * `target` so each clip gets its `renderedAssetId`), one after another, and wait for them.
 * Cancelling the caller cancels the running render. Returns how many were rendered.
 * Throws an Error with a Spanish message when one fails.
 */
export async function renderPendingMotion(
  app: Pick<AppContext, "queue" | "jobs" | "repos">,
  projectId: string,
  clips: readonly Clip[],
  o: {
    signal: AbortSignal;
    log?: (line: string) => void;
    onProgress?: (done: number, total: number, label: string) => void;
    pollMs?: number;
  },
): Promise<number> {
  const pollMs = o.pollMs ?? 250;
  let done = 0;
  for (const clip of clips) {
    const label = `Renderizando gráficos ${done + 1}/${clips.length} («${clip.motion!.template}»)`;
    o.onProgress?.(done, clips.length, label);
    let job: Job = app.queue.enqueue({
      type: "motion.render",
      payload: { ...clip.motion, target: { projectId, clipId: clip.id } },
      projectId,
    });
    o.log?.(`Render motion ${clip.motion!.template} (${clip.id}) para exportar: ${job.id}`);
    for (;;) {
      if (o.signal.aborted) {
        app.queue.cancel(job.id);
        throw new JobAbortedError();
      }
      job = app.jobs.get(job.id) ?? job;
      if (job.status === "succeeded") break;
      if (job.status === "failed" || job.status === "canceled")
        throw new Error(
          `No se pudo renderizar el gráfico «${clip.motion!.template}» antes de exportar: ` +
            `${job.status === "canceled" ? "se canceló" : (job.error ?? "falló")}. ` +
            "Probá «Renderizar ahora» en Propiedades.",
        );
      try {
        await sleep(pollMs, o.signal);
      } catch (err) {
        app.queue.cancel(job.id);
        throw err;
      }
    }
    done++;
  }
  if (clips.length) o.onProgress?.(done, clips.length, "Gráficos listos");
  return done;
}

/**
 * Pending motion clips whose spec the engines reject (unknown template, bad props): those still
 * block the export (409 EXPORT_BLOCKED), with the engine reason in Spanish.
 */
export function motionSpecProblems(
  app: Pick<AppContext, "repos" | "motion">,
  project: Pick<Project, "tracks">,
  range?: { start: number; end: number },
): string[] {
  const out: string[] = [];
  for (const c of pendingMotionClips(project, (id) => !!app.repos.media.get(id), range)) {
    const v = app.motion.validate(c.motion!);
    if (!v.ok)
      out.push(
        `Motion «${c.motion!.template}» no se puede renderizar (${v.errors.slice(0, 2).join("; ")})`,
      );
  }
  return out;
}
