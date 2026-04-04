from __future__ import annotations

from typing import Any, Optional

from motor.motor_asyncio import AsyncIOMotorClient, AsyncIOMotorDatabase

from app.core.config import settings

_client: Optional[AsyncIOMotorClient] = None


def get_mongo_client() -> Optional[AsyncIOMotorClient]:
    return _client


async def connect_mongo() -> Optional[AsyncIOMotorDatabase]:
    global _client
    uri = getattr(settings, "MONGODB_URI", "") or ""
    if not uri.strip():
        return None
    try:
        _client = AsyncIOMotorClient(uri, serverSelectionTimeoutMS=5000)
        await _client.admin.command("ping")
        db = _client[getattr(settings, "MONGODB_DB_NAME", "safenet")]
        await ensure_fraud_indexes(db)
        return db
    except Exception:
        _client = None
        return None


async def disconnect_mongo() -> None:
    global _client
    if _client is not None:
        _client.close()
        _client = None


async def save_confidence_document(db: AsyncIOMotorDatabase, doc: dict[str, Any]) -> None:
    await db["confidence_scores"].insert_one(doc)


async def save_fraud_decision(db: AsyncIOMotorDatabase, doc: dict[str, Any]) -> None:
    await db["fraud_decisions"].insert_one(doc)


async def ensure_fraud_indexes(db: AsyncIOMotorDatabase) -> None:
    await db["fraud_decisions"].create_index(
        [("claim_id", 1), ("worker_id", 1), ("created_at", -1)],
        name="claim_worker_created",
    )
