from __future__ import annotations

import json
import math
import os
import random
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from app.services.protocols import GovernmentAlertsProtocol, PlatformDemandProtocol
from app.services.signal_types import GovernmentAlertSignal, PlatformDemandSignal
from app.utils.logger import get_logger

log = get_logger(__name__)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class TrafficService:
    CONGESTION_LEVELS = ["low", "moderate", "high", "severe"]

    @staticmethod
    def get(city: str = "Hyderabad") -> Tuple[bool, str, Dict[str, Any]]:
        level = random.choices(
            TrafficService.CONGESTION_LEVELS,
            weights=[40, 30, 20, 10],
        )[0]
        is_disruption = level in ("high", "severe")
        reason = f"Traffic congestion: {level}"
        data: Dict[str, Any] = {"city": city, "congestion_level": level, "source": "mock_traffic"}
        reason_code = "TRAFFIC_DISRUPTION" if is_disruption else "TRAFFIC_OK"
        log.info(
            "traffic_evaluated",
            engine_name="event_service",
            decision=str(is_disruption),
            reason_code=reason_code,
            city=city,
            congestion_level=level,
        )
        return is_disruption, reason, data


class GovernmentAlertStore:
    """In-memory alerts keyed by zone_id; seeded from JSON at startup."""

    def __init__(self) -> None:
        self._by_zone: Dict[str, List[Dict[str, Any]]] = {}

    def load_seed(self, path: str) -> None:
        try:
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
            zones = data.get("zones") or {}
            for zid, rows in zones.items():
                self._by_zone[str(zid)] = list(rows) if isinstance(rows, list) else []
            log.info(
                "government_alerts_loaded",
                engine_name="event_service",
                decision=str(len(self._by_zone)),
                reason_code="ALERTS_SEED",
                path=path,
            )
        except Exception as exc:
            log.warning(
                "government_alerts_seed_failed",
                engine_name="event_service",
                decision="empty",
                reason_code="ALERTS_SEED_ERROR",
                error=str(exc),
            )

    def replace_zone_alerts(self, zone_id: str, alerts: List[Dict[str, Any]]) -> None:
        self._by_zone[str(zone_id)] = list(alerts)

    def append_zone_alerts(self, zone_id: str, alerts: List[Dict[str, Any]]) -> None:
        self._by_zone.setdefault(str(zone_id), []).extend(alerts)

    def get_raw(self, zone_id: str) -> List[Dict[str, Any]]:
        return list(self._by_zone.get(str(zone_id), []))


government_alert_store = GovernmentAlertStore()


class EventSignalsService(GovernmentAlertsProtocol, PlatformDemandProtocol):
    """Government + platform demand signals for confidence and demos."""

    def __init__(self, store: Optional[GovernmentAlertStore] = None) -> None:
        self._store = store or government_alert_store

    async def get_government_alert(self, zone_id: str) -> GovernmentAlertSignal:
        rows = self._store.get_raw(zone_id)
        active = False
        severity: Optional[str] = None
        atype: Optional[str] = None
        desc_parts: List[str] = []

        for row in rows:
            t = str(row.get("type", "")).lower()
            sev = str(row.get("severity", "GREEN")).upper()
            desc = str(row.get("description", ""))
            if t in ("curfew", "strike", "protest", "lockdown") and sev in ("ORANGE", "RED"):
                active = True
            if sev == "RED":
                active = True
            if sev in ("RED", "ORANGE", "YELLOW", "GREEN"):
                severity = sev if severity is None else severity
            atype = t if atype is None else atype
            if desc:
                desc_parts.append(desc)

        description = "; ".join(desc_parts) if desc_parts else "No active government alerts"
        if not rows:
            description = "No alerts registered for zone"

        sig = GovernmentAlertSignal(
            alert_active=active,
            severity=severity if severity else ("RED" if active else "GREEN"),
            alert_type=atype,
            description=description,
            source="government_mock",
            fetched_at=_utcnow(),
        )
        log.info(
            "government_alert_signal",
            engine_name="event_service",
            decision=str(sig.alert_active),
            reason_code="GOV_ALERT",
            zone_id=zone_id,
            severity=sig.severity,
        )
        return sig

    async def get_platform_demand(
        self,
        zone_id: str,
        *,
        other_triggers_active: bool,
    ) -> PlatformDemandSignal:
        hour = _utcnow().hour + _utcnow().minute / 60.0
        phase = (hour - 8.0) / 24.0 * 2 * math.pi
        baseline = 0.52 + 0.48 * math.sin(phase)
        rnd = random.Random(hash(zone_id) % (2**32))
        noise = rnd.uniform(-0.06, 0.06)
        rate = max(0.0, min(1.0, baseline + noise))
        if other_triggers_active:
            rate = rate * 0.15
        drop_pct = max(0.0, (baseline - rate) / max(baseline, 1e-6) * 100.0)
        sustained = 2.5 if drop_pct >= 80.0 else 0.0

        sig = PlatformDemandSignal(
            order_rate_index=round(rate, 4),
            drop_pct_vs_baseline=round(drop_pct, 2),
            sustained_low_hours=sustained,
            source="platform_simulation",
            fetched_at=_utcnow(),
        )
        log.info(
            "platform_demand_signal",
            engine_name="event_service",
            decision=str(rate),
            reason_code="PLATFORM_DEMAND",
            zone_id=zone_id,
            other_triggers=other_triggers_active,
        )
        return sig


class EventService:
    """Legacy civic disruption mock (non-government) for backward compatibility."""

    EVENTS = [
        {"type": "none", "description": "No events", "disruption": False},
        {"type": "election", "description": "Election day", "disruption": True},
        {"type": "strike", "description": "Transport strike", "disruption": True},
        {"type": "festival", "description": "Local festival", "disruption": False},
        {"type": "protest", "description": "Road blockage", "disruption": True},
    ]

    @staticmethod
    def get(city: str = "Hyderabad") -> Tuple[bool, str, Dict[str, Any]]:
        event = random.choices(
            EventService.EVENTS,
            weights=[50, 10, 15, 15, 10],
        )[0]
        is_disruption = bool(event["disruption"])
        reason = str(event["description"])
        data: Dict[str, Any] = {
            "city": city,
            "event_type": event["type"],
            "description": reason,
            "source": "mock_events",
        }
        reason_code = "EVENT_DISRUPTION" if is_disruption else "EVENT_OK"
        log.info(
            "civic_event_evaluated",
            engine_name="event_service",
            decision=str(is_disruption),
            reason_code=reason_code,
            city=city,
            event_type=event["type"],
        )
        return is_disruption, reason, data


def default_event_signals() -> EventSignalsService:
    return EventSignalsService(government_alert_store)


def load_government_alerts_from_path(path: Optional[str] = None) -> None:
    base = os.path.dirname(os.path.dirname(__file__))
    p = path or os.path.join(base, "data", "government_alerts_seed.json")
    government_alert_store.load_seed(p)
