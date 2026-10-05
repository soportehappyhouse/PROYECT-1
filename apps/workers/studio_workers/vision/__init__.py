"""Sprint 2 vision features: matting, SAM 2 masks, tracking, auto-reframe (see routers/vision.py).

Nothing here imports the GPL code in ``apps/workers/vision_gpl`` (RobustVideoMatting): it runs in
its own venv (``.venv-gpl``) as a subprocess and talks JSON lines over stdout (``gpl.py``).
"""
