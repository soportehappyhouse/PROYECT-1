"""Sprint 3b «Perfil de estilo»: analyze a reference video and deduce a StylePreset.

- ``analyze.analyze_style``: cuts (PySceneDetect if the ``scenes`` pack is there, else FFmpeg's
  scene-change score), shot stats, motion (frame-difference heuristics), audio (EBU R128 loudness,
  silences, speech/music heuristics), optional OCR (pack ``ocr``), transcript excerpt and a 4x6
  contact sheet with timestamps -> ``StyleAnalysis`` JSON (packages/shared/src/style.ts).
- ``infer.infer_preset``: Ollama ``qwen2.5vl:3b`` (pack ``vision-llm``) looks at the contact sheet +
  the analysis and answers a ``StylePreset`` draft constrained by ``stylepreset.schema.json``
  (exported by ``pnpm --filter @studio/shared export-schemas``).
"""
