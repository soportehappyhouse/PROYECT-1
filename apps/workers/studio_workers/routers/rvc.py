from fastapi import APIRouter, HTTPException

from ..schemas import RvcConvertRequest, RvcModel, RvcResult

router = APIRouter(prefix="/rvc", tags=["rvc"])


@router.get("/models", response_model=list[RvcModel], response_model_by_alias=True)
def list_models() -> list[RvcModel]:
    # TODO(module-d): scan models_root/"rvc"/<name>/{*.pth,*.index}.
    return []


@router.post("/convert", response_model=RvcResult, response_model_by_alias=True)
def convert(req: RvcConvertRequest) -> RvcResult:
    # TODO(module-d): RVC inference with infer-rvc-python
    #   (hubert_base + rmvpe.pt from models/rvc/_base),
    #   CPU default, CUDA if req.device/settings.use_cuda,
    #   read settings.storage_path(req.input_path), write settings.storage_path(req.output_path).
    raise HTTPException(status_code=501, detail="TODO(module-d): rvc not implemented")
