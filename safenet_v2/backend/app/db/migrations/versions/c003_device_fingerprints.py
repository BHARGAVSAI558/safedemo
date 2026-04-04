"""Add device_fingerprints table.

Revision ID: c003
Revises: c002
Create Date: 2026-03-31
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "c003"
down_revision: Union[str, None] = "c002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "device_fingerprints",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("worker_id", sa.Integer(), nullable=False, unique=True),
        sa.Column("fingerprint_hash", sa.String(length=128), nullable=False),
        sa.Column("model_name", sa.String(length=128), nullable=True),
        sa.Column("os_version", sa.String(length=64), nullable=True),
        sa.Column("platform_api_level", sa.Integer(), nullable=True),
        sa.Column("screen_width", sa.Integer(), nullable=True),
        sa.Column("screen_height", sa.Integer(), nullable=True),
        sa.Column("app_version", sa.String(length=64), nullable=True),
        sa.Column("network_type_at_enrollment", sa.String(length=32), nullable=True),
        sa.Column("battery_level", sa.Float(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_device_fingerprints_worker_id", "device_fingerprints", ["worker_id"], unique=True)


def downgrade() -> None:
    op.drop_index("ix_device_fingerprints_worker_id", table_name="device_fingerprints")
    op.drop_table("device_fingerprints")

