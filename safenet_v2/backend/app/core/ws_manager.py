from __future__ import annotations

from typing import Any, Dict, Optional

from fastapi import WebSocket, WebSocketDisconnect


class ConnectionManager:
    """
    Tracks active worker WebSocket connections.
    Used for direct sends (optional); Redis pub/sub drives the main data flow.
    """

    def __init__(self) -> None:
        self._connections: Dict[int, WebSocket] = {}

    async def connect(self, worker_id: int, websocket: WebSocket) -> None:
        await websocket.accept()
        self._connections[worker_id] = websocket

    async def disconnect(self, worker_id: int) -> None:
        ws: Optional[WebSocket] = self._connections.get(worker_id)
        self._connections.pop(worker_id, None)
        if ws is None:
            return
        try:
            await ws.close()
        except Exception:
            # Connection may already be closed/stale
            pass

    async def send_personal_message(self, worker_id: int, message: Any) -> None:
        ws: Optional[WebSocket] = self._connections.get(worker_id)
        if ws is None:
            return
        try:
            await ws.send_json(message)
        except WebSocketDisconnect:
            self._connections.pop(worker_id, None)
        except Exception:
            # Gracefully drop stale connection
            self._connections.pop(worker_id, None)

    async def broadcast(self, message: Any) -> None:
        for worker_id in list(self._connections.keys()):
            await self.send_personal_message(worker_id, message)


ws_manager = ConnectionManager()