from functools import lru_cache
from typing import List, Optional

from pydantic import AliasChoices, Field, computed_field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    APP_NAME: str = "SafeNet"
    APP_VERSION: str = "1.0.0"
    DEBUG: bool = False
    DEMO_MODE: bool = True

    ALLOWED_ORIGINS: str = "*"

    # SQLite fallback so the app starts without a Postgres instance
    DATABASE_URL: str = "sqlite+aiosqlite:///./safenet_demo.db"

    # Optional — None disables Redis; cache_service already guards for None
    REDIS_URL: Optional[str] = None

    JWT_SECRET: str = Field(
        default="safenet-demo-secret-2026-changeme",
        validation_alias=AliasChoices("JWT_SECRET", "JWT_SECRET_KEY"),
    )
    JWT_ALGORITHM: str = "HS256"
    JWT_EXPIRY_MINUTES: int = Field(
        default=60,
        validation_alias=AliasChoices("JWT_EXPIRY_MINUTES", "ACCESS_TOKEN_EXPIRE_MINUTES"),
    )
    REFRESH_TOKEN_EXPIRE_DAYS: int = 7
    ACCESS_TOKEN_EXPIRE_HOURS: int = 4
    ADMIN_ACCESS_TOKEN_EXPIRE_HOURS: int = 1

    ADMIN_JWT_SECRET: str = Field(
        default="safenet-admin-secret-2026",
        validation_alias=AliasChoices("ADMIN_JWT_SECRET", "ADMIN_JWT"),
    )
    ADMIN_JWT_PRIVATE_KEY: str = ""
    ADMIN_JWT_PUBLIC_KEY: str = ""
    ADMIN_JWT_ALGORITHM: str = "RS256"

    TWILIO_ACCOUNT_SID: str = ""
    TWILIO_AUTH_TOKEN: str = ""
    TWILIO_PHONE: str = ""

    OPENWEATHER_API_KEY: str = ""
    WEATHERAPI_KEY: str = ""
    OPENAQ_API_KEY: str = ""
    OPENAQ_LOCATION_ID: str = ""

    RAZORPAY_KEY_ID: str = ""
    RAZORPAY_KEY_SECRET: str = ""

    FIREBASE_CREDENTIALS_PATH: str = ""

    # Optional — None disables Mongo writes silently
    MONGODB_URI: Optional[str] = None
    MONGODB_DB_NAME: str = "safenet"
    GOVERNMENT_ALERTS_SEED_PATH: str = ""

    @computed_field
    @property
    def origins(self) -> List[str]:
        raw = self.ALLOWED_ORIGINS.strip()
        if raw == "*":
            return ["*"]
        return [o.strip() for o in raw.split(",") if o.strip()]

    @computed_field
    @property
    def async_database_url(self) -> str:
        u = self.DATABASE_URL
        if u.startswith("sqlite"):
            # Ensure aiosqlite driver is specified
            if "+aiosqlite" not in u:
                u = u.replace("sqlite://", "sqlite+aiosqlite://", 1)
            return u
        if "+asyncpg" in u:
            return u
        if u.startswith("postgresql+psycopg2://"):
            return u.replace("postgresql+psycopg2://", "postgresql+asyncpg://", 1)
        if u.startswith("postgresql://"):
            return u.replace("postgresql://", "postgresql+asyncpg://", 1)
        if u.startswith("postgres://"):
            return u.replace("postgres://", "postgresql+asyncpg://", 1)
        return u

    @computed_field
    @property
    def is_sqlite(self) -> bool:
        return self.DATABASE_URL.startswith("sqlite")

    @computed_field
    @property
    def admin_jwt_signing_secret(self) -> str:
        return self.ADMIN_JWT_SECRET or self.JWT_SECRET


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
