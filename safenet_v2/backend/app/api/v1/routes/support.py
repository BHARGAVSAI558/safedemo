from datetime import datetime, timezone
import random
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
from app.models.policy import Policy
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


def _norm_lang(lang: str | None) -> str:
    v = str(lang or "en").lower()
    if v.startswith("hi"):
        return "hi"
    if v.startswith("te"):
        return "te"
    return "en"


def _pick(*items: str) -> str:
    return random.choice([x for x in items if x])


def _support_values(
    life: ClaimLifecycle | None,
    sim: Simulation | None,
    policy: Policy | None,
) -> dict[str, str]:
    # Defaults when we don't find a live claim row yet.
    disruption_signal = "Not detected"
    activity_change = "No activity change"
    fraud_check = "Not checked"
    final_status = "No active claim found"
    disruption_level = "—"
    fraud_signals = "—"
    decision = "Pending"
    payout_amt = "0"
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
            payout_amt = str(int(round(float(sim.payout or 0.0))))
        elif dec == DecisionType.APPROVED.value:
            fraud_check, fraud_signals, decision = "Clear", "No major signals", "Approved"
            payout_amt = str(int(round(float(sim.payout or 0.0))))
        elif dec == DecisionType.REJECTED.value:
            decision = "Rejected"
            payout_amt = str(int(round(float(sim.payout or 0.0))))
    coverage_active = "Yes" if policy is not None and str(getattr(policy, "status", "")).lower() == "active" else "No"
    return {
        "disruption_signal": disruption_signal,
        "activity_change": activity_change,
        "fraud_check": fraud_check,
        "final_status": final_status,
        "disruption_level": disruption_level,
        "fraud_signals": fraud_signals,
        "decision": decision,
        "payout_amt": payout_amt,
        "coverage_active": coverage_active,
    }


def _localized_support_values(lang: str, vals: dict[str, str]) -> dict[str, str]:
    l = _norm_lang(lang)
    if l == "en":
        return vals
    hi_map = {
        "Not detected": "पता नहीं चला",
        "No activity change": "गतिविधि में बदलाव नहीं",
        "Not checked": "जांच नहीं हुई",
        "No active claim found": "कोई सक्रिय क्लेम नहीं मिला",
        "—": "—",
        "Pending": "लंबित",
        "Detected": "पता चला",
        "Shifted": "बदला हुआ",
        "Under review": "समीक्षा में",
        "Moderate": "मध्यम",
        "Strong": "मजबूत",
        "Significant drop": "स्पष्ट गिरावट",
        "Approved": "स्वीकृत",
        "High": "उच्च",
        "Weak": "कमजोर",
        "Near normal": "लगभग सामान्य",
        "Rejected": "अस्वीकृत",
        "Low": "निम्न",
        "Flagged": "चिह्नित",
        "Pattern mismatch": "पैटर्न मेल नहीं",
        "Fraud blocked": "धोखाधड़ी के कारण रोका गया",
        "Clear": "साफ",
        "No major signals": "कोई बड़ा जोखिम संकेत नहीं",
        "Yes": "हाँ",
        "No": "नहीं",
    }
    te_map = {
        "Not detected": "గుర్తించబడలేదు",
        "No activity change": "కార్యకలాప మార్పు లేదు",
        "Not checked": "తనిఖీ కాలేదు",
        "No active claim found": "సక్రియ క్లెయిమ్ లేదు",
        "—": "—",
        "Pending": "పెండింగ్",
        "Detected": "గుర్తించబడింది",
        "Shifted": "మార్పు ఉంది",
        "Under review": "పరిశీలనలో ఉంది",
        "Moderate": "మధ్యస్థం",
        "Strong": "బలంగా ఉంది",
        "Significant drop": "గణనీయమైన తగ్గుదల",
        "Approved": "ఆమోదించబడింది",
        "High": "అధికం",
        "Weak": "బలహీనంగా ఉంది",
        "Near normal": "సాధారణానికి దగ్గరగా ఉంది",
        "Rejected": "తిరస్కరించబడింది",
        "Low": "తక్కువ",
        "Flagged": "ఫ్లాగ్ చేయబడింది",
        "Pattern mismatch": "ప్యాటర్న్ సరిపోలలేదు",
        "Fraud blocked": "మోసం కారణంగా నిరోధించబడింది",
        "Clear": "స్పష్టంగా ఉంది",
        "No major signals": "పెద్ద ప్రమాద సంకేతాలు లేవు",
        "Yes": "అవును",
        "No": "లేదు",
    }
    m = hi_map if l == "hi" else te_map
    return {k: m.get(str(v), str(v)) for k, v in vals.items()}


def _predefined_reply(lang: str, key: str, vals: dict[str, str]) -> str | None:
    l = _norm_lang(lang)
    if str(key or "").lower() == "raise_ticket":
        if l == "hi":
            return _pick(
                "सपोर्ट टिकट सफलतापूर्वक दर्ज हो गया है। हमारी टीम जल्द ही यहीं उत्तर देगी।",
                "आपका टिकट सबमिट हो गया है। एडमिन का जवाब इसी चैट में मिलेगा।",
            )
        if l == "te":
            return _pick(
                "సపోర్ట్ టికెట్ విజయవంతంగా నమోదు అయింది. మా టీమ్ త్వరలో ఇక్కడే సమాధానం ఇస్తుంది.",
                "మీ టికెట్ సమర్పించబడింది. అడ్మిన్ స్పందన ఈ చాట్‌లోనే కనిపిస్తుంది.",
            )
        return _pick(
            "Support ticket created successfully. Our team will respond here shortly.",
            "Ticket submitted. You will receive an admin reply in this chat soon.",
        )

    vals = _localized_support_values(l, vals)
    # WOW-factor: multiple correct variants per question, so it never feels copy-pasted.
    variants: dict[str, dict[str, list[str]]] = {
        "en": {
            "no_payout": [
                "We checked your claim carefully.\n\n• Disruption impact: {disruption_signal}\n• Activity check: {activity_change}\n• Fraud safety: {fraud_check}\n\nResult: payout not triggered.",
                "No payout this time because the system didn’t see both signals align.\n\n• Disruption: {disruption_signal}\n• Activity: {activity_change}\n• Outcome: {decision}",
                "Payout didn’t trigger for this run.\n\nIf you believe this is wrong, ask for manual review — an admin can reply here.",
            ],
            "claim_status": [
                "Here’s your current claim status:\n\n• Disruption signal: {disruption_signal}\n• Activity change: {activity_change}\n• Fraud check: {fraud_check}\n\nFinal: {final_status}",
                "Live status snapshot:\n\n• Disruption: {disruption_signal}\n• Activity: {activity_change}\n• Safety: {fraud_check}\n\nFinal status: {final_status}",
            ],
            "disruption_active": [
                "Zone disruption status right now:\n\n• Signal strength: {disruption_signal}\n• Disruption level: {disruption_level}",
                "Disruption workflow overview:\n\n• Signal: {disruption_signal}\n• Level: {disruption_level}\n\nWe keep monitoring in real time.",
            ],
            "payment_delayed": [
                "Your claim is under verification.\n\nPayout updates once verification + safety checks complete (usually within ~30 minutes).",
                "It’s currently in the processing window.\n\nHang tight — payout shows immediately after the final decision.",
            ],
            "explain_claim": [
                "How your claim was evaluated:\n\n• Disruption: {disruption_signal}\n• Activity change: {activity_change}\n• Fraud signals: {fraud_signals}\n\nDecision: {decision}",
                "Decision breakdown:\n\n• Disruption impact: {disruption_signal}\n• Activity pattern: {activity_change}\n• Fraud safety: {fraud_signals}\n\nOutcome: {decision}",
            ],
            "coverage": [
                "Coverage check: {coverage_active} ✅\n\nWe keep monitoring your zone continuously and credit payout after verification.",
                "Your coverage is {coverage_active}.\n\nIf you share your claim status, we can explain the exact decision path.",
            ],
        },
        "hi": {
            "no_payout": [
                "हमने आपका क्लेम ध्यान से जाँचा।\n\n• व्यवधान असर: {disruption_signal}\n• गतिविधि चेक: {activity_change}\n• सुरक्षा जाँच: {fraud_check}\n\nपरिणाम: payout ट्रिगर नहीं हुआ।",
                "इस बार payout नहीं हुआ क्योंकि सिस्टम ने दोनों signals साथ में match नहीं देखे।\n\n• व्यवधान: {disruption_signal}\n• गतिविधि: {activity_change}\n• Outcome: {decision}",
                "इस run में payout नहीं हुआ। अगर आपको लगता है कोई गलती है, तो manual review माँगें — एडमिन जवाब दे सकता है।",
            ],
            "claim_status": [
                "आपके क्लेम की वर्तमान स्थिति:\n\n• व्यवधान संकेत: {disruption_signal}\n• गतिविधि में बदलाव: {activity_change}\n• धोखाधड़ी जांच: {fraud_check}\n\nअंतिम: {final_status}",
                "लाइव स्नैपशॉट:\n\n• व्यवधान: {disruption_signal}\n• गतिविधि: {activity_change}\n• सुरक्षा: {fraud_check}\n\nFinal status: {final_status}",
            ],
            "disruption_active": [
                "अभी ज़ोन का disruption status:\n\n• संकेत स्तर: {disruption_signal}\n• व्यवधान स्तर: {disruption_level}",
                "वर्तमान व्यवधान प्रवाह:\n\n• संकेत: {disruption_signal}\n• स्तर: {disruption_level}\n\nहम रियल-टाइम में मॉनिटर करते रहते हैं।",
            ],
            "payment_delayed": [
                "आपका क्लेम verification में है।\n\nPayout verification + safety checks के बाद तुरंत अपडेट होता है (आमतौर पर ~30 मिनट)।",
                "यह अभी processing विंडो में है।\n\nथोड़ा wait करें — अंतिम decision होते ही payout दिख जाएगा।",
            ],
            "explain_claim": [
                "क्लेम कैसे evaluate हुआ:\n\n• व्यवधान: {disruption_signal}\n• गतिविधि बदलाव: {activity_change}\n• धोखाधड़ी संकेत: {fraud_signals}\n\nनिर्णय: {decision}",
                "Decision breakdown:\n\n• व्यवधान असर: {disruption_signal}\n• गतिविधि पैटर्न: {activity_change}\n• Fraud safety: {fraud_signals}\n\nOutcome: {decision}",
            ],
            "coverage": [
                "Coverage check: {coverage_active} ✅\n\nहम आपकी zone को लगातार मॉनिटर करते हैं और verification के बाद payout credit करते हैं।",
                "आपका coverage {coverage_active} है।\n\nअगर आप चाहें तो claim status बताइए, हम exact decision path समझा देंगे।",
            ],
        },
        "te": {
            "no_payout": [
                "మేము మీ క్లెయిమ్‌ను జాగ్రత్తగా చెక్ చేశాం।\n\n• అంతరాయం ప్రభావం: {disruption_signal}\n• కార్యకలాప చెక్: {activity_change}\n• సేఫ్టీ చెక్: {fraud_check}\n\nఫలితం: payout ట్రిగర్ కాలేదు।",
                "ఈసారి payout రాలేదు ఎందుకంటే రెండూ signals ఒకేసారి సరిపోలలేదు।\n\n• అంతరాయం: {disruption_signal}\n• కార్యకలాపం: {activity_change}\n• Outcome: {decision}",
                "ఈ run లో payout లేదు. తప్పు అనిపిస్తే manual review కోరండి — అడ్మిన్ ఇక్కడే reply ఇస్తారు।",
            ],
            "claim_status": [
                "మీ క్లెయిమ్ యొక్క ప్రస్తుత స్థితి:\n\n• అంతరాయం సంకేతం: {disruption_signal}\n• కార్యకలాప మార్పు: {activity_change}\n• మోసం తనిఖీ: {fraud_check}\n\nFinal: {final_status}",
                "లైవ్ స్నాప్‌షాట్:\n\n• అంతరాయం: {disruption_signal}\n• కార్యకలాపం: {activity_change}\n• సేఫ్టీ: {fraud_check}\n\nఅంతిమ స్థితి: {final_status}",
            ],
            "disruption_active": [
                "ఇప్పుడే మీ జోన్ disruption status:\n\n• సంకేత బలం: {disruption_signal}\n• అంతరాయం స్థాయి: {disruption_level}",
                "ప్రస్తుత అంతరాయం ప్రవాహం:\n\n• సంకేతం: {disruption_signal}\n• స్థాయి: {disruption_level}\n\nమేము రియల్ టైమ్‌లో మానిటర్ చేస్తూనే ఉంటాం।",
            ],
            "payment_delayed": [
                "మీ క్లెయిమ్ verification లో ఉంది।\n\nPayout verification + safety checks పూర్తయ్యాక వెంటనే అప్డేట్ అవుతుంది (సాధారణంగా ~30 నిమిషాల్లో)।",
                "ఇప్పటికే processing విండోలో ఉంది।\n\nచివరి decision వచ్చిన వెంటనే payout కనిపిస్తుంది।",
            ],
            "explain_claim": [
                "మీ క్లెయిమ్ ఎలా evaluate అయ్యింది:\n\n• అంతరాయం: {disruption_signal}\n• కార్యకలాపం: {activity_change}\n• మోసం సంకేతాలు: {fraud_signals}\n\nDecision: {decision}",
                "Decision breakdown:\n\n• Disruption impact: {disruption_signal}\n• Activity pattern: {activity_change}\n• Fraud safety: {fraud_signals}\n\nOutcome: {decision}",
            ],
            "coverage": [
                "Coverage check: {coverage_active} ✅\n\nమీ జోన్‌ను నిరంతరం మానిటర్ చేసి, verification తర్వాత payout credit చేస్తాం।",
                "మీ coverage {coverage_active} ఉంది।\n\nమీ claim status చెప్పండి — exact decision path వివరించగలం।",
            ],
        },
    }

    lang_bucket = variants.get(l, variants["en"])
    key_bucket = lang_bucket.get(key)
    if not key_bucket:
        return None
    return _pick(*[tpl.format(**vals) for tpl in key_bucket])


def _fallback_localized(lang: str, msg: str) -> str:
    t = msg.lower()
    l = _norm_lang(lang)
    if "payout" in t or "payment" in t or "भुगतान" in t or "చెల్లింపు" in t:
        if l == "hi":
            return _pick(
                "भुगतान निर्णय व्यवधान सत्यापन, धोखाधड़ी जांच और आपके अर्निंग पैटर्न पर आधारित है।",
                "पAYOUT तभी ट्रिगर होता है जब व्यवधान + गतिविधि संकेत + सुरक्षा जांच एक साथ पास हों।",
            )
        if l == "te":
            return _pick(
                "చెల్లింపు నిర్ణయం అంతరాయం ధృవీకరణ, మోసం తనిఖీలు మరియు మీ earning pattern ఆధారంగా ఉంటుంది.",
                "అంతరాయం + కార్యకలాప మార్పు + భద్రతా తనిఖీలు పాస్ అయితేనే payout వస్తుంది.",
            )
        return _pick(
            "Payout is based on disruption verification, fraud checks, and your earning pattern for that slot.",
            "Payout triggers only when disruption + activity shift + safety checks pass together.",
        )
    if "claim" in t or "क्लेम" in t or "క్లెయిమ్" in t:
        if l == "hi":
            return _pick(
                "क्लेम फ्लो: व्यवधान पहचान → सत्यापन → धोखाधड़ी जांच → अंतिम निर्णय।",
                "आपका क्लेम स्टेप-बाय-स्टेप वेरिफिकेशन में जाता है, फिर अंतिम निर्णय होता है।",
            )
        if l == "te":
            return _pick(
                "క్లెయిమ్ ఫ్లో: అంతరాయం గుర్తింపు → ధృవీకరణ → మోసం తనిఖీ → తుది నిర్ణయం.",
                "మీ క్లెయిమ్ దశలవారీగా పరిశీలించి తర్వాత నిర్ణయం ఇస్తాము.",
            )
        return _pick(
            "Claim flow: disruption detected → verification → fraud checks → final decision.",
            "Your claim is processed step-by-step through verification and fraud safety checks.",
        )
    if l == "hi":
        return _pick(
            "हमने आपका संदेश दर्ज कर लिया है। आवश्यकता होने पर एडमिन यहीं जवाब देंगे।",
            "धन्यवाद, आपका प्रश्न लॉग हो गया है। टीम यहीं अपडेट देगी।",
        )
    if l == "te":
        return _pick(
            "మీ సందేశాన్ని నమోదు చేసాము. అవసరమైతే అడ్మిన్ ఇక్కడే సమాధానం ఇస్తారు.",
            "ధన్యవాదాలు, మీ ప్రశ్న రికార్డ్ అయింది. టీమ్ ఇక్కడే అప్డేట్ ఇస్తుంది.",
        )
    return _pick(
        "Thanks, we logged your query. Admin can reply here if needed.",
        "Your query is recorded. The team can respond here shortly.",
    )


def _status_reply_localized(lang: str, dis: str, status: str) -> str:
    st = status.replace("_", " ").title()
    l = _norm_lang(lang)
    if l == "hi":
        return _pick(
            f"आपका नवीनतम {dis} क्लेम अभी {st} में है। सत्यापन जारी है।",
            f"लेटेस्ट {dis} क्लेम स्थिति: {st}. सुरक्षा जांच चल रही है।",
        )
    if l == "te":
        return _pick(
            f"మీ తాజా {dis} క్లెయిమ్ ప్రస్తుతం {st} లో ఉంది. ధృవీకరణ కొనసాగుతోంది.",
            f"తాజా {dis} క్లెయిమ్ స్థితి: {st}. భద్రతా తనిఖీలు జరుగుతున్నాయి.",
        )
    return _pick(
        f"Your latest {dis} claim is currently {st}. Verification is in progress.",
        f"Latest {dis} claim status: {st}. Safety checks are running.",
    )


async def _auto_system_reply(db: AsyncSession, user_id: int, msg: str, lang: str = "en") -> str:
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
                return _status_reply_localized(lang, dis, st)
            if st in {"APPROVED", "PAYOUT_DONE", "PAYOUT_CREDITED"}:
                if _norm_lang(lang) == "hi":
                    return _pick("आपका नवीनतम क्लेम स्वीकृत है। भुगतान अपडेट जल्द दिखेगा।", "क्लेम Approved है। Home और Claims में payout जल्द दिखेगा।")
                if _norm_lang(lang) == "te":
                    return _pick("మీ తాజా క్లెయిమ్ ఆమోదించబడింది. payout త్వరలో కనిపిస్తుంది.", "క్లెయిమ్ Approved అయింది. Home/Claims లో చెల్లింపు అప్డేట్ త్వరలో వస్తుంది.")
                return _pick("Your latest claim is approved. Payout update should appear shortly.", "Claim approved. Payout update will reflect shortly in Home and Claims.")
            if st in {"BLOCKED", "REJECTED", "CLAIM_REJECTED"}:
                if _norm_lang(lang) == "hi":
                    return _pick("सत्यापन के बाद आपका क्लेम स्वीकृत नहीं हुआ। चाहें तो मैनुअल रिव्यू मांग सकते हैं।", "आपका नवीनतम क्लेम रिजेक्ट हुआ है। जरूरत हो तो एडमिन रिव्यू कर सकते हैं।")
                if _norm_lang(lang) == "te":
                    return _pick("పరిశీలన తర్వాత మీ క్లెయిమ్ ఆమోదం పొందలేదు. కావాలంటే manual review కోరండి.", "మీ తాజా క్లెయిమ్ తిరస్కరించబడింది. అవసరమైతే అడ్మిన్ రివ్యూ చేస్తారు.")
                return _pick("Your latest claim was not approved after verification checks. You can request a manual review.", "Latest claim is rejected after checks. You can ask for manual review.")
        if "disruption" in t or "real time" in t:
            if st in {"INITIATED", "VERIFYING", "BEHAVIORAL_CHECK", "FRAUD_CHECK", "REVALIDATING"}:
                return _status_reply_localized(lang, dis, st)

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
            amt = int(round(float(sim.payout or 0.0)))
            if _norm_lang(lang) == "hi":
                return _pick(f"आपका हालिया क्लेम स्वीकृत है। भुगतान ₹{amt} है।", f"लेटेस्ट क्लेम Approved. क्रेडिट राशि ₹{amt}.")
            if _norm_lang(lang) == "te":
                return _pick(f"మీ తాజా క్లెయిమ్ ఆమోదించబడింది. చెల్లింపు ₹{amt}.", f"లేటెస్ట్ క్లెయిమ్ Approved. క్రెడిట్ మొత్తం ₹{amt}.")
            return _pick(f"Your most recent claim is approved with payout ₹{amt}.", f"Latest claim is approved. Credited amount: ₹{amt}.")
        if dec == DecisionType.FRAUD.value:
            if _norm_lang(lang) == "hi":
                return _pick("धोखाधड़ी जोखिम जांच के कारण आपका क्लेम रोका गया। गलत लगे तो मैनुअल रिव्यू मांगें।", "फ्रॉड-रिस्क फ्लैग के कारण क्लेम ब्लॉक हुआ। आवश्यकता हो तो रिव्यू अनुरोध करें।")
            if _norm_lang(lang) == "te":
                return _pick("మోసం-ప్రమాద తనిఖీల వల్ల మీ క్లెయిమ్ నిరోధించబడింది. అవసరమైతే మాన్యువల్ రివ్యూ కోరండి.", "Fraud-risk flag కారణంగా క్లెయిమ్ బ్లాక్ అయింది. తప్పు అనిపిస్తే రివ్యూ అడగండి.")
            return _pick("Your latest claim was blocked due to fraud-risk checks. You can ask for manual review.", "Latest claim is blocked by fraud-risk checks. Request manual review if needed.")
        if dec == DecisionType.REJECTED.value:
            if _norm_lang(lang) == "hi":
                return _pick("व्यवधान/गतिविधि शर्तें पूरी न होने से आपका क्लेम रिजेक्ट हुआ।", "क्लेम भुगतान नियमों से मेल नहीं खाया, इसलिए अस्वीकृत हुआ।")
            if _norm_lang(lang) == "te":
                return _pick("అంతరాయం/కార్యకలాప షరతులు సరిపోక మీ క్లెయిమ్ తిరస్కరించబడింది.", "చెల్లింపు నియమాలకు సరిపోక క్లెయిమ్ reject అయింది.")
            return _pick("Your latest claim was rejected because checks did not meet payout rules.", "Claim rejected as disruption/activity checks did not satisfy payout rules.")

    return _fallback_localized(lang, msg)


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

    pol = (
        await db.execute(
            select(Policy)
            .where(Policy.user_id == uid, Policy.status == "active")
            .order_by(Policy.id.desc())
            .limit(1)
        )
    ).scalar_one_or_none()

    sys_reply = _predefined_reply(
        body.language,
        str(body.query_key or ""),
        _support_values(life, sim, pol),
    )
    if not sys_reply:
        sys_reply = await _auto_system_reply(db, uid, body.message, body.language)
    is_ticket = str(body.type or "").lower() == "ticket" or str(body.query_key or "").lower() == "raise_ticket"
    row = SupportQuery(
        user_id=uid,
        message=body.message.strip(),
        query_type=(
            "ticket"
            if is_ticket
            else ("predefined" if str(body.type).lower() == "predefined" else "custom")
        ),
        system_response=sys_reply,
        admin_reply=None,
        status="open",
    )
    db.add(row)
    await db.flush()
    ticket_no = f"TKT-{int(row.id):06d}"
    if is_ticket:
        l = _norm_lang(body.language)
        row.system_response = (
            f"Ticket {ticket_no} created successfully. Priority: Normal. Our team will respond soon."
            if l == "en"
            else (
                f"टिकट {ticket_no} सफलतापूर्वक बन गया है। प्राथमिकता: सामान्य। हमारी टीम जल्द उत्तर देगी।"
                if l == "hi"
                else f"టికెట్ {ticket_no} విజయవంతంగా సృష్టించబడింది. ప్రాధాన్యత: సాధారణం. మా టీమ్ త్వరలో స్పందిస్తుంది."
            )
        )
    await db.commit()
    return {"ok": True, "id": row.id, "ticket_no": ticket_no if is_ticket else None}


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
            "query_type": r.query_type,
            "ticket_no": f"TKT-{int(r.id):06d}" if str(r.query_type) == "ticket" else None,
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

