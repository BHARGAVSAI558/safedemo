import asyncio

from app.db.session import _seed_local_dataset, _seed_zones, init_db


async def main() -> None:
    await init_db()
    await _seed_zones()
    await _seed_local_dataset()
    print("SafeNet seed completed.")


if __name__ == "__main__":
    asyncio.run(main())
