import asyncio
import json
from typing import Any, Dict, Optional

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect

from app.core.security import verify_admin_token, verify_token
from app.core.ws_manager import ws_manager
from app.services.realtime_service import subscribe_channel, unsubscribe_channel
from app.utils.logger import get_logger

log = get_logger(__name__)
router = APIRouter()


async def _try_parse_json(data: Any) -> Any:
    if isinstance(data, (bytes, bytearray)):
        try:
            data = data.decode("utf-8")
        except Exception:
            return {"raw": data}
    if isinstance(data, str):
        try:
            return json.loads(data)
        except Exception:
            return {"raw": data}
    return data


async def _redis_listener(pubsub: Any, channel: str, out_q: asyncio.Queue[Any]) -> None:
    async for msg in pubsub.listen():
        if msg is None:
            continue
        if msg.get("type") != "message":
            continue
        data = msg.get("data")
        parsed = await _try_parse_json(data)
        await out_q.put(parsed)


@router.websocket("/ws/claims/{worker_id}")
async def worker_ws(
    websocket: WebSocket,
    worker_id: int,
    token: str = Query(..., description="Bearer access token"),
):
    # Verify JWT
    payload = verify_token(token, token_type="access")
    jwt_user_id = int(payload.get("user_id"))
    if jwt_user_id != worker_id:
        await websocket.close(code=4401)
        return

    await ws_manager.connect(worker_id, websocket)

    redis = getattr(websocket.app.state, "redis", None)
    channel = f"claim_updates:{worker_id}"
    pubsub: Optional[Any] = None
    bus_queue: Optional[asyncio.Queue[Any]] = None
    forward_task: Optional[asyncio.Task[Any]] = None
    out_q: asyncio.Queue[Any] = asyncio.Queue()
    redis_listener_task: Optional[asyncio.Task[None]] = None
    sender_task: Optional[asyncio.Task[None]] = None
    receiver_task: Optional[asyncio.Task[None]] = None
    heartbeat_task: Optional[asyncio.Task[None]] = None

    pong_event = asyncio.Event()
    disconnected = False

    try:
        pubsub, out_q, bus_queue, forward_task = await subscribe_channel(redis, channel)
        if pubsub is not None:
            await pubsub.subscribe(channel)
            redis_listener_task = asyncio.create_task(_redis_listener(pubsub, channel, out_q))

        async def sender_loop() -> None:
            while True:
                msg = await out_q.get()
                try:
                    await websocket.send_json(msg)
                finally:
                    out_q.task_done()

        sender_task = asyncio.create_task(sender_loop())

        async def receiver_loop() -> None:
            while True:
                msg = await websocket.receive()
                if msg.get("type") == "websocket.disconnect":
                    raise WebSocketDisconnect()
                text = msg.get("text")
                if not text:
                    continue
                if str(text).strip().upper() == "PONG":
                    pong_event.set()
                    continue
                try:
                    obj = json.loads(text)
                except Exception:
                    continue
                if obj.get("type") == "PONG":
                    pong_event.set()

        receiver_task = asyncio.create_task(receiver_loop())

        async def heartbeat_loop() -> None:
            while True:
                pong_event.clear()
                await websocket.send_json({"type": "PING"})
                try:
                    await asyncio.wait_for(pong_event.wait(), timeout=10.0)
                except asyncio.TimeoutError:
                    await websocket.close(code=1011)
                    return
                await asyncio.sleep(30.0)

        heartbeat_task = asyncio.create_task(heartbeat_loop())

        await receiver_task
    except WebSocketDisconnect:
        disconnected = True
    except Exception as exc:
        disconnected = True
        log.warning(
            "ws_worker_error",
            engine_name="websockets",
            reason_code="WORKER_WS_ERROR",
            error=str(exc),
            worker_id=worker_id,
        )
    finally:
        for t in (heartbeat_task, sender_task, redis_listener_task, receiver_task):
            if t is not None:
                t.cancel()
        try:
            await unsubscribe_channel(redis, channel, pubsub, bus_queue, forward_task)
        except Exception:
            pass
        await ws_manager.disconnect(worker_id)
        log.info(
            "ws_worker_disconnected",
            engine_name="websockets",
            decision=str(disconnected),
            reason_code="WS_CLOSED",
            worker_id=worker_id,
        )


@router.websocket("/ws/admin/feed")
async def admin_ws(
    websocket: WebSocket,
    token: str = Query(..., description="Admin JWT"),
):
    _ = verify_admin_token(token)

    await websocket.accept()

    redis = getattr(websocket.app.state, "redis", None)
    channels = ["all_claims_feed", "fraud_alerts", "zone_events", "pool_health"]

    admin_q: asyncio.Queue[Dict[str, Any]] = asyncio.Queue()
    tasks: list[asyncio.Task[Any]] = []
    sub_state: list[tuple[str, Optional[Any], Optional[asyncio.Queue[Any]], Optional[asyncio.Task[Any]]]] = []

    try:
        # Subscribe each channel and multiplex into `admin_q`
        for ch in channels:
            pubsub, q, bus_queue, forward_task = await subscribe_channel(redis, ch)
            if pubsub is not None:
                await pubsub.subscribe(ch)
                tasks.append(asyncio.create_task(_redis_listener(pubsub, ch, q)))
            tasks.append(asyncio.create_task(_queue_tag_forwarder(ch, q, admin_q)))
            sub_state.append((ch, pubsub, bus_queue, forward_task))

        while True:
            payload = await admin_q.get()
            try:
                await websocket.send_json(payload)
            finally:
                admin_q.task_done()
    except WebSocketDisconnect:
        return
    except Exception as exc:
        log.warning(
            "ws_admin_error",
            engine_name="websockets",
            reason_code="ADMIN_WS_ERROR",
            error=str(exc),
        )
    finally:
        for t in tasks:
            t.cancel()
        for ch, pubsub, bus_queue, forward_task in sub_state:
            try:
                await unsubscribe_channel(redis, ch, pubsub, bus_queue, forward_task)
            except Exception:
                pass
        try:
            await websocket.close()
        except Exception:
            pass


async def _queue_tag_forwarder(channel_name: str, src_q: asyncio.Queue[Any], out_q: asyncio.Queue[Dict[str, Any]]) -> None:
    while True:
        msg = await src_q.get()
        try:
            await out_q.put({"channel": channel_name, "payload": msg})
        finally:
            src_q.task_done()


async def _bus_tag_forwarder(channel_name: str, src_q: asyncio.Queue[Any], out_q: asyncio.Queue[Dict[str, Any]]) -> None:
    # src_q already receives bus messages
    await _queue_tag_forwarder(channel_name, src_q, out_q)

