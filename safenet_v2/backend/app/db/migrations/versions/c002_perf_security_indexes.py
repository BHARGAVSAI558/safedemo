"""Add performance/security indexes and refresh tokens.

Revision ID: c002
Revises: c001
Create Date: 2026-03-31
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "c002"
down_revision: Union[str, None] = "c001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("CREATE INDEX IF NOT EXISTS ix_users_phone_number ON users (phone)")
    op.execute("CREATE INDEX IF NOT EXISTS ix_profiles_zone_id ON profiles (city)")
    op.execute("CREATE INDEX IF NOT EXISTS ix_profiles_trust_score_desc ON profiles (trust_score DESC)")

    op.execute("CREATE INDEX IF NOT EXISTS ix_policies_worker_status_valid ON policies (user_id, status, updated_at DESC)")
    op.execute("CREATE INDEX IF NOT EXISTS ix_sim_worker_status_created ON simulations (user_id, decision, created_at DESC)")
    op.execute("CREATE INDEX IF NOT EXISTS ix_sim_zone_created ON simulations ((COALESCE((weather_data::json->>'zone_id'), 'unknown')), created_at DESC)")
    op.execute("CREATE INDEX IF NOT EXISTS ix_sim_status_created ON simulations (decision, created_at)")
    op.execute("CREATE INDEX IF NOT EXISTS ix_fraud_worker_created ON fraud_signals (user_id, created_at DESC)")

    op.execute("ALTER TABLE fraud_signals ADD COLUMN IF NOT EXISTS cluster_id VARCHAR(128) DEFAULT ''")
    op.execute("CREATE INDEX IF NOT EXISTS ix_fraud_cluster_id ON fraud_signals (cluster_id)")

    op.create_table(
        "refresh_tokens",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("token_jti", sa.String(length=64), nullable=False),
        sa.Column("token_value", sa.String(length=1024), nullable=False),
        sa.Column("used", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
    )
    op.create_index("ix_refresh_tokens_jti", "refresh_tokens", ["token_jti"], unique=True)
    op.create_index("ix_refresh_tokens_user", "refresh_tokens", ["user_id"], unique=False)

    # Avoid non-immutable expression indexes on timestamptz/date conversion.
    op.execute("CREATE INDEX IF NOT EXISTS ix_sim_user_created_at ON simulations (user_id, created_at DESC)")


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_sim_user_created_at")
    op.drop_index("ix_refresh_tokens_user", table_name="refresh_tokens")
    op.drop_index("ix_refresh_tokens_jti", table_name="refresh_tokens")
    op.drop_table("refresh_tokens")
    op.execute("DROP INDEX IF EXISTS ix_fraud_cluster_id")
    op.execute("DROP INDEX IF EXISTS ix_fraud_worker_created")
    op.execute("DROP INDEX IF EXISTS ix_sim_status_created")
    op.execute("DROP INDEX IF EXISTS ix_sim_zone_created")
    op.execute("DROP INDEX IF EXISTS ix_sim_worker_status_created")
    op.execute("DROP INDEX IF EXISTS ix_policies_worker_status_valid")
    op.execute("DROP INDEX IF EXISTS ix_profiles_trust_score_desc")
    op.execute("DROP INDEX IF EXISTS ix_profiles_zone_id")
    op.execute("DROP INDEX IF EXISTS ix_users_phone_number")
