"""Alias migration for Alembic discovery.

Revision ID: c002
Revises: c001
"""

from app.db.migrations.versions.c002_perf_security_indexes import downgrade, upgrade

revision = "c002"
down_revision = "c001"
branch_labels = None
depends_on = None

