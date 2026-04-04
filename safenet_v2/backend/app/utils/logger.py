import logging
import sys

import structlog
from structlog.contextvars import bind_contextvars, clear_contextvars, merge_contextvars

from app.core.config import settings


def configure_logging() -> None:
    timestamper = structlog.processors.TimeStamper(fmt="iso", utc=True)
    shared = [
        merge_contextvars,
        structlog.processors.add_log_level,
        structlog.processors.StackInfoRenderer(),
        structlog.dev.set_exc_info,
        timestamper,
    ]
    if settings.DEBUG:
        processors = shared + [structlog.dev.ConsoleRenderer(colors=True)]
    else:
        processors = shared + [structlog.processors.JSONRenderer()]

    structlog.configure(
        processors=processors,
        logger_factory=structlog.PrintLoggerFactory(file=sys.stdout),
        cache_logger_on_first_use=True,
    )
    logging.basicConfig(level=logging.INFO, format="%(message)s", stream=sys.stdout, force=True)


configure_logging()


def get_logger(name: str = "safenet"):
    return structlog.get_logger(name)


def bind_request_context(request_id: str) -> None:
    clear_contextvars()
    bind_contextvars(request_id=request_id)


logger = get_logger()
