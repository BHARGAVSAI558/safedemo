from functools import lru_cache
from typing import List, Optional

from pydantic import AliasChoices, Field, computed_field, field_validator
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
    DEMO_MODE: bool = False

    # Comma-separated origins for browser clients (admin Vite = http://localhost:5173).
    # On Render, set e.g. ALLOWED_ORIGINS=http://localhost:5173,https://your-admin.example.com
    # Use * alone to allow any origin (no credentials).
    ALLOWED_ORIGINS: str = (
        "http://localhost:3000,"
        "http://localhost:5173,"
        "http://localhost:8081,"
        "http://127.0.0.1:3000,"
        "http://127.0.0.1:5173,"
        "http://127.0.0.1:8081,"
        "exp://127.0.0.1:8081,"
        "exp://localhost:8081"
    )

    # SQLite fallback so the app starts without a Postgres instance
    DATABASE_URL: str = "sqlite+aiosqlite:///./safenet.db"

    # Optional — None disables Redis; cache_service already guards for None
    REDIS_URL: Optional[str] = None

    JWT_SECRET: str = Field(
        default="safenet-dev-secret-2026",
        validation_alias=AliasChoices("JWT_SECRET", "JWT_SECRET_KEY"),
    )
    JWT_ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = Field(
        default=1440,  # 24 hours
        validation_alias=AliasChoices("ACCESS_TOKEN_EXPIRE_MINUTES", "JWT_EXPIRY_MINUTES"),
    )
    REFRESH_TOKEN_EXPIRE_DAYS: int = 7
    ADMIN_ACCESS_TOKEN_EXPIRE_HOURS: int = 1

    # Dashboard login (not worker OTP). Override in production.
    ADMIN_DASHBOARD_USERNAME: str = "admin"
    ADMIN_DASHBOARD_PASSWORD: str = "admin123"
    # Reserved `users.phone` for the synthetic admin row used in JWT `user_id`.
    ADMIN_CONSOLE_PHONE: str = "9000000001"

    ADMIN_JWT_SECRET: str = Field(
        default="admin-dev-secret-2026",
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
    OPENAI_API_KEY: str = ""

    RAZORPAY_KEY_ID: str = ""
    RAZORPAY_KEY_SECRET: str = ""
    RAZORPAY_WEBHOOK_SECRET: str = Field(default="", validation_alias=AliasChoices("RAZORPAY_WEBHOOK_SECRET", "RZP_WEBHOOK_SECRET"))

    FIREBASE_CREDENTIALS_PATH: str = ""

    # Optional — None disables Mongo writes silently
    MONGODB_URI: Optional[str] = None
    MONGODB_DB_NAME: str = "safenet"
    GOVERNMENT_ALERTS_SEED_PATH: str = ""
    ADMIN_API_KEY: str = Field(default="", validation_alias=AliasChoices("ADMIN_API_KEY", "ADMIN_KEY"))

    @field_validator("DEBUG", "DEMO_MODE", mode="before")
    @classmethod
    def _parse_boolish(cls, value: object) -> bool:
        if isinstance(value, bool):
            return value
        raw = str(value or "").strip().lower()
        if raw in {"1", "true", "yes", "on", "debug", "development", "dev"}:
            return True
        if raw in {"0", "false", "no", "off", "release", "prod", "production", ""}:
            return False
        return bool(value)

    @computed_field
    @property
    def origins(self) -> List[str]:
        raw = (self.ALLOWED_ORIGINS or "*").strip()
        if raw == "*" or raw == "":
            return ["*"]
        parts = [o.strip().rstrip("/") for o in raw.split(",") if o.strip()]
        # Empty list (e.g. typo in env) would block all browsers — fall back to *.
        return parts if parts else ["*"]

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
