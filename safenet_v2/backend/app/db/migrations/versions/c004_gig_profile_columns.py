"""Add gig onboarding columns to profiles.

Revision ID: c004
Revises: c003
Create Date: 2026-04-03
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "c004"
down_revision: Union[str, None] = "c003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("profiles", sa.Column("platform", sa.String(length=32), nullable=True))
    op.add_column("profiles", sa.Column("zone_id", sa.String(length=64), nullable=True))
    op.add_column("profiles", sa.Column("working_hours_preset", sa.String(length=64), nullable=True))
    op.add_column("profiles", sa.Column("coverage_tier", sa.String(length=32), nullable=True))


def downgrade() -> None:
    op.drop_column("profiles", "coverage_tier")
    op.drop_column("profiles", "working_hours_preset")
    op.drop_column("profiles", "zone_id")
    op.drop_column("profiles", "platform")
