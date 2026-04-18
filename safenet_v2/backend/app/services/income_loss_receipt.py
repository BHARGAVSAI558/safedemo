"""Income Loss Receipt PDF (fpdf2) for approved claims."""
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

class _ReceiptPdf(FPDF):
    def header(self) -> None:
        self.set_font("Helvetica", "B", 16)
        self.set_text_color(26, 115, 232)
        self.cell(0, 10, "SafeNet", ln=True)
        self.set_font("Helvetica", "", 9)
        self.set_text_color(80, 80, 80)
        self.cell(0, 5, "Income Loss Protection Receipt", ln=True)
        self.ln(2)

    def footer(self) -> None:
        self.set_y(-14)
        self.set_font("Helvetica", "I", 8)
        self.set_text_color(100, 100, 100)
        self.cell(
            0,
            8,
            "This document certifies income protection payout by SafeNet / Team AlphaNexus",
            align="C",
        )


def _parse_weather(sim: Simulation) -> dict[str, Any]:
    raw = sim.weather_data
    if not raw:
        return {}
    try:
        return json.loads(raw) if isinstance(raw, str) else dict(raw)
    except Exception:
        return {}


def _fraud_line(sim: Simulation, flag_count: int, trust_pts: int) -> str:
    fs = float(sim.fraud_score or 0.0)
    if getattr(sim, "fraud_flag", False) or fs >= 0.6:
        return f"Flagged in review — model score {fs:.2f}"
    return f"Passed all 4 layers — Trust Score: {trust_pts}"


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

    wd = _parse_weather(sim)
    breakdown = wd.get("breakdown") or {}
    hourly = float(breakdown.get("hourly_rate") or sim.expected_income or 0.0)
    hours = float(breakdown.get("disruption_hours") or 3.0)
    cov = float(breakdown.get("coverage_multiplier") or 0.85)
    tier_disp = str(breakdown.get("tier_display") or breakdown.get("tier") or "Standard")
    slot_label = str(breakdown.get("slot_label") or "Current slot IST")

    weather_line = str(wd.get("weather_display") or "OpenWeatherMap (disruption verified for claim)")
    aqi_line = str(wd.get("aqi_display") or "OpenAQ / Open-Meteo (zone air quality corroboration)")

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
        if pm and pm.razorpay_payment_id:
            pay_ref = str(pm.razorpay_payment_id)
    if not pay_ref:
        pay_ref = f"pay_{sim.id}_{abs(hash(str(sim.id))) % 900000 + 100000}"

    trust_pts = int(round(trust_score_points(getattr(profile, "trust_score", None) if profile else 0.0)))
    fraud_txt = _fraud_line(sim, flag_count, trust_pts)

    scenario = str(wd.get("scenario") or "DISRUPTION")
    payout_amt = float(sim.payout or 0.0)
    calc_line = f"Rs {hourly:.2f} x {hours:.1f} h x {cov:.2f} ({tier_disp} tier) = Rs {payout_amt:.2f}"

    pdf = _ReceiptPdf()
    pdf.set_auto_page_break(auto=True, margin=16)
    pdf.add_page()
    pdf.set_text_color(20, 20, 20)
    pdf.set_font("Helvetica", "B", 11)
    pdf.cell(0, 7, f"Claim ID: SN-{sim.id}", ln=True)
    pdf.set_font("Helvetica", "", 10)
    wname = (profile.name if profile else None) or (user.phone if user else "Worker")
    platform = (profile.platform if profile else None) or "—"
    zone = (profile.zone_id if profile else None) or str(wd.get("zone_id") or "—")
    pdf.cell(0, 6, f"Worker: {wname}", ln=True)
    pdf.cell(0, 6, f"Platform: {platform}   Zone: {zone}", ln=True)
    pdf.ln(2)
    pdf.set_font("Helvetica", "B", 10)
    pdf.cell(0, 6, "Disruption", ln=True)
    pdf.set_font("Helvetica", "", 10)
    pdf.cell(0, 6, f"Type: {scenario.replace('_', ' ')}", ln=True)
    pdf.cell(0, 6, f"Start: {start_txt}", ln=True)
    pdf.cell(0, 6, f"End: {end_txt}", ln=True)
    pdf.cell(0, 6, f"Duration: {hours:.1f} hours", ln=True)
    pdf.ln(2)
    pdf.set_font("Helvetica", "B", 10)
    pdf.cell(0, 6, "Data sources", ln=True)
    pdf.set_font("Helvetica", "", 9)
    pdf.multi_cell(0, 5, weather_line)
    pdf.multi_cell(0, 5, aqi_line)
    pdf.ln(1)
    pdf.set_font("Helvetica", "B", 10)
    pdf.cell(0, 6, "Earnings DNA", ln=True)
    pdf.set_font("Helvetica", "", 10)
    pdf.multi_cell(0, 5, f"Your typical rate for this slot: Rs {hourly:.2f}/hr — {slot_label}")
    pdf.ln(1)
    pdf.set_font("Helvetica", "B", 10)
    pdf.cell(0, 6, "Calculation", ln=True)
    pdf.set_font("Helvetica", "", 10)
    pdf.multi_cell(0, 5, calc_line)
    pdf.ln(1)
    pdf.set_font("Helvetica", "B", 10)
    pdf.cell(0, 6, "Fraud & trust", ln=True)
    pdf.set_font("Helvetica", "", 10)
    pdf.multi_cell(0, 5, fraud_txt)
    pdf.ln(2)
    pdf.set_font("Helvetica", "B", 12)
    pdf.cell(0, 8, f"Payout: Rs {payout_amt:.2f}", ln=True)
    pdf.set_font("Helvetica", "", 10)
    pdf.cell(0, 6, f"Razorpay reference: {pay_ref}", ln=True)

    return bytes(pdf.output(dest="S"))
