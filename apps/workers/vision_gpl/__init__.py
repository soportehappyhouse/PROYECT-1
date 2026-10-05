"""Studio vision_gpl: RobustVideoMatting runner, isolated because RVM is GPL-3.0.

SPDX-License-Identifier: GPL-3.0-or-later

This package runs ONLY inside ``apps/workers/.venv-gpl`` as a separate process
(``python -m vision_gpl.rvm ...``) and talks to the Studio workers through JSON lines on stdout.
It must never be imported by ``studio_workers`` (MIT), and it imports nothing from it: the process
boundary keeps the GPL code out of the rest of Studio (decision 2, docs/01-PLAN-BASE-v2.md).
Dependencies: ``requirements.txt`` next to this file (torch + numpy) and FFmpeg on PATH or
``--ffmpeg``.
"""

__version__ = "0.1.0"
