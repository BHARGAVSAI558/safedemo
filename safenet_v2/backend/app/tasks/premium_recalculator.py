from typing import Any

from app.utils.logger import get_logger

log = get_logger(__name__)


async def run_premium_recalc_tick(app: Any) -> None:
    log.info(
        "premium_recalc_tick",
        engine_name="premium_recalculator",
        decision="noop",
        reason_code="SCHEDULED",
        scheduler_status=getattr(getattr(app, "state", None), "scheduler_running", False),
    )
