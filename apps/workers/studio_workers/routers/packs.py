from typing import Any

from fastapi import APIRouter

from ..config import get_settings
from ..errors import NotFoundError
from ..packs import PACKS, install_pack, list_packs
from ..services import pack_queue
from ..tasks import Task

router = APIRouter(prefix="/packs", tags=["packs"])


@router.get("")
def packs() -> list[dict[str, Any]]:
    """Every pack with installed/partial state and its files (filesystem only, fast)."""
    return list_packs(get_settings().models_root)


@router.post("/{pack_id}/download")
def download(pack_id: str) -> dict[str, Any]:
    """Queue the pack (sequential, resumable, verified). Poll GET /packs/tasks/{task_id}."""
    if pack_id not in PACKS:
        raise NotFoundError(f"Paquete desconocido: {pack_id}")
    require_licence(pack_id)
    root = get_settings().models_root

    def run(task: Task) -> dict[str, Any]:
        def progress(done: int, total: int, current: str | None) -> None:
            task.set_progress(done, total)
            if current:
                task.current_file = current

        catalog = None
        if pack_id in ("core", "voces-es"):  # md5 + exact sizes from voices.json when online
            from ..tts.piper_catalog import load_voices_json  # noqa: PLC0415

            catalog = load_voices_json(root)
        report = install_pack(
            pack_id, root, on_progress=progress, on_line=task.add_log, catalog=catalog
        )
        return {
            "downloaded": report.downloaded,
            "skipped": report.skipped,
            "pip": report.pip,
            "bytes": report.bytes,
        }

    task = pack_queue().submit("packs.download", pack_id, run)
    return {"task_id": task.id, "status": task.status}


def require_licence(pack_id: str) -> None:
    """Sprint 4 (criterion 5): a pack with ``licence_gate`` is not downloaded until its licence is
    accepted on screen (mirror storage/consent/licences.json, written by the api) -> 403
    LICENCE_REQUIRED. The api checks it first; this is the defence in depth for direct calls."""
    gate = getattr(PACKS[pack_id], "licence_gate", None)
    if not gate:
        return
    from ..errors import CodedError  # noqa: PLC0415
    from ..toolvenv import LICENCE_TEXT_VERSIONS, licence_accepted  # noqa: PLC0415

    if not licence_accepted(gate):
        raise CodedError(
            "LICENCE_REQUIRED",
            "Para usar el cambio de cara tenés que leer y aceptar su licencia (modelos no "
            "comerciales + OpenRAIL-AS) en pantalla: Ajustes → Paquetes de IA.",
            details={"licenceId": gate, "text_version": LICENCE_TEXT_VERSIONS.get(gate, "")},
        )


@router.get("/tasks/{task_id}")
def task_status(task_id: str) -> dict[str, Any]:
    """{status: queued|running|done|error, progress, bytes_done, bytes_total, current_file}."""
    task = pack_queue().get(task_id)
    if task is None:
        raise NotFoundError(f"Tarea desconocida: {task_id}")
    return task.public()
