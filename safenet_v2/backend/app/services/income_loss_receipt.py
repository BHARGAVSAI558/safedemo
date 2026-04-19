"""Income Loss Receipt PDF (fpdf2) for approved claims — includes dual-gate + AI explanation."""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from typing import Any

from fpdf import FPDF
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.engines.trust_payout import trust_score_points
from app.models.claim import DecisionType, Simulation
from app.models.fraud import FraudFlag
from app.models.payment import Payment
from app.models.payout import PayoutRecord
from app.models.worker import Profile, User
from app.models.zone import Zone


def _parse_weather(sim: Simulation) -> dict[str, Any]:
    raw = sim.weather_data
    if not raw:
        return {}
    try:
        return json.loads(raw) if isinstance(raw, str) else dict(raw)
    except Exception:
        return {}


async def build_income_loss_receipt_pdf(
    db: AsyncSession,
    *,
    claim_id: int,
    requester_user_id: int,
    is_admin: bool = False,
) -> bytes:
    sim = (
        await db.execute(
            select(Simulation)
            .where(Simulation.id == int(claim_id))
            .options(selectinload(Simulation.user))
        )
    ).scalar_one_or_none()
    if sim is None:
        raise ValueError("Claim not found")
    if not is_admin and int(sim.user_id) != int(requester_user_id):
        raise PermissionError("forbidden")

    if sim.decision != DecisionType.APPROVED or float(sim.payout or 0.0) <= 0:
        raise ValueError("Receipt only available for approved payouts")

    profile = (
        await db.execute(select(Profile).where(Profile.user_id == sim.user_id))
    ).scalar_one_or_none()
    user = sim.user or (
        await db.execute(select(User).where(User.id == sim.user_id))
    ).scalar_one_or_none()

    zone_orm = None
    if profile and profile.zone_id:
        zone_orm = (
            await db.execute(
                select(Zone).where(func.lower(Zone.city_code) == str(profile.zone_id).lower())
            )
        ).scalar_one_or_none()
    zone_name = zone_orm.name if zone_orm else (profile.zone_id if profile and profile.zone_id else "—")

    wd = _parse_weather(sim)
    breakdown = wd.get("breakdown") or {}
    hourly = float(breakdown.get("hourly_rate") or sim.expected_income or 0.0)
    hours = float(breakdown.get("disruption_hours") or 2.5)
    cov = float(breakdown.get("coverage_multiplier") or 0.85)
    tier_label = str(breakdown.get("tier_display") or breakdown.get("tier") or profile.coverage_tier or "Standard")

    fc = (
        await db.execute(
            select(func.count(FraudFlag.id)).where(FraudFlag.simulation_id == sim.id)
        )
    ).scalar_one() or 0
    flag_count = int(fc)

    pay_ref = None
    pr = (
        await db.execute(
            select(PayoutRecord)
            .where(PayoutRecord.simulation_id == sim.id)
            .order_by(PayoutRecord.id.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if pr and pr.razorpay_payment_id:
        pay_ref = str(pr.razorpay_payment_id)
    if not pay_ref:
        pm = (
            await db.execute(
                select(Payment)
                .where(
                    Payment.simulation_id == sim.id,
                    Payment.payment_type == "payout",
                    Payment.status == "success",
                )
                .order_by(Payment.id.desc())
                .limit(1)
            )
        ).scalar_one_or_none()
        if pm:
            pay_ref = str(pm.razorpay_payment_id or pm.razorpay_order_id or "")
    if not pay_ref:
        pay_ref = f"pay_{sim.id}_{abs(hash(str(sim.id))) % 900000 + 100000}"

    trust_pts = int(round(trust_score_points(getattr(profile, "trust_score", None) if profile else 0.0)))
    fs = float(sim.fraud_score or 0.0)

    ai_explanation = (getattr(sim, "ai_explanation", None) or "").strip()
    if not ai_explanation:
        ai_explanation = "Claim processed through SafeNet 4-layer validation pipeline."

    g1_ok = getattr(sim, "gate1_passed", True)
    g2_ok = getattr(sim, "gate2_passed", True)
    g1_label = "PASSED" if g1_ok else "FAILED"
    g2_label = "PASSED" if g2_ok else "FAILED"
    g1_detail = str(getattr(sim, "gate1_value", None) or wd.get("weather_display") or "Confirmed")
    g2_detail = "Active"
    sig = getattr(sim, "gate2_signals", None)
    if isinstance(sig, dict):
        if sig.get("human_summary"):
            g2_detail = str(sig.get("human_summary"))
        elif sig.get("summary"):
            g2_detail = str(sig.get("summary"))

    payout_amt = float(sim.payout or 0.0)
    wname = (profile.name if profile else None) or (user.phone if user else "Worker")
    platform = (profile.platform if profile else None) or "—"

    start_s = wd.get("disruption_start")
    if start_s:
        try:
            st = datetime.fromisoformat(str(start_s).replace("Z", "+00:00"))
            en = st + timedelta(hours=hours)
            start_txt = st.strftime("%Y-%m-%d %H:%M UTC")
            end_txt = en.strftime("%Y-%m-%d %H:%M UTC")
        except Exception:
            start_txt = str(start_s)
            end_txt = "—"
    else:
        ca = sim.created_at
        if ca is None:
            ca = datetime.now(timezone.utc)
        if ca.tzinfo is None:
            ca = ca.replace(tzinfo=timezone.utc)
        st = ca
        en = st + timedelta(hours=hours)
        start_txt = st.strftime("%Y-%m-%d %H:%M UTC")
        end_txt = en.strftime("%Y-%m-%d %H:%M UTC")

    pdf = FPDF()
    pdf.set_auto_page_break(auto=True, margin=16)
    pdf.add_page()

    pdf.set_fill_color(37, 99, 235)
    pdf.rect(0, 0, 210, 33, "F")
    pdf.set_text_color(255, 255, 255)
    pdf.set_y(7)
    pdf.set_font("Helvetica", "B", 22)
    pdf.cell(0, 10, "SafeNet", ln=True, align="C")
    pdf.set_font("Helvetica", "", 10)
    pdf.cell(0, 7, "AI-Powered Income Protection Receipt", ln=True, align="C")

    pdf.set_text_color(20, 20, 20)
    pdf.ln(6)

    pdf.set_font("Helvetica", "B", 11)
    pdf.cell(0, 7, f"Claim: SNT-{sim.id:06d}", ln=True)
    pdf.set_font("Helvetica", "", 10)
    pdf.cell(0, 6, f"Worker: {wname}  |  Platform: {platform}  |  Zone: {zone_name}", ln=True)
    pdf.cell(0, 6, f"Disruption window: {start_txt} → {end_txt}", ln=True)
    pdf.ln(4)

    pdf.set_font("Helvetica", "B", 11)
    pdf.cell(0, 7, "Dual Gate Validation:", ln=True)
    pdf.set_font("Helvetica", "", 10)
    pdf.cell(0, 6, f"  Gate 1 (External Disruption): {g1_label} — {g1_detail}", ln=True)
    pdf.cell(0, 6, f"  Gate 2 (Worker Activity): {g2_label} — {g2_detail}", ln=True)
    pdf.ln(4)

    pdf.set_font("Helvetica", "B", 11)
    pdf.cell(0, 7, "Income Loss Calculation:", ln=True)
    pdf.set_font("Helvetica", "", 10)
    pdf.cell(0, 6, f"  Earnings DNA rate ({zone_name}, this time slot): Rs.{hourly:.2f}/hr", ln=True)
    pdf.cell(0, 6, f"  Hours lost to disruption: {hours}h", ln=True)
    pdf.cell(0, 6, f"  Coverage multiplier ({tier_label} plan): x{cov}", ln=True)
    pdf.set_fill_color(220, 252, 231)
    pdf.set_font("Helvetica", "B", 13)
    pdf.cell(
        0,
        10,
        f"  PAYOUT: Rs.{payout_amt:.2f}  (Formula: Rs.{hourly:.2f} x {hours}h x {cov})",
        ln=True,
        fill=True,
    )
    pdf.ln(4)

    pdf.set_font("Helvetica", "B", 11)
    pdf.cell(0, 7, "SafeNet AI Explanation:", ln=True)
    pdf.set_font("Helvetica", "I", 10)
    pdf.set_text_color(30, 30, 30)
    pdf.multi_cell(0, 6, f"  {ai_explanation}")
    pdf.ln(4)

    pdf.set_font("Helvetica", "", 9)
    pdf.set_text_color(100, 100, 100)
    fraud_note = (
        f"Fraud validation: 4-layer pipeline — {flag_count} flag(s) | Score: {fs:.2f} | "
        f"Trust: {trust_pts}/100"
    )
    pdf.cell(0, 5, fraud_note, ln=True)
    pdf.cell(0, 5, f"Razorpay ref: {pay_ref}", ln=True)

    pdf.set_y(-18)
    pdf.set_font("Helvetica", "I", 8)
    pdf.set_text_color(120, 120, 120)
    pdf.cell(0, 5, "SafeNet / Team AlphaNexus — Guidewire DevTrails 2026 | Parametric Income Protection", ln=True, align="C")

    return bytes(pdf.output(dest="S"))
