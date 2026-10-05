from fastapi import APIRouter, HTTPException

from ..progress import registry
from ..schemas import JobProgress

router = APIRouter(prefix="/jobs", tags=["jobs"])


@router.get(
    "/{job_id}",
    response_model=JobProgress,
    response_model_by_alias=True,
    response_model_exclude_none=True,
)
def job_progress(job_id: str) -> JobProgress:
    """Progress of a running call that was sent with the same `jobId` (polled by the api)."""
    item = registry.get(job_id)
    if item is None:
        raise HTTPException(status_code=404, detail=f"Job {job_id} desconocido")
    return item
