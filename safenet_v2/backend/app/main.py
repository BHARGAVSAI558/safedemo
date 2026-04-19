from contextlib import asynccontextmanager
import asyncio
import subprocess
import sys
import traceback
from pathlib import Path

import redis.asyncio as aioredis
from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import ValidationError
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware
from sqlalchemy import func, select, text

from app.api.v1.routes import admin, auth, claims, notifications, policies, pools, profile, simulation, support, weather_aqi, websockets, workers, zones
from app.api.v1.routes import events, payments
from app.core.config import settings
from app.core.exceptions import SafeNetBaseException
from app.db.mongo import connect_mongo, disconnect_mongo
from app.services.event_service import load_government_alerts_from_path
from app.core.middleware import MaxBodySizeMiddleware, RequestIDMiddleware, RequestTimingMiddleware, RateLimitMiddleware
from app.core.rate_limit import limiter
from app.db.session import AsyncSessionLocal, engine, init_db, sqlite_uses_memory_fallback
from app.models.zone import Zone
from app.tasks.background_scheduler import shutdown_background_scheduler, start_background_scheduler
from app.utils.logger import logger

BACKEND_ROOT = Path(__file__).resolve().parent.parent


def _run_alembic_upgrade_sync() -> None:
    try:
        subprocess.run(
            [sys.executable, "-m", "alembic", "upgrade", "head"],
            cwd=str(BACKEND_ROOT),
            check=False,
            capture_output=True,
            text=True,
        )
    except Exception as exc:
        logger.warning("alembic_upgrade_skipped: %s", exc)


async def _post_init_zones_and_log() -> None:
    from seed_db import seed_demo_workers, seed_zones

    async with AsyncSessionLocal() as session:
        zcount = int((await session.execute(select(func.count()).select_from(Zone))).scalar_one() or 0)
    if zcount == 0:
        await seed_zones()
    await seed_demo_workers()
    async with AsyncSessionLocal() as session:
        zcount = int((await session.execute(select(func.count()).select_from(Zone))).scalar_one() or 0)
    logger.info("DB ready. Zones: %s", zcount)


@asynccontextmanager
async def lifespan(app: FastAPI):
    try:
        import os

        if (os.getenv("DATABASE_URL") or "").strip():
            await asyncio.to_thread(_run_alembic_upgrade_sync)

        await init_db()
        logger.info("Database initialized")
        await _post_init_zones_and_log()
        logger.info(
            "startup_db",
            engine_name="main",
            decision="ready",
            reason_code="DB_INIT",
            version=settings.APP_VERSION,
        )
    except Exception as exc:
        logger.warning(f"DB init warning (continuing): {exc}")
        logger.warning(
            "startup_db_warning",
            engine_name="main",
            decision="degraded",
            reason_code="DB_INIT_FAILED",
            error=str(exc),
        )

    try:
        if settings.REDIS_URL:
            app.state.redis = aioredis.from_url(settings.REDIS_URL, decode_responses=True)
            await app.state.redis.ping()
            logger.info(
                "startup_redis",
                engine_name="main",
                decision="connected",
                reason_code="REDIS_OK",
            )
        else:
            app.state.redis = None
            logger.info("Redis not configured — using in-memory fallback")
    except Exception:
        app.state.redis = None
        logger.warning(
            "startup_redis_failed",
            engine_name="main",
            decision="fallback",
            reason_code="REDIS_DOWN",
        )

    app.state.mongo_db = await connect_mongo()
    if app.state.mongo_db is not None:
        logger.info(
            "startup_mongo",
            engine_name="main",
            decision="connected",
            reason_code="MONGO_OK",
        )

    seed = settings.GOVERNMENT_ALERTS_SEED_PATH or None
    load_government_alerts_from_path(seed)

    app.state.forecast_shields = {}
    app.state.zone_status_last = {}
    start_background_scheduler(app)

    logger.info(
        "startup_complete",
        engine_name="main",
        decision="ready",
        reason_code="APP_READY",
        app=settings.APP_NAME,
        version=settings.APP_VERSION,
    )
    yield

    shutdown_background_scheduler(app)
    r = getattr(app.state, "redis", None)
    if r is not None:
        await r.aclose()
    await disconnect_mongo()
    await engine.dispose()
    logger.info(
        "shutdown_complete",
        engine_name="main",
        decision="stopped",
        reason_code="APP_DOWN",
    )


app = FastAPI(
    title="SafeNet API",
    description="Intelligent income protection platform for gig workers",
    version=settings.APP_VERSION,
    lifespan=lifespan,
)

app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# Middleware runs in reverse order of registration: last added runs first on each request.
# CORS must be outermost so every response (including errors from inner layers) gets CORS headers.
# Expo/web clients burst many parallel GETs (profile, policy, claims); keep high to avoid 429 in dev.
app.add_middleware(RateLimitMiddleware, requests_per_minute=800)
app.add_middleware(MaxBodySizeMiddleware)
app.add_middleware(RequestIDMiddleware)
app.add_middleware(RequestTimingMiddleware)
app.add_middleware(SlowAPIMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.origins,
    allow_origin_regex=r"^(https?://(localhost|127\.0\.0\.1)(:\d+)?|https?://(10|192\.168|172\.(1[6-9]|2\d|3[0-1]))(\.\d{1,3}){2}(:\d+)?|exp://(localhost|127\.0\.0\.1)(:\d+)?|exp://(10|192\.168|172\.(1[6-9]|2\d|3[0-1]))(\.\d{1,3}){2}(:\d+)?)$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Request-ID"],
)


@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException) -> JSONResponse:
    rid = getattr(request.state, "request_id", None)
    return JSONResponse(
        status_code=exc.status_code,
        content={"detail": exc.detail, "request_id": rid},
    )


@app.exception_handler(SafeNetBaseException)
async def safenet_exception_handler(request: Request, exc: SafeNetBaseException) -> JSONResponse:
    rid = getattr(request.state, "request_id", None)
    logger.warning(
        "safenet_exception",
        engine_name="main",
        decision="handled",
        reason_code=exc.error_code,
        details=exc.details,
        request_id=rid,
    )
    status_code = 400
    if exc.error_code in {"NO_ACTIVE_POLICY"}:
        status_code = 402
    elif exc.error_code in {"DB_OVERLOADED"}:
        status_code = 503
    elif exc.error_code in {"DUPLICATE_CLAIM"}:
        status_code = 409
    return JSONResponse(
        status_code=status_code,
        content={"error_code": exc.error_code, "message": exc.message, "details": exc.details, "request_id": rid},
    )


@app.exception_handler(RequestValidationError)
async def request_validation_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
    rid = getattr(request.state, "request_id", None)
    return JSONResponse(
        status_code=422,
        content={"detail": exc.errors(), "request_id": rid},
    )


@app.exception_handler(ValidationError)
async def pydantic_validation_handler(request: Request, exc: ValidationError) -> JSONResponse:
    rid = getattr(request.state, "request_id", None)
    return JSONResponse(
        status_code=422,
        content={"detail": exc.errors(), "request_id": rid},
    )


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    rid = getattr(request.state, "request_id", None)
    logger.error(f"500 error: {request.url} — {traceback.format_exc()}")
    logger.exception(
        "unhandled_exception",
        engine_name="main",
        decision="error",
        reason_code="UNHANDLED",
        path=str(request.url.path),
        request_id=rid,
    )
    return JSONResponse(
        status_code=500,
        content={"detail": "Internal server error", "request_id": rid},
    )


app.include_router(auth.router, prefix="/api/v1/auth", tags=["Authentication"])
app.include_router(notifications.router, prefix="/api/v1/notifications", tags=["Notifications"])
app.include_router(profile.router, prefix="/api/v1/profile", tags=["Profile"])
app.include_router(workers.router, prefix="/api/v1/workers", tags=["Workers"])
app.include_router(zones.router, prefix="/api/v1", tags=["Zones"])
app.include_router(policies.router, prefix="/api/v1/policies", tags=["Policies"])
app.include_router(pools.router, prefix="/api/v1/pools", tags=["Pools"])
app.include_router(weather_aqi.router, prefix="/api/v1", tags=["Weather & AQI"])
app.include_router(claims.router, prefix="/api/v1/claims", tags=["Claims"])
app.include_router(simulation.router, prefix="/api/v1/simulation", tags=["Simulation"])
app.include_router(support.router, prefix="/api/v1/support", tags=["Support"])
app.include_router(admin.router, prefix="/api/v1/admin", tags=["Admin"])
app.include_router(events.router, prefix="/api/v1/admin/events", tags=["Admin Events"])
app.include_router(payments.router, prefix="/api/v1/payments", tags=["Payments"])
app.include_router(websockets.router, tags=["WebSockets"])


@app.get("/", tags=["Health"])
async def root():
    return {"app": settings.APP_NAME, "version": settings.APP_VERSION, "status": "healthy"}


@app.get("/health", tags=["Health"])
async def health(request: Request):
    db_ok = False
    try:
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
        db_ok = True
    except Exception:
        db_ok = False

    r = getattr(request.app.state, "redis", None)
    redis_ok = False
    redis_skipped = r is None
    if r is not None:
        try:
            pong = await r.ping()
            redis_ok = bool(pong) if pong is not None else True
        except Exception:
            redis_ok = False

    sched = getattr(request.app.state, "scheduler", None)
    scheduler_running = bool(getattr(request.app.state, "scheduler_running", False))
    if sched is not None:
        scheduler_running = bool(sched.running)

    mongo_uri = (getattr(settings, "MONGODB_URI", "") or "").strip()
    mongo_skipped = not mongo_uri
    mongo_db = getattr(request.app.state, "mongo_db", None)
    mongo_ok = mongo_db is not None

    if not db_ok:
        overall = "unhealthy"
    elif not scheduler_running:
        overall = "degraded"
    elif not redis_skipped and not redis_ok:
        overall = "degraded"
    elif mongo_uri and not mongo_ok:
        overall = "degraded"
    else:
        overall = "healthy"

    return {
        "status": overall,
        "version": settings.APP_VERSION,
        "db": "connected" if db_ok else "disconnected",
        "storage": {
            "driver": "sqlite" if settings.is_sqlite else "postgres",
            "persistent": not (settings.is_sqlite and sqlite_uses_memory_fallback()),
        },
        "database": {"connected": db_ok},
        "redis": {"connected": redis_ok, "skipped": redis_skipped},
        "mongodb": {"connected": mongo_ok, "skipped": mongo_skipped},
        "scheduler": {"running": scheduler_running},
    }
