from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.routes.admin import get_admin_user
from app.api.v1.routes.workers import get_current_user
from app.db.session import get_db
from app.models.claim import ClaimLifecycle, DecisionType, Simulation
from app.models.support import SupportQuery
from app.models.worker import User

router = APIRouter()


class SupportQueryBody(BaseModel):
    user_id: str | None = None
    message: str = Field(..., min_length=2, max_length=2000)
    type: str = Field(default="custom")
    language: str = Field(default="en")
    query_key: str | None = None


class SupportReplyBody(BaseModel):
    query_id: int
    admin_reply: str = Field(..., min_length=2, max_length=2000)


def _fallback_system_reply(msg: str) -> str:
    t = msg.lower()
    if "payout" in t:
        return "Payout is based on disruption verification, fraud checks, and your earning fingerprint for that time slot."
    if "claim" in t:
        return "Claim flow is: disruption detected → verification → fraud checks → decision. You can track this in Claims."
    if "weather" in t or "rain" in t:
        return "Weather risk is monitored for your zone continuously. If disruption is verified, SafeNet evaluates payout automatically."
    return "Thanks for reaching out. We logged your query and our team can reply here shortly."


def _support_values(life: ClaimLifecycle | None, sim: Simulation | None) -> dict[str, str]:
    disruption_signal = "Moderate"
    activity_change = "Normal"
    fraud_check = "Clear"
    final_status = "Under review"
    disruption_level = "Low"
    fraud_signals = "No major signals"
    decision = "Pending"
    if life is not None:
        st = str(life.status or "").upper()
        if st in {"VERIFYING", "BEHAVIORAL_CHECK", "FRAUD_CHECK", "REVALIDATING"}:
            disruption_signal, activity_change, final_status = "Detected", "Shifted", "Under review"
            disruption_level = "Moderate"
        elif st in {"APPROVED", "PAYOUT_DONE", "PAYOUT_CREDITED"}:
            disruption_signal, activity_change, final_status = "Strong", "Significant drop", "Approved"
            disruption_level, decision = "High", "Approved"
        elif st in {"REJECTED", "CLAIM_REJECTED", "BLOCKED"}:
            disruption_signal, activity_change, final_status = "Weak", "Near normal", "Rejected"
            disruption_level, decision = "Low", "Rejected"
    if sim is not None:
        dec = str(sim.decision.value if hasattr(sim.decision, "value") else sim.decision).upper()
        if dec == DecisionType.FRAUD.value:
            fraud_check, fraud_signals, decision = "Flagged", "Pattern mismatch", "Fraud blocked"
        elif dec == DecisionType.APPROVED.value:
            fraud_check, fraud_signals, decision = "Clear", "No major signals", "Approved"
        elif dec == DecisionType.REJECTED.value:
            decision = "Rejected"
    return {
        "disruption_signal": disruption_signal,
        "activity_change": activity_change,
        "fraud_check": fraud_check,
        "final_status": final_status,
        "disruption_level": disruption_level,
        "fraud_signals": fraud_signals,
        "decision": decision,
    }


def _predefined_reply(lang: str, key: str, vals: dict[str, str]) -> str | None:
    l = "hi" if str(lang).lower().startswith("hi") else "te" if str(lang).lower().startswith("te") else "en"
    m: dict[str, dict[str, str]] = {
        "en": {
            "no_payout": "We checked your situation carefully.\n\n• Disruption in your zone: Not strong enough\n• Your activity: Still within normal range\n\nSince both conditions were not met together, payout was not triggered.",
            "claim_status": "Here’s your current claim status:\n\n• Disruption signal: {disruption_signal}\n• Activity change: {activity_change}\n• Fraud check: {fraud_check}\n\nFinal status: {final_status}",
            "disruption_active": "Current zone status:\n\n• Signal strength: {disruption_signal}\n• Disruption level: {disruption_level}",
            "payment_delayed": "Your claim is under verification. This may take up to 30 minutes.",
            "explain_claim": "Here’s how your claim was evaluated:\n\n• Disruption detected: {disruption_signal}\n• Activity drop: {activity_change}\n• Fraud signals: {fraud_signals}\n\nDecision: {decision}",
            "coverage": "Your coverage is active.",
        },
        "hi": {
            "no_payout": "हमने आपकी स्थिति की जांच की।\n\n• आपके क्षेत्र में व्यवधान: पर्याप्त नहीं\n• आपकी गतिविधि: सामान्य स्तर पर\n\nदोनों शर्तें पूरी नहीं होने के कारण भुगतान नहीं हुआ।",
            "claim_status": "यह आपके क्लेम की स्थिति है:\n\n• व्यवधान संकेत: {disruption_signal}\n• गतिविधि में बदलाव: {activity_change}\n• धोखाधड़ी जांच: {fraud_check}\n\nअंतिम स्थिति: {final_status}",
            "disruption_active": "वर्तमान स्थिति:\n\n• संकेत स्तर: {disruption_signal}\n• व्यवधान स्तर: {disruption_level}",
            "payment_delayed": "आपका क्लेम सत्यापन में है। इसमें 30 मिनट तक लग सकते हैं।",
            "explain_claim": "आपके क्लेम का मूल्यांकन:\n\n• व्यवधान: {disruption_signal}\n• गतिविधि में गिरावट: {activity_change}\n• धोखाधड़ी संकेत: {fraud_signals}\n\nनिर्णय: {decision}",
            "coverage": "आपकी कवरेज सक्रिय है।",
        },
        "te": {
            "no_payout": "మీ పరిస్థితిని పరిశీలించాము।\n\n• మీ ప్రాంతంలో అంతరాయం: తక్కువ\n• మీ కార్యకలాపం: సాధారణ స్థాయిలో ఉంది\n\nఈ రెండు షరతులు కలిసిరాకపోవడంతో చెల్లింపు జరగలేదు।",
            "claim_status": "మీ క్లెయిమ్ స్థితి:\n\n• అంతరాయం స్థాయి: {disruption_signal}\n• కార్యకలాప మార్పు: {activity_change}\n• మోసం తనిఖీ: {fraud_check}\n\nచివరి స్థితి: {final_status}",
            "disruption_active": "ప్రస్తుత స్థితి:\n\n• సంకేత బలం: {disruption_signal}\n• అంతరాయం స్థాయి: {disruption_level}",
            "payment_delayed": "మీ క్లెయిమ్ పరిశీలనలో ఉంది। ఇది 30 నిమిషాల వరకు పట్టవచ్చు।",
            "explain_claim": "మీ క్లెయిమ్ విశ్లేషణ:\n\n• అంతరాయం: {disruption_signal}\n• కార్యకలాపం తగ్గుదల: {activity_change}\n• మోసం సంకేతాలు: {fraud_signals}\n\nతీర్మానం: {decision}",
            "coverage": "మీ కవరేజ్ సక్రియంగా ఉంది।",
        },
    }
    tpl = m.get(l, m["en"]).get(key)
    return tpl.format(**vals) if tpl else None


async def _auto_system_reply(db: AsyncSession, user_id: int, msg: str) -> str:
    t = msg.lower()
    life = (
        await db.execute(
            select(ClaimLifecycle)
            .where(ClaimLifecycle.user_id == user_id)
            .order_by(ClaimLifecycle.created_at.desc(), ClaimLifecycle.id.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if life is not None:
        st = str(life.status or "").upper()
        dis = str(life.disruption_type or "disruption").replace("_", " ").title()
        if "under review" in t or "review" in t or "claim" in t:
            if st in {"INITIATED", "VERIFYING", "BEHAVIORAL_CHECK", "FRAUD_CHECK", "REVALIDATING"}:
                return f"Your latest {dis} claim is currently {st.replace('_', ' ').title()}. We are still verifying signals and fraud safety."
            if st in {"APPROVED", "PAYOUT_DONE", "PAYOUT_CREDITED"}:
                return f"Your latest {dis} claim is approved. Payout update should be visible shortly in Home and Claims."
            if st in {"BLOCKED", "REJECTED", "CLAIM_REJECTED"}:
                return "Your latest claim was not approved after verification checks. You can ask for manual review and an admin can respond here."
        if "disruption" in t or "real time" in t:
            if st in {"INITIATED", "VERIFYING", "BEHAVIORAL_CHECK", "FRAUD_CHECK", "REVALIDATING"}:
                return f"Live disruption workflow is active for {dis}. Status is {st.replace('_', ' ').title()} right now."

    sim = (
        await db.execute(
            select(Simulation)
            .where(Simulation.user_id == user_id)
            .order_by(Simulation.created_at.desc(), Simulation.id.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if sim is not None and ("payout" in t or "no payout" in t):
        dec = str(sim.decision.value if hasattr(sim.decision, "value") else sim.decision).upper()
        if dec == DecisionType.APPROVED.value:
            return f"Your most recent claim is approved with payout ₹{int(round(float(sim.payout or 0.0)))}."
        if dec == DecisionType.FRAUD.value:
            return "Your latest claim was blocked due to fraud-risk checks. If you think this is incorrect, ask for manual review."
        if dec == DecisionType.REJECTED.value:
            return "Your latest claim was rejected because disruption or activity checks did not meet payout rules."

    return _fallback_system_reply(msg)


def _as_utc_iso(dt: Any) -> str:
    if dt is None:
        return ""
    if getattr(dt, "tzinfo", None) is None:
        dt = dt.replace(tzinfo=timezone.utc)
    else:
        dt = dt.astimezone(timezone.utc)
    return dt.isoformat().replace("+00:00", "Z")


@router.post("/query")
async def create_support_query(
    body: SupportQueryBody,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    uid = current_user.id
    if body.user_id is not None and str(body.user_id).strip().isdigit():
        asked = int(str(body.user_id).strip())
        if asked == current_user.id:
            uid = asked
    life = (
        await db.execute(
            select(ClaimLifecycle)
            .where(ClaimLifecycle.user_id == uid)
            .order_by(ClaimLifecycle.created_at.desc(), ClaimLifecycle.id.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    sim = (
        await db.execute(
            select(Simulation)
            .where(Simulation.user_id == uid)
            .order_by(Simulation.created_at.desc(), Simulation.id.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    sys_reply = _predefined_reply(body.language, str(body.query_key or ""), _support_values(life, sim))
    if not sys_reply:
        sys_reply = await _auto_system_reply(db, uid, body.message)
    row = SupportQuery(
        user_id=uid,
        message=body.message.strip(),
        query_type="predefined" if str(body.type).lower() == "predefined" else "custom",
        system_response=sys_reply,
        admin_reply=None,
        status="open",
    )
    db.add(row)
    await db.flush()
    await db.commit()
    return {"ok": True, "id": row.id}


@router.get("/history")
async def support_history(
    user_id: str | None = None,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    uid = current_user.id
    if user_id and str(user_id).strip().isdigit() and int(str(user_id).strip()) == current_user.id:
        uid = int(str(user_id).strip())
    rows = (
        await db.execute(
            select(SupportQuery)
            .where(SupportQuery.user_id == uid)
            .order_by(SupportQuery.created_at.asc(), SupportQuery.id.asc())
        )
    ).scalars().all()
    return [
        {
            "id": r.id,
            "message": r.message,
            "reply": r.system_response,
            "admin_reply": r.admin_reply,
            "status": r.status,
            "created_at": _as_utc_iso(r.created_at),
        }
        for r in rows
    ]


@router.post("/reply")
async def support_reply(
    body: SupportReplyBody,
    _admin: User = Depends(get_admin_user),
    db: AsyncSession = Depends(get_db),
):
    row = (await db.execute(select(SupportQuery).where(SupportQuery.id == int(body.query_id)))).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Support query not found")
    row.admin_reply = body.admin_reply.strip()
    row.status = "resolved"
    await create_notification(
        db,
        user_id=row.user_id,
        ntype="admin_reply",
        title="Admin replied",
        message=row.admin_reply,
    )
    await db.commit()
    return {"ok": True, "query_id": row.id, "status": row.status, "replied_at": datetime.now(timezone.utc).isoformat()}

