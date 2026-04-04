from __future__ import annotations

from typing import Any

from fastapi import Request

from app.engines.fraud.pipeline import MasterFraudPipeline, run_fraud_pipeline


async def get_fraud_pipeline_service(request: Request) -> MasterFraudPipeline:
    return MasterFraudPipeline(
        mongo_db=getattr(request.app.state, "mongo_db", None),
        redis=getattr(request.app.state, "redis", None),
    )


def get_run_fraud_pipeline_callable() -> Any:
    return run_fraud_pipeline
