from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict

import joblib
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from sklearn.model_selection import GridSearchCV, KFold, train_test_split
from xgboost import XGBRegressor


SEED = 42
N = 10_000


def _seasonal_factor(season: np.ndarray) -> np.ndarray:
    # 0=dry, 1=summer, 2=monsoon, 3=post-monsoon
    mapping = {0: 0.85, 1: 1.1, 2: 1.35, 3: 1.0}
    return np.vectorize(mapping.get)(season)


def generate_synthetic_dataset(n: int = N, seed: int = SEED) -> pd.DataFrame:
    rng = np.random.default_rng(seed)

    # Seed zone risk from pseudo zone ids.
    zone_bucket = rng.integers(0, 20, size=n)
    zone_risk_score = np.clip((zone_bucket / 19.0) * 0.8 + rng.normal(0.12, 0.08, n), 0, 1)

    # Bimodal active-hour distribution.
    part_timer = rng.random(n) < 0.45
    active_hours_per_day = np.where(
        part_timer,
        rng.normal(5.2, 0.9, n),
        rng.normal(10.8, 1.0, n),
    )
    active_hours_per_day = np.clip(active_hours_per_day, 4, 13)

    worker_tenure_weeks = rng.integers(1, 105, size=n)
    season = rng.integers(0, 4, size=n)
    claim_count_last_30_days = np.clip(rng.poisson(2.0 + zone_risk_score * 2.5, size=n), 0, 8)
    trust_score = np.clip(rng.normal(68, 16, size=n), 0, 100)

    historical_disruption_days_per_month = np.clip(
        zone_risk_score * 9.0 + _seasonal_factor(season) * 2.0 + rng.normal(0, 1.4, n),
        0,
        20,
    )

    # Continuous target in [35,70], with intuitive relationships.
    optimal_weekly_premium = (
        35
        + zone_risk_score * 16
        + (active_hours_per_day / 13.0) * 8
        + (claim_count_last_30_days / 8.0) * 7
        + (historical_disruption_days_per_month / 20.0) * 7
        - (trust_score / 100.0) * 4
        + (worker_tenure_weeks / 104.0) * 2
        + (season == 2).astype(float) * 2.5
        + rng.normal(0, 1.8, n)
    )
    optimal_weekly_premium = np.clip(optimal_weekly_premium, 35, 70)

    return pd.DataFrame(
        {
            "zone_risk_score": zone_risk_score.astype(float),
            "active_hours_per_day": active_hours_per_day.astype(float),
            "worker_tenure_weeks": worker_tenure_weeks.astype(int),
            "season": season.astype(int),
            "claim_count_last_30_days": claim_count_last_30_days.astype(int),
            "trust_score": trust_score.astype(float),
            "historical_disruption_days_per_month": historical_disruption_days_per_month.astype(float),
            "optimal_weekly_premium": optimal_weekly_premium.astype(float),
        }
    )


def train_and_save() -> Dict[str, float]:
    df = generate_synthetic_dataset()
    X = df.drop(columns=["optimal_weekly_premium"])
    y = df["optimal_weekly_premium"]

    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.20, random_state=SEED)

    base = XGBRegressor(
        objective="reg:squarederror",
        random_state=SEED,
        n_jobs=-1,
    )
    grid = GridSearchCV(
        estimator=base,
        param_grid={
            "n_estimators": [100, 200, 300],
            "max_depth": [3, 5, 7],
            "learning_rate": [0.05, 0.1, 0.15],
            "subsample": [0.8, 1.0],
        },
        cv=KFold(n_splits=5, shuffle=True, random_state=SEED),
        scoring="neg_root_mean_squared_error",
        n_jobs=-1,
        verbose=1,
    )
    grid.fit(X_train, y_train)
    model = grid.best_estimator_

    pred = model.predict(X_test)
    rmse = float(np.sqrt(mean_squared_error(y_test, pred)))
    mae = float(mean_absolute_error(y_test, pred))
    r2 = float(r2_score(y_test, pred))

    out_dir = Path(__file__).resolve().parents[1] / "ml_models"
    out_dir.mkdir(parents=True, exist_ok=True)
    joblib.dump(model, out_dir / "premium_model.pkl")

    # Feature importance chart
    importances = model.feature_importances_
    idx = np.argsort(importances)[::-1]
    names = np.array(X.columns)[idx]
    vals = importances[idx]
    plt.figure(figsize=(9, 5))
    plt.bar(names, vals)
    plt.xticks(rotation=30, ha="right")
    plt.title("Premium Model Feature Importance")
    plt.tight_layout()
    plt.savefig(out_dir / "feature_importance.png", dpi=150)
    plt.close()

    metrics = {"rmse": rmse, "mae": mae, "r2": r2}
    print(metrics)
    return metrics


if __name__ == "__main__":
    train_and_save()

