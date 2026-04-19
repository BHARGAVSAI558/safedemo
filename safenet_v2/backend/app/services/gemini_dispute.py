"""Gemini-powered claim explanations and dispute verdicts."""
from __future__ import annotations

import asyncio
import json
import os
from typing import Any

from app.utils.logger import get_logger

log = get_logger(__name__)
_MODEL = "gemini-1.5-flash"


def _configure() -> bool:
    key = (os.getenv("GEMINI_API_KEY") or "").strip()
    if not key:
        return False
    try:
        import google.generativeai as genai

        genai.configure(api_key=key)
        return True
    except Exception as exc:
        log.warning("gemini_configure_failed", error=str(exc))
        return False


def _fallback_explanation(
    claim: dict[str, Any],
    zone: dict[str, Any],
    gate_results: dict[str, Any],
    payout: float,
) -> str:
    st = str(claim.get("status", "")).lower()
    if st == "approved" or payout > 0:
        return (
            f"Your claim was approved! We confirmed {gate_results.get('gate1_value', 'a disruption')} "
            f"in {zone.get('name', 'your zone')}, and you were active during that time. "
            f"Rs.{int(round(payout))} has been credited based on your earning pattern."
        )
    if not gate_results.get("gate2_passed"):
        return (
            f"We confirmed a disruption in {zone.get('name', 'your zone')}, but couldn't detect you were "
            "actively working at that time. No payout was issued — this isn't a fraud flag, just a validation gap."
        )
    return (
        "Your claim is under review. All systems checked your activity and the disruption data. "
        "You'll hear back within 24 hours."
    )


def _explain_sync(
    claim: dict[str, Any],
    worker: dict[str, Any],
    zone: dict[str, Any],
    fraud_result: dict[str, Any],
    gate_results: dict[str, Any],
    payout: float,
) -> str:
    import google.generativeai as genai

    fs = float(fraud_result.get("fraud_score", 0) or 0)
    clean = "CLEAN" if fs < 0.4 else "FLAGGED"
    dec = "APPROVED" if str(claim.get("status", "")).lower() == "approved" else "NOT PAID"
    g2 = "was" if gate_results.get("gate2_passed") else "was NOT"
    prompt = (
        "You are SafeNet's AI claim advisor. Explain this claim decision to a delivery worker in simple, "
        "kind language (2-3 sentences max). Be specific about what data was used.\n\nCLAIM DATA:\n\n"
        f"* Worker: {worker.get('name')}, platform: {worker.get('platform')}, zone: {zone.get('name')}\n"
        f"* Disruption: {claim.get('disruption_type')} detected at {claim.get('created_at')}\n"
        f"* Gate 1 (External): {gate_results.get('gate1_source')} confirmed {gate_results.get('gate1_value')}\n"
        f"* Gate 2 (Activity): Worker {g2} detected as active\n"
        f"* Fraud check: Score {fs:.2f} — {clean}\n"
        f"* Decision: {dec}\n"
        f"* Payout: Rs.{payout} {'credited' if payout > 0 else '(no payout)'}\n"
        f"* Formula: Rs.{claim.get('dna_rate', 58)}/hr × {claim.get('duration_hours', 2.5)}h × {claim.get('tier_multiplier', 0.8)}\n\n"
        "Write 2-3 sentences. Start with the outcome. Warm and clear. Simple English. No jargon."
    )
    model = genai.GenerativeModel(_MODEL)
    response = model.generate_content(prompt)
    return (response.text or "").strip()


async def explain_claim_decision(
    claim: dict[str, Any],
    worker: dict[str, Any],
    zone: dict[str, Any],
    fraud_result: dict[str, Any],
    gate_results: dict[str, Any],
    payout: float,
) -> str:
    if not _configure():
        return _fallback_explanation(claim, zone, gate_results, payout)
    try:
        return await asyncio.to_thread(
            _explain_sync, claim, worker, zone, fraud_result, gate_results, payout
        )
    except Exception as exc:
        log.warning("gemini_explain_failed", error=str(exc))
        return _fallback_explanation(claim, zone, gate_results, payout)


def _verdict_sync(dispute_text: str, claim: dict[str, Any], worker: dict[str, Any], zone: dict[str, Any]) -> dict[str, Any]:
    import google.generativeai as genai

    prompt = (
        "You are a fair AI arbitrator for SafeNet insurance claims. Review this dispute and give a verdict.\n\n"
        "ORIGINAL CLAIM:\n\n"
        f"* Worker: {worker.get('name')}, Zone: {zone.get('name')}, Platform: {worker.get('platform')}\n"
        f"* Disruption claimed: {claim.get('disruption_type')}\n"
        f"* Status: {claim.get('status')}\n"
        f"* Fraud score: {claim.get('fraud_score')}\n"
        f"* Gate 1 passed: {claim.get('gate1_passed')}\n"
        f"* Gate 2 passed: {claim.get('gate2_passed')}\n\n"
        f"WORKER'S DISPUTE:\n\"{dispute_text}\"\n\n"
        'Respond ONLY with valid JSON, no markdown: {"verdict": "UPHOLD_REJECTION" or "OVERTURN_TO_APPROVE" '
        'or "ESCALATE_TO_HUMAN", "confidence": 0.0, "reasoning": "text", "recommended_action": "text"}\n'
    )
    model = genai.GenerativeModel(_MODEL)
    response = model.generate_content(prompt)
    text = (response.text or "").strip()
    if text.startswith("```"):
        parts = text.split("```")
        text = parts[1] if len(parts) > 1 else text
        if text.lower().startswith("json"):
            text = text[4:].strip()
    return json.loads(text.strip())


async def generate_dispute_verdict(
    dispute_text: str,
    claim: dict[str, Any],
    worker: dict[str, Any],
    zone: dict[str, Any],
) -> dict[str, Any]:
    default = {
        "verdict": "ESCALATE_TO_HUMAN",
        "confidence": 0.5,
        "reasoning": "AI review unavailable. Escalating to human review team.",
        "recommended_action": "Admin will review within 24 hours.",
    }
    if not _configure():
        return default
    try:
        return await asyncio.to_thread(_verdict_sync, dispute_text, claim, worker, zone)
    except Exception as exc:
        log.warning("gemini_verdict_failed", error=str(exc))
        return default
