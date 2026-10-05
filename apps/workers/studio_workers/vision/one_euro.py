"""One-Euro filter (Casiez, Roussel, Vogel - CHI 2012): low jitter when slow, low lag when fast.

cutoff = min_cutoff + beta * |dx/dt|; each sample is an exponential smoothing with
alpha = 1 / (1 + tau / dt), tau = 1 / (2 pi cutoff). Timestamps drive dt, so variable frame rates
and detection every N frames are handled. Coordinates here are normalized (0..1 of the frame), so
``beta`` is in "frame widths per second" units (defaults tuned for that scale).
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass

TRACK_PARAMS = {"min_cutoff": 2.0, "beta": 4.0, "d_cutoff": 1.0}
REFRAME_PARAMS = {"min_cutoff": 0.5, "beta": 1.5, "d_cutoff": 1.0}


def _alpha(cutoff: float, dt: float) -> float:
    tau = 1.0 / (2.0 * math.pi * cutoff)
    return 1.0 / (1.0 + tau / dt)


@dataclass
class OneEuroFilter:
    min_cutoff: float = 1.0
    beta: float = 0.007
    d_cutoff: float = 1.0
    _t: float | None = None
    _x: float = 0.0
    _dx: float = 0.0

    def reset(self) -> None:
        self._t = None
        self._x = 0.0
        self._dx = 0.0

    def __call__(self, t: float, x: float) -> float:
        if self._t is None:
            self._t, self._x, self._dx = t, x, 0.0
            return x
        dt = t - self._t
        if dt <= 0:  # duplicate timestamp: keep the previous estimate
            return self._x
        dx = (x - self._x) / dt
        self._dx += _alpha(self.d_cutoff, dt) * (dx - self._dx)
        cutoff = self.min_cutoff + self.beta * abs(self._dx)
        self._x += _alpha(cutoff, dt) * (x - self._x)
        self._t = t
        return self._x


def smooth(
    ts: Sequence[float],
    xs: Sequence[float],
    min_cutoff: float = 1.0,
    beta: float = 0.007,
    d_cutoff: float = 1.0,
) -> list[float]:
    """Filter a whole series (one filter instance, in time order)."""
    f = OneEuroFilter(min_cutoff, beta, d_cutoff)
    return [f(t, x) for t, x in zip(ts, xs, strict=True)]


def smooth_zero_lag(
    ts: Sequence[float],
    xs: Sequence[float],
    min_cutoff: float = 1.0,
    beta: float = 0.007,
    d_cutoff: float = 1.0,
) -> list[float]:
    """Offline One-Euro: mean of a forward and a time-reversed pass (forward-backward).

    A causal filter trails a moving object (TRACK_PARAMS: ~1.6 frames at 200 px/s on 1280 px,
    which a following text shows as an offset). On a whole recorded series the two passes lag in
    opposite directions, so constant-velocity motion comes out without lag while the jitter
    reduction stays. Both ends are padded with an odd reflection (as scipy's filtfilt) so the
    first / last frames are not pulled by the start-up of either pass.
    """
    n = len(ts)
    if n < 3:
        return list(xs)
    k = min(15, n - 1)
    t0, x0, t1, x1 = ts[0], xs[0], ts[-1], xs[-1]
    pt = [2 * t0 - ts[i] for i in range(k, 0, -1)] + list(ts)
    pt += [2 * t1 - ts[n - 1 - i] for i in range(1, k + 1)]
    px = [2 * x0 - xs[i] for i in range(k, 0, -1)] + list(xs)
    px += [2 * x1 - xs[n - 1 - i] for i in range(1, k + 1)]
    fwd = smooth(pt, px, min_cutoff, beta, d_cutoff)
    rev = smooth([-t for t in reversed(pt)], list(reversed(px)), min_cutoff, beta, d_cutoff)
    both = [(a + b) / 2 for a, b in zip(fwd, reversed(rev), strict=True)]
    return both[k : k + n]


def deadzone(xs: Sequence[float], zone: float) -> list[float]:
    """Hold the value until it moves more than `zone` from the held one (reframe stability)."""
    out: list[float] = []
    held: float | None = None
    for x in xs:
        if held is None or abs(x - held) > zone:
            held = x if held is None else x - math.copysign(zone, x - held)
        out.append(held)
    return out


def limit_speed(ts: Sequence[float], xs: Sequence[float], max_per_s: float) -> list[float]:
    """Clamp the change per second (maximum pan speed)."""
    out: list[float] = []
    for i, (t, x) in enumerate(zip(ts, xs, strict=True)):
        if i == 0:
            out.append(x)
            continue
        step = max_per_s * max(0.0, t - ts[i - 1])
        prev = out[-1]
        out.append(prev + max(-step, min(step, x - prev)))
    return out


def rdp(points: Sequence[tuple[float, float]], eps: float) -> list[int]:
    """Ramer-Douglas-Peucker on (t, x): indices of the points to keep (first/last always)."""
    n = len(points)
    if n <= 2:
        return list(range(n))
    keep = [False] * n
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    while stack:
        a, b = stack.pop()
        (ta, xa), (tb, xb) = points[a], points[b]
        best, idx = -1.0, -1
        for i in range(a + 1, b):
            ti, xi = points[i]
            line = xa if tb == ta else xa + (xb - xa) * (ti - ta) / (tb - ta)
            d = abs(xi - line)
            if d > best:
                best, idx = d, i
        if idx >= 0 and best > eps:
            keep[idx] = True
            stack += [(a, idx), (idx, b)]
    return [i for i, k in enumerate(keep) if k]
