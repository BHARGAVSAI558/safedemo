import asyncio

import asyncpg

from app.core.config import settings


async def main() -> None:
    dsn = settings.async_database_url.replace("postgresql+asyncpg://", "postgresql://", 1)
    conn = await asyncpg.connect(dsn)
    try:
        result = await conn.execute("UPDATE users SET is_admin=TRUE WHERE phone='9963545576'")
        print(result)
    finally:
        await conn.close()


if __name__ == "__main__":
    asyncio.run(main())
