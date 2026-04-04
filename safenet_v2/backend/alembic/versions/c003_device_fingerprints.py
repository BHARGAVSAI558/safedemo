"""Alias migration for Alembic discovery.

Revision ID: c003
Revises: c002
"""

from app.db.migrations.versions.c003_device_fingerprints import downgrade, upgrade

revision = "c003"
down_revision = "c002"
branch_labels = None
depends_on = None

