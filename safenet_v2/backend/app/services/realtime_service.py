from __future__ import annotations

import asyncio
import json
import time
from datetime import datetime, timezone
from uuid import uuid4
from typing import Any, Dict, Optional, Set, Tuple

import redis.asyncio as aioredis

from app.utils.logger import get_logger

log = get_logger(__name__)


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


class InProcessEventBus:
    """
    Fallback in-memory pub/sub implemented with asyncio.Queue.
    WebSockets can subscribe and get messages even when Redis is unavailable.
    """

    def __init__(self) -> None:
        self._subs: Dict[str, Set[asyncio.Queue[Any]]] = {}
        self._lock = asyncio.Lock()

    async def subscribe(self, channel: str) -> asyncio.Queue[Any]:
        q: asyncio.Queue[Any] = asyncio.Queue()
        async with self._lock:
            self._subs.setdefault(channel, set()).add(q)
        return q

    async def unsubscribe(self, channel: str, q: asyncio.Queue[Any]) -> None:
        async with self._lock:
            subs = self._subs.get(channel)
            if not subs:
                return
            subs.discard(q)
            if not subs:
                self._subs.pop(channel, None)

    async def publish(self, channel: str, payload: Any) -> None:
        async with self._lock:
            subs = list(self._subs.get(channel, set()))
        for q in subs:
            try:
                q.put_nowait(payload)
            except asyncio.QueueFull:
                # Drop if consumer is slow
                pass


_bus = InProcessEventBus()


def _event_envelope(event_type: str, payload: Dict[str, Any], correlation_id: Optional[str] = None) -> Dict[str, Any]:
    return {
        "type": event_type,
        "payload": payload,
        "timestamp": _now_utc().isoformat(),
        "correlation_id": correlation_id or str(uuid4()),
    }


async def _redis_publish_safe(redis: Any, channel: str, payload: dict[str, Any]) -> bool:
    if redis is None:
        return False
    try:
        msg = json.dumps(payload, default=str)
        await redis.publish(channel, msg)
        return True
    except Exception as exc:
        log.warning(
            "redis_publish_failed",
            engine_name="realtime_service",
            decision="fallback",
            reason_code="REDIS_DOWN",
            error=str(exc),
            channel=channel,
        )
        return False


async def publish_claim_update(
    *,
    redis: Any,
    worker_id: int,
    claim_id: Any,
    status: str,
    message: str,
    payout_amount: Optional[float] = None,
    zone_id: Optional[str] = None,
    disruption_type: Optional[str] = None,
    confidence_level: Optional[str] = None,
    fraud_score: Optional[float] = None,
    correlation_id: Optional[str] = None,
    fraud_flags: Optional[list[str]] = None,
    payout_breakdown: Optional[Any] = None,
    disruption_hours: Optional[float] = None,
    daily_coverage: Optional[float] = None,
) -> None:
    channel_personal = f"claim_updates:{worker_id}"
    payload_data: Dict[str, Any] = {
        "worker_id": worker_id,
        "claim_id": claim_id,
        "zone_id": zone_id,
        "disruption_type": disruption_type,
        "confidence_level": confidence_level,
        "fraud_score": fraud_score,
        "status": status,
        "message": message,
        "payout_amount": payout_amount,
        "event_epoch_ms": int(time.time() * 1000),
    }
    if fraud_flags is not None:
        payload_data["fraud_flags"] = fraud_flags
    if payout_breakdown is not None:
        payload_data["payout_breakdown"] = payout_breakdown
    if disruption_hours is not None:
        payload_data["disruption_hours"] = disruption_hours
    if daily_coverage is not None:
        payload_data["daily_coverage"] = daily_coverage
    payload = _event_envelope("CLAIM_UPDATE", payload_data, correlation_id=correlation_id)

    ok_personal = await _redis_publish_safe(redis, channel_personal, payload)
    ok_feed = await _redis_publish_safe(redis, "all_claims_feed", payload)

    if not ok_personal:
        await _bus.publish(channel_personal, payload)
    if not ok_feed:
        await _bus.publish("all_claims_feed", payload)


async def publish_fraud_alert(
    *,
    redis: Any,
    cluster_id: str,
    ring_confidence: str,
    worker_ids: list[int],
    zone_id: str,
    correlation_id: Optional[str] = None,
) -> None:
    channel = "fraud_alerts"
    payload_data: Dict[str, Any] = {
        "cluster_id": cluster_id,
        "ring_confidence": ring_confidence,
        "worker_ids": worker_ids,
        "zone_id": zone_id,
        "event_epoch_ms": int(time.time() * 1000),
    }
    payload = _event_envelope("FRAUD_ALERT", payload_data, correlation_id=correlation_id)

    ok = await _redis_publish_safe(redis, channel, payload)
    if not ok:
        await _bus.publish(channel, payload)


async def publish_disruption_alert(
    *,
    redis: Any,
    zone_id: str,
    disruption_type: str,
    affected_workers: list[int],
    correlation_id: Optional[str] = None,
) -> None:
    """
    Broadcast a disruption warning to each worker's claim channel before claim processing,
    and mirror a ZONE_EVENT to the admin feed so operators see the same timeline.
    """
    payload_worker: Dict[str, Any] = {
        "zone_id": zone_id,
        "disruption_type": disruption_type,
        "event_type": "DISRUPTION_ALERT",
        "countdown_seconds": None,
        "affected_workers": affected_workers,
        "event_epoch_ms": int(time.time() * 1000),
    }
    env = _event_envelope("DISRUPTION_ALERT", payload_worker, correlation_id=correlation_id)
    for wid in affected_workers:
        ch = f"claim_updates:{wid}"
        ok = await _redis_publish_safe(redis, ch, env)
        if not ok:
            await _bus.publish(ch, env)

    await publish_zone_event(
        redis=redis,
        zone_id=zone_id,
        event_type="DISRUPTION_ALERT",
        details={
            "disruption_type": disruption_type,
            "affected_workers": affected_workers,
        },
        correlation_id=correlation_id,
    )


async def publish_zone_event(
    *,
    redis: Any,
    zone_id: str,
    event_type: str,
    details: Dict[str, Any],
    correlation_id: Optional[str] = None,
) -> None:
    channel = "zone_events"
    payload_data: Dict[str, Any] = {
        "zone_id": zone_id,
        "event_type": event_type,
        "details": details,
        "event_epoch_ms": int(time.time() * 1000),
    }
    payload = _event_envelope("ZONE_EVENT", payload_data, correlation_id=correlation_id)

    ok = await _redis_publish_safe(redis, channel, payload)
    if not ok:
        await _bus.publish(channel, payload)


async def publish_pool_health(
    *,
    redis: Any,
    zone_id: str,
    balance: float,
    utilization_pct: float,
    risk_level: str,
    correlation_id: Optional[str] = None,
) -> None:
    channel = "pool_health"
    payload_data: Dict[str, Any] = {
        "zone_id": zone_id,
        "balance": balance,
        "utilization_pct": utilization_pct,
        "risk_level": risk_level,
        "event_epoch_ms": int(time.time() * 1000),
    }
    payload = _event_envelope("POOL_UPDATE", payload_data, correlation_id=correlation_id)

    ok = await _redis_publish_safe(redis, channel, payload)
    if not ok:
        await _bus.publish(channel, payload)


async def publish_payout_credited(
    *,
    redis: Any,
    worker_id: int,
    claim_id: Any,
    payout_amount: float,
    message: str,
    zone_id: Optional[str] = None,
    disruption_type: Optional[str] = None,
    correlation_id: Optional[str] = None,
) -> None:
    channel_personal = f"claim_updates:{worker_id}"
    payload_data: Dict[str, Any] = {
        "worker_id": worker_id,
        "claim_id": claim_id,
        "payout_amount": payout_amount,
        "message": message,
        "zone_id": zone_id,
        "disruption_type": disruption_type,
        "event_epoch_ms": int(time.time() * 1000),
    }
    payload = _event_envelope("PAYOUT_CREDITED", payload_data, correlation_id=correlation_id)

    ok_personal = await _redis_publish_safe(redis, channel_personal, payload)
    ok_feed = await _redis_publish_safe(redis, "all_claims_feed", payload)
    if not ok_personal:
        await _bus.publish(channel_personal, payload)
    if not ok_feed:
        await _bus.publish("all_claims_feed", payload)


async def subscribe_channel(
    redis: Any,
    channel: str,
) -> Tuple[Optional[Any], asyncio.Queue[Any], Optional[asyncio.Queue[Any]], Optional[asyncio.Task[Any]]]:
    """
    Returns (pubsub, queue).
    - If Redis is available, pubsub is created and a Redis reader should forward messages into queue.
    - If Redis is down, pubsub is None and queue is backed by in-process bus.
    """
    q: asyncio.Queue[Any] = asyncio.Queue()
    if redis is None:
        bus_q = await _bus.subscribe(channel)

        async def _bus_forward() -> None:
            while True:
                msg = await bus_q.get()
                await q.put(msg)

        forward_task: asyncio.Task[Any] = asyncio.create_task(_bus_forward())
        return None, q, bus_q, forward_task

    try:
        pubsub = redis.pubsub(ignore_subscribe_messages=True)
        return pubsub, q, None, None
    except Exception as exc:
        log.warning(
            "redis_pubsub_create_failed",
            engine_name="realtime_service",
            decision="fallback",
            reason_code="REDIS_ERROR",
            error=str(exc),
            channel=channel,
        )
        bus_q = await _bus.subscribe(channel)

        async def _bus_forward() -> None:
            while True:
                msg = await bus_q.get()
                await q.put(msg)

        forward_task: asyncio.Task[Any] = asyncio.create_task(_bus_forward())
        return None, q, bus_q, forward_task


async def unsubscribe_channel(
    redis: Any,
    channel: str,
    pubsub: Optional[Any],
    bus_queue: Optional[asyncio.Queue[Any]] = None,
    forward_task: Optional[asyncio.Task[Any]] = None,
) -> None:
    if forward_task is not None:
        forward_task.cancel()
    if pubsub is not None:
        try:
            await pubsub.unsubscribe(channel)
            await pubsub.close()
        except Exception:
            pass
    if bus_queue is not None:
        await _bus.unsubscribe(channel, bus_queue)


# Public singleton for workers/admin consumers that need in-process subscriptions.
in_process_bus = _bus

