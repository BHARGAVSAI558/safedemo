"""
Seed demo workers, policies, simulations, zone pools, and fraud signals.
Run from backend directory: python -m scripts.seed_demo_data
"""

from __future__ import annotations

import asyncio
import random
from datetime import datetime, timedelta, timezone

from sqlalchemy import select

from app.db.session import AsyncSessionLocal
from app.models.claim import DecisionType, Simulation
from app.models.fraud import FraudSignal
from app.models.policy import Policy
from app.models.pool_balance import ZonePoolBalance
from app.models.worker import OccupationType, Profile, RiskProfile, User

NAMES = [
    "Ravi Kumar",
    "Arjun Reddy",
    "Priya Sharma",
    "Mohammed Irfan",
    "Sita Devi",
    "Vikram Singh",
    "Ananya Rao",
    "Karthik Nair",
    "Deepika Patel",
    "Suresh Gupta",
    "Neha Kulkarni",
    "Rahul Verma",
    "Lakshmi Iyer",
    "Aditya Mehta",
    "Fatima Begum",
]

# 6 + 4 + 3 + 2 = 15
CITIES = (
    ["Kukatpally"] * 6
    + ["HITEC City"] * 4
    + ["Secunderabad"] * 3
    + ["Gachibowli"] * 2
)

ZONE_IDS = {
    "Kukatpally": "hyd_kukatpally",
    "HITEC City": "hyd_hitec",
    "Secunderabad": "hyd_secunderabad",
    "Gachibowli": "hyd_gachibowli",
}

PRODUCT_TIERS = (
    ["income_shield_basic"] * 4
    + ["income_shield_standard"] * 4
    + ["income_shield_pro"] * 4
)


async def seed() -> None:
    random.seed(42)
    async with AsyncSessionLocal() as db:
        existing = (await db.execute(select(User).where(User.phone == "9900000001"))).scalar_one_or_none()
        if existing:
            print("Demo data already present (9900000001 exists). Skipping.")
            return

        users: list[User] = []
        base_phone = 9900000001
        for i in range(15):
            phone = str(base_phone + i)
            u = User(phone=phone, is_active=True, is_admin=False)
            db.add(u)
            users.append(u)
        await db.flush()

        profiles: list[Profile] = []
        trust_scores = [45, 52, 58, 61, 67, 70, 73, 76, 79, 82, 85, 88, 91, 93, 95]
        for i, u in enumerate(users):
            prof = Profile(
                user_id=u.id,
                name=NAMES[i],
                city=CITIES[i],
                occupation=OccupationType.delivery,
                avg_daily_income=float(800 + i * 120),
                risk_profile=RiskProfile.medium,
                trust_score=float(trust_scores[i]),
                total_claims=0,
                total_payouts=0.0,
            )
            db.add(prof)
            profiles.append(prof)
        await db.flush()

        now = datetime.now(timezone.utc)
        # 12 active policies (first 12 users)
        for i in range(12):
            u = users[i]
            code = PRODUCT_TIERS[i]
            weekly = 38.0 + float(i % 5) * 4.5
            monthly = weekly * 4.2
            pol = Policy(
                user_id=u.id,
                product_code=code,
                status="active",
                monthly_premium=monthly,
                weekly_premium=weekly,
                updated_at=now,
            )
            db.add(pol)
        await db.flush()

        # 20 simulations: 12 APPROVED, 5 FRAUD, 3 REJECTED
        decisions = (
            [DecisionType.APPROVED] * 12
            + [DecisionType.FRAUD] * 5
            + [DecisionType.REJECTED] * 3
        )
        random.shuffle(decisions)

        sim_rows: list[Simulation] = []
        for k in range(20):
            u = users[k % 15]
            d = decisions[k]
            fraud_score = 0.15 if d == DecisionType.APPROVED else (0.92 if d == DecisionType.FRAUD else 0.35)
            payout = float(random.randint(200, 750)) if d == DecisionType.APPROVED else 0.0
            sim = Simulation(
                user_id=u.id,
                is_active=True,
                fraud_flag=d == DecisionType.FRAUD,
                fraud_score=fraud_score,
                weather_disruption=True,
                traffic_disruption=False,
                event_disruption=False,
                final_disruption=True,
                expected_income=1200.0,
                actual_income=400.0,
                loss=800.0,
                payout=payout,
                decision=d,
                reason=f"Demo simulation {k + 1} - {CITIES[k % 15]}",
                weather_data='{"zone_id": "hyd_demo", "scenario": "seed"}',
            )
            db.add(sim)
            sim_rows.append(sim)
        await db.flush()

        # Fraud signals: 2 GPS spoof (users 0,1), 1 ring cluster (user 2)
        fs1 = FraudSignal(
            user_id=users[0].id,
            simulation_id=sim_rows[0].id,
            score=0.88,
            cluster_id="",
            reason_code="GPS_SPOOF",
            detail="teleport_flag; static_spoof_flag",
        )
        fs2 = FraudSignal(
            user_id=users[1].id,
            simulation_id=sim_rows[1].id,
            score=0.82,
            cluster_id="",
            reason_code="GPS_SPOOF",
            detail="tower_mismatch_flag",
        )
        fs3 = FraudSignal(
            user_id=users[2].id,
            simulation_id=sim_rows[2].id,
            score=0.95,
            cluster_id="RING-HYD-001",
            reason_code="RING_FRAUD",
            detail="sync_spike; homogeneous_pattern",
        )
        db.add_all([fs1, fs2, fs3])

        # Zone pool balances (one row per zone)
        week_start = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
        for city, zid in ZONE_IDS.items():
            bal = random.randint(4000, 8000)
            util = round(random.uniform(35.0, 72.0), 1)
            db.add(
                ZonePoolBalance(
                    zone_id=zid,
                    week_start=week_start,
                    pool_balance_start_of_week=float(bal),
                    total_payouts_this_week=float(bal * util / 200.0),
                    utilization_pct=util,
                    flagged_reinsurance=util > 68.0,
                    risk_note=f"{city} pool snapshot",
                )
            )

        await db.commit()
        print("Seeded 15 demo workers, 12 policies, 20 simulations, 3 fraud_signals, 4 zone_pool_balances.")


def main() -> None:
    asyncio.run(seed())


if __name__ == "__main__":
    main()
