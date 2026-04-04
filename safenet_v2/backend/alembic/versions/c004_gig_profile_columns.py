"""Alias migration for Alembic discovery.

Revision ID: c004
Revises: c003
"""

from app.db.migrations.versions.c004_gig_profile_columns import downgrade, upgrade

revision = "c004"
down_revision = "c003"
branch_labels = None
depends_on = None
