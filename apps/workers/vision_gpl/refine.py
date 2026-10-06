"""Alpha refinement for RVM mattes ("Recorte de calidad alta").

SPDX-License-Identifier: GPL-3.0-or-later


numpy or torch only (no OpenCV/PIL): ``NumpyOps`` (mock model, tests, CPU without torch) and
``TorchOps`` (the real model: runs where the frames already are, the GPU on CUDA) implement the
same few primitives with the same edge rules (in-bounds windows, replicate padding, lower median),
so the algorithm below is written once. Colours are HxWx3 and alpha HxW, floats in 0..1.

Per frame (``Refiner.__call__``), in this order:

1. **Mask guide** (``use_mask``): alpha = 0 outside the SAM mask dilated by ``mask_dilate`` px.
2. **Despill / decontamination** (``despill``), with the alpha the source was really mixed with:
   - background colour B: per-tile (``bg_tile`` px) lower median of the source pixels outside
     the foreground grown by ``bg_gap`` px (empty tiles take their neighbours' value);
   - interior colour F: the nearest interior (alpha > 0.98) foreground colours pushed outwards
     a few px (3x3 mean propagation);
   - colour consistency: on edge pixels the alpha may only SHRINK towards the projection of
     (obs - B) on (F - B), weighted by how distinct F and B are (pixels explained by the
     background colour stop being visible: the "impurities" of a colourful background);
   - foreground colour from the compositing equation obs = a*fg + (1-a)*B, i.e.
     fg = (obs - (1-a)*B) / a, solved as least squares with a weak prior towards F
     (``despill_prior`` = mu): fg = (a*(obs - (1-a)*B) + mu*F) / (a^2 + mu), clamped to 0..1
     (mu = 0 is the plain formula; mu > 0 avoids the 1/a noise blow-up at low alpha).
     Outside the alpha the colour becomes F, so a later feather never shows the background.
3. **Edge cleanup**: grey erosion of the alpha by ``erode`` px (square window) + gaussian
   ``feather`` (sigma in px).
4. **Temporal smoothing** (``temporal`` = k): on edge pixels (0.01 < a < 0.99 now or in the
   previous frame) alpha = (1-k)*alpha + k*previous, to reduce edge flicker. k = 0 turns it off.

``edge_halo`` is the no-reference halo score the runner reports (alpha-weighted mean colour
distance, 0..255, between the 3 px edge band and the nearby interior colour); ``halo_error`` is
the ground-truth version used by the synthetic tests (docs/trabajo/modulo-sprint3b-recorte.md).
"""

from __future__ import annotations

import math
import warnings
from dataclasses import asdict, dataclass, replace
from typing import Any

EDGE_HI = 0.98  # above: interior, the model's foreground is kept
EDGE_LO = 0.004
FG_THRESHOLD = 0.02  # alpha above = foreground for the background estimate
FILL_PX = 8  # how far the interior colour is pushed outwards


@dataclass(frozen=True)
class RefineParams:
    erode: int = 0  # px (grey erosion radius)
    feather: float = 0.0  # gaussian sigma, px
    despill: bool = False
    temporal: float = 0.0  # EMA factor on edge pixels (0 = off)
    bg_tile: int = 8  # px, local background estimate
    bg_gap: int = 3  # px around the foreground excluded from the background estimate
    despill_prior: float = 0.3  # mu: weight of the interior colour in the colour solve
    mask_dilate: int = 12  # px, SAM mask guide

    def active(self) -> bool:
        return bool(self.erode > 0 or self.feather > 0 or self.despill or self.temporal > 0)

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


FAST_DEFAULTS = RefineParams()
HIGH_DEFAULTS = RefineParams(erode=1, feather=0.7, despill=True, temporal=0.2)


def defaults(quality: str) -> RefineParams:
    return HIGH_DEFAULTS if quality == "high" else FAST_DEFAULTS


def resolve(quality: str, **overrides: Any) -> RefineParams:
    """Quality defaults with the explicitly given (not None) values on top, clamped."""
    given = {k: v for k, v in overrides.items() if v is not None}
    p = replace(defaults(quality), **given)
    return replace(
        p,
        erode=max(0, min(20, int(p.erode))),
        feather=max(0.0, min(20.0, float(p.feather))),
        despill=bool(p.despill),
        temporal=max(0.0, min(0.9, float(p.temporal))),
        bg_tile=max(4, min(128, int(p.bg_tile))),
        bg_gap=max(0, min(64, int(p.bg_gap))),
        despill_prior=max(0.0, min(10.0, float(p.despill_prior))),
        mask_dilate=max(0, min(200, int(p.mask_dilate))),
    )


def _gauss_kernel(sigma: float) -> list[float]:
    r = max(1, math.ceil(3 * sigma))
    k = [math.exp(-(i * i) / (2 * sigma * sigma)) for i in range(-r, r + 1)]
    s = sum(k)
    return [v / s for v in k]


# ------------------------------------------------------------------------------ backends


class _Ops:
    """Shared separable filters written with slicing only (fast on CPU and GPU alike); the
    backends supply padding, ``maximum`` and the tile median."""

    name = ""

    def _pad(self, a: Any, r: int, axis: int, edge: bool) -> Any:  # pragma: no cover
        raise NotImplementedError

    def maximum(self, a: Any, b: Any) -> Any:  # pragma: no cover
        raise NotImplementedError

    def _windows(self, a: Any, r: int, axis: int, edge: bool = True) -> list[Any]:
        p = self._pad(a, r, axis, edge)
        n = a.shape[axis]
        if axis == 0:
            return [p[k : k + n] for k in range(2 * r + 1)]
        return [p[:, k : k + n] for k in range(2 * r + 1)]

    def max_filter(self, a: Any, r: int) -> Any:
        """Square (2r+1)^2 max over HxW (edges: in-bounds window)."""
        if r <= 0:
            return a
        out = a
        for axis in (0, 1):
            parts = self._windows(out, r, axis)
            acc = parts[0]
            for p in parts[1:]:
                acc = self.maximum(acc, p)
            out = acc
        return out

    def min_filter(self, a: Any, r: int) -> Any:
        return -self.max_filter(-a, r)

    def gauss(self, a: Any, sigma: float) -> Any:
        """Separable gaussian, replicate padding."""
        if sigma <= 0:
            return a
        k = _gauss_kernel(sigma)
        r = (len(k) - 1) // 2
        out = a
        for axis in (0, 1):
            parts = self._windows(out, r, axis)
            acc = parts[0] * k[0]
            for w, p in zip(k[1:], parts[1:], strict=True):
                acc = acc + p * w
            out = acc
        return out

    def box3(self, a: Any) -> Any:
        """3x3 sum with zero padding (HxW or HxWxC)."""
        out = a
        for axis in (0, 1):
            p0, p1, p2 = self._windows(out, 1, axis, edge=False)
            out = p0 + p1 + p2
        return out


class NumpyOps(_Ops):
    name = "numpy"

    def __init__(self) -> None:
        import numpy as np  # noqa: PLC0415

        self.np = np

    def _pad(self, a: Any, r: int, axis: int, edge: bool) -> Any:
        pad = [(0, 0)] * a.ndim
        pad[axis] = (r, r)
        return self.np.pad(a, pad, mode="edge" if edge else "constant")

    def where(self, cond: Any, a: Any, b: Any) -> Any:
        return self.np.where(cond, a, b)

    def clip(self, a: Any, lo: float, hi: float) -> Any:
        return self.np.clip(a, lo, hi)

    def maximum(self, a: Any, b: Any) -> Any:
        return self.np.maximum(a, b)

    def minimum(self, a: Any, b: Any) -> Any:
        return self.np.minimum(a, b)

    def sqrt(self, a: Any) -> Any:
        return self.np.sqrt(a)

    def to_float(self, a: Any) -> Any:
        return a.astype(self.np.float32)

    def total(self, a: Any) -> float:
        return float(a.sum())

    def tile_median(self, img: Any, valid: Any, tile: int) -> Any | None:
        """Per-tile lower median of ``img`` (HxWxC) over ``valid`` pixels, upsampled (nearest)
        to HxWxC; empty tiles take the mean of their filled neighbours. None: nothing valid."""
        np = self.np
        h, w, c = img.shape
        if not bool(valid.any()):
            return None
        th, tw = -(-h // tile), -(-w // tile)
        data = np.where(valid[..., None], img, np.nan).astype(np.float32)
        data = np.pad(data, ((0, th * tile - h), (0, tw * tile - w), (0, 0)),
                      constant_values=np.nan)  # fmt: skip
        blocks = data.reshape(th, tile, tw, tile, c).transpose(0, 2, 1, 3, 4)
        blocks = blocks.reshape(th, tw, tile * tile, c)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)  # all-NaN tiles -> NaN
            med = np.nanpercentile(blocks, 50, axis=2, method="lower").astype(np.float32)
            for _ in range(max(th, tw)):
                empty = np.isnan(med[..., 0])
                if not empty.any():
                    break
                p = np.pad(med, ((1, 1), (1, 1), (0, 0)), constant_values=np.nan)
                mean = np.nanmean(np.stack([p[:-2, 1:-1], p[2:, 1:-1], p[1:-1, :-2],
                                            p[1:-1, 2:]]), axis=0)  # fmt: skip
                med = np.where(empty[..., None] & ~np.isnan(mean), mean, med)
        full = np.repeat(np.repeat(med, tile, axis=0), tile, axis=1)
        return full[:h, :w]


class TorchOps(_Ops):
    """Same primitives on torch tensors (any device)."""

    name = "torch"

    def __init__(self, torch: Any) -> None:
        import torch.nn.functional as F  # noqa: N812, PLC0415

        self.torch = torch
        self.F = F

    def _pad(self, a: Any, r: int, axis: int, edge: bool) -> Any:
        t = self.torch
        n = a.shape[axis]
        if edge:
            lo, hi = a.narrow(axis, 0, 1), a.narrow(axis, n - 1, 1)
            reps = [1] * a.ndim
            reps[axis] = r
            return t.cat([lo.repeat(*reps), a, hi.repeat(*reps)], dim=axis)
        shape = list(a.shape)
        shape[axis] = r
        z = t.zeros(shape, dtype=a.dtype, device=a.device)
        return t.cat([z, a, z], dim=axis)

    def _t(self, v: Any, like: Any) -> Any:
        t = self.torch
        return v if isinstance(v, t.Tensor) else t.tensor(float(v), device=like.device)

    def where(self, cond: Any, a: Any, b: Any) -> Any:
        return self.torch.where(cond, self._t(a, cond), self._t(b, cond))

    def clip(self, a: Any, lo: float, hi: float) -> Any:
        return a.clamp(lo, hi)

    def maximum(self, a: Any, b: Any) -> Any:
        return self.torch.maximum(a, self._t(b, a))

    def minimum(self, a: Any, b: Any) -> Any:
        return self.torch.minimum(a, self._t(b, a))

    def sqrt(self, a: Any) -> Any:
        return a.sqrt()

    def to_float(self, a: Any) -> Any:
        return a.float()

    def total(self, a: Any) -> float:
        return float(a.sum().item())

    def tile_median(self, img: Any, valid: Any, tile: int) -> Any | None:
        t, F = self.torch, self.F
        h, w, c = img.shape
        if not bool(valid.any()):
            return None
        th, tw = -(-h // tile), -(-w // tile)
        nan = float("nan")
        data = t.where(valid[..., None], img.float(), t.tensor(nan, device=img.device))
        data = F.pad(data.permute(2, 0, 1), (0, tw * tile - w, 0, th * tile - h), value=nan)
        blocks = data.reshape(c, th, tile, tw, tile).permute(1, 3, 0, 2, 4)
        med = t.nanmedian(blocks.reshape(th, tw, c, tile * tile), dim=-1).values  # lower median
        for _ in range(max(th, tw)):
            empty = t.isnan(med[..., 0])
            if not bool(empty.any()):
                break
            p = F.pad(med.permute(2, 0, 1), (1, 1, 1, 1), value=nan).permute(1, 2, 0)
            mean = t.nanmean(t.stack([p[:-2, 1:-1], p[2:, 1:-1], p[1:-1, :-2], p[1:-1, 2:]]), 0)
            med = t.where(empty[..., None] & ~t.isnan(mean), mean, med)
        full = med.repeat_interleave(tile, dim=0).repeat_interleave(tile, dim=1)
        return full[:h, :w]


# ------------------------------------------------------------------------------ algorithm


def fill(ops: Any, img: Any, valid: Any, iters: int) -> tuple[Any, Any]:
    """Push ``img`` (HxWxC) from ``valid`` pixels outwards ``iters`` px (3x3 mean of the valid
    neighbours). Returns (colours, mask of the pixels that have one)."""
    v = ops.to_float(valid)
    x = img * v[..., None]
    for _ in range(max(0, iters)):
        cnt = ops.box3(v)
        grow = (v < 0.5) & (cnt > 0.5)
        mean = ops.box3(x) / ops.clip(cnt, 1.0, 9.0)[..., None]
        x = ops.where(grow[..., None], mean, x)
        v = ops.where(grow, 1.0, v)
    return x, v > 0.5


def estimate_background(ops: Any, obs: Any, pha: Any, tile: int, gap: int) -> Any | None:
    near = ops.max_filter(ops.to_float(pha > FG_THRESHOLD), gap) > 0.5
    return ops.tile_median(obs, ~near, tile)


def despill(ops: Any, obs: Any, fgr: Any, pha: Any, p: RefineParams) -> tuple[Any, Any]:
    """Colour decontamination + colour-consistent alpha shrink (module docstring, step 2)."""
    bg = estimate_background(ops, obs, pha, p.bg_tile, p.bg_gap)
    if bg is None:  # nothing outside the foreground: no background to remove
        return fgr, pha
    interior = ops.min_filter(ops.to_float(pha > EDGE_HI), 1) > 0.5
    ref, has_ref = fill(ops, fgr, interior, p.bg_gap + FILL_PX)
    ref = ops.where(has_ref[..., None], ref, fgr)
    edge = (pha > EDGE_LO) & (pha < EDGE_HI)
    d = ref - bg
    n2 = (d * d).sum(-1)
    proj = ops.clip(((obs - bg) * d).sum(-1) / (n2 + 1e-6), 0.0, 1.0)
    conf = ops.clip((ops.sqrt(n2) - 0.1) / 0.2, 0.0, 1.0) * ops.to_float(has_ref)
    pha = ops.where(edge, pha + conf * (ops.minimum(pha, proj) - pha), pha)
    a = pha[..., None]
    mu = p.despill_prior
    if mu > 0:
        sol = (a * (obs - (1.0 - a) * bg) + ref * mu) / (a * a + mu)
    else:
        sol = (obs - (1.0 - a) * bg) / ops.clip(a, 0.1, 1.0)
    out = ops.where(edge[..., None], ops.clip(sol, 0.0, 1.0), fgr)
    return ops.where(((pha <= EDGE_LO) & has_ref)[..., None], ref, out), pha


def edge_band(ops: Any, pha: Any, px: int = 3) -> Any:
    hard = ops.to_float(pha > 0.5)
    return (ops.max_filter(hard, px) - ops.min_filter(hard, px)) > 0.5


def edge_halo(ops: Any, fgr: Any, pha: Any, px: int = 3) -> float | None:
    """No-reference halo score (0..255): alpha-weighted mean |edge colour - nearby interior
    colour| in the ``px`` band around alpha = 0.5. Lower = cleaner edges."""
    interior = ops.min_filter(ops.to_float(pha > EDGE_HI), px) > 0.5
    ref, has_ref = fill(ops, fgr, interior, 2 * px + 2)
    wgt = ops.where(edge_band(ops, pha, px) & has_ref, pha, 0.0)
    total = ops.total(wgt)
    if total <= 1e-6:
        return None
    diff = abs(fgr - ref).mean(-1)
    return round(ops.total(diff * wgt) / total * 255.0, 3)


def halo_error(fgr: Any, pha: Any, fg_true: Any, band: Any) -> float:
    """Ground-truth halo (tests, numpy): alpha-weighted mean |fg - fg_true| (0..255) in ``band``."""
    import numpy as np  # noqa: PLC0415

    w = np.where(band, pha, 0.0)
    diff = np.abs(fgr - fg_true).mean(axis=-1)
    return float((diff * w).sum() / max(1e-6, float(w.sum())) * 255.0)


class Refiner:
    """Stateful per-clip refiner (the temporal EMA keeps the previous alpha). ``reset`` at the
    start of every pass (the runner re-warms the recurrent state after a restart)."""

    def __init__(self, params: RefineParams, ops: Any) -> None:
        self.p = params
        self.ops = ops
        self.prev: Any = None

    def reset(self) -> None:
        self.prev = None

    def __call__(self, obs: Any, fgr: Any, pha: Any, mask: Any = None) -> tuple[Any, Any]:
        ops, p = self.ops, self.p
        if mask is not None:  # 1. SAM mask guide (mask: HxW 0..1)
            keep = ops.max_filter(ops.to_float(mask > 0.5), p.mask_dilate) > 0.5
            pha = pha * ops.to_float(keep)
        if p.despill:  # 2. colour decontamination with the alpha the source was mixed with
            fgr, pha = despill(ops, obs, fgr, pha, p)
        if p.erode > 0:  # 3. edge cleanup
            pha = ops.min_filter(pha, p.erode)
        if p.feather > 0:
            pha = ops.clip(ops.gauss(pha, p.feather), 0.0, 1.0)
        if p.temporal > 0:  # 4. temporal EMA on edges
            prev = self.prev
            if prev is not None and tuple(prev.shape) == tuple(pha.shape):
                edge = ((pha > 0.01) & (pha < 0.99)) | ((prev > 0.01) & (prev < 0.99))
                pha = ops.where(edge, pha * (1.0 - p.temporal) + prev * p.temporal, pha)
            self.prev = pha
        return fgr, pha


def compose_compare(ops: Any, before: tuple[Any, Any], after: tuple[Any, Any]) -> Any:
    """Before | after over a neutral grey checkerboard (H x (2W+8) x 3, floats 0..1): colour
    halos of the original background show up as coloured fringes on the grey."""
    pha = before[1]
    h, w = pha.shape
    if ops.name == "torch":
        t = ops.torch
        yy = t.arange(h, device=pha.device)[:, None] // 16
        xx = t.arange(w, device=pha.device)[None, :] // 16
        checker = ((yy + xx) % 2).float() * 0.16 + 0.42
        sep = t.ones((h, 8, 3), device=pha.device)

        def cat(parts: list[Any]) -> Any:
            return t.cat(parts, dim=1)
    else:
        np = ops.np
        yy, xx = np.mgrid[0:h, 0:w]
        checker = (((yy // 16) + (xx // 16)) % 2).astype(np.float32) * 0.16 + 0.42
        sep = np.ones((h, 8, 3), dtype=np.float32)

        def cat(parts: list[Any]) -> Any:
            return np.concatenate(parts, axis=1)

    def over(f: Any, a: Any) -> Any:
        return f * a[..., None] + checker[..., None] * (1.0 - a[..., None])

    return cat([over(*before), sep, over(*after)])
