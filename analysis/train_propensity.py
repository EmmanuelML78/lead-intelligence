#!/usr/bin/env python3
"""Reproducible Milestone 4 historical analysis and propensity training.

Uses only Python's standard library so the documented Bun command works
without adding Python packages. The exported JSON is consumed by TypeScript;
Python is never needed by the deployed application.
"""

from __future__ import annotations

import csv
import json
import math
import random
from collections import defaultdict
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Callable


ROOT = Path(__file__).resolve().parents[1]
SOURCE_PATH = ROOT / "data" / "raw" / "historico_cierres.csv"
CATALOG_PATH = ROOT / "data" / "raw" / "catalogo_motos.csv"
MODEL_PATH = ROOT / "artifacts" / "propensity-model-v1.json"
ANALYSIS_PATH = ROOT / "artifacts" / "propensity-analysis-v1.json"
PARITY_PATH = ROOT / "artifacts" / "propensity-parity-v1.json"

MODEL_VERSION = "propensity-model-v1"
ANALYSIS_VERSION = "propensity-analysis-v1"
RANDOM_SEED = 20260914
FOLDS = 5
L2_STRENGTH = 0.005
TRAINING_EPOCHS = 800
LEARNING_RATE = 0.04

Row = dict[str, str]
NormalizedRow = dict[str, str | float | int]


def canonical_channel(value: str) -> str:
    return {
        "WhatsApp": "WHATSAPP",
        "Meta Ads": "META_ADS",
        "Formulario Web": "WEB_FORM",
    }.get(value, "UNKNOWN")


def canonical_down_payment(value: str) -> str:
    return {"SI": "YES", "NO": "NO", "NO_INFORMA": "UNKNOWN"}.get(value, "UNKNOWN")


def canonical_payment_method(value: str) -> str:
    return {"credito": "CREDIT", "contado": "CASH", "no_informa": "UNKNOWN"}.get(
        value, "UNKNOWN"
    )


def canonical_appointment(value: str) -> str:
    return {"SI": "YES", "NO": "NO"}.get(value, "UNKNOWN")


def read_rows() -> list[Row]:
    with SOURCE_PATH.open(newline="", encoding="utf-8-sig") as source:
        rows = list(csv.DictReader(source))
    if not rows:
        raise ValueError(f"Historical dataset is empty: {SOURCE_PATH}")
    return rows


def normalize_row(row: Row) -> NormalizedRow:
    return {
        "leadId": row["lead_id"],
        "channel": canonical_channel(row["canal"]),
        "companyId": row["empresa_id"],
        "salesPointId": row["punto_venta_id"],
        "motorcycleModel": row["modelo_cotizado"],
        "listPrice": float(row["precio_lista"]),
        "declaredDownPayment": canonical_down_payment(row["manifesto_cuota_inicial"]),
        "declaredPaymentMethod": canonical_payment_method(row["forma_pago_declarada"]),
        "requestedAppointment": canonical_appointment(row["pidio_cita"]),
        "outcome": row["desenlace"],
    }


CATEGORICAL_FEATURES: tuple[tuple[str, str], ...] = (
    ("channel", "canal"),
    ("companyId", "empresa_id"),
    ("salesPointId", "punto_venta_id"),
    ("motorcycleModel", "modelo_cotizado"),
    ("declaredDownPayment", "manifesto_cuota_inicial"),
    ("declaredPaymentMethod", "forma_pago_declarada"),
    ("requestedAppointment", "pidio_cita"),
)


@dataclass(frozen=True)
class CategoryDesign:
    name: str
    source_field: str
    categories: tuple[str, ...]
    reference: str
    indices: dict[str, int]


@dataclass(frozen=True)
class Design:
    categories: tuple[CategoryDesign, ...]
    price_mean: float
    price_scale: float
    price_index: int
    feature_count: int


@dataclass(frozen=True)
class TrainedModel:
    design: Design
    intercept: float
    coefficients: tuple[float, ...]


def fit_design(rows: list[NormalizedRow]) -> Design:
    groups: list[CategoryDesign] = []
    next_index = 0
    for name, source_field in CATEGORICAL_FEATURES:
        categories = tuple(sorted({str(row[name]) for row in rows}))
        if not categories:
            raise ValueError(f"No categories found for {name}")
        reference = categories[0]
        indices: dict[str, int] = {}
        for category in categories[1:]:
            indices[category] = next_index
            next_index += 1
        groups.append(CategoryDesign(name, source_field, categories, reference, indices))

    prices = [float(row["listPrice"]) for row in rows]
    price_mean = sum(prices) / len(prices)
    variance = sum((value - price_mean) ** 2 for value in prices) / len(prices)
    price_scale = math.sqrt(variance) or 1.0
    return Design(
        categories=tuple(groups),
        price_mean=price_mean,
        price_scale=price_scale,
        price_index=next_index,
        feature_count=next_index + 1,
    )


def encode(row: NormalizedRow, design: Design) -> tuple[tuple[int, float], ...]:
    encoded: list[tuple[int, float]] = []
    for feature in design.categories:
        index = feature.indices.get(str(row[feature.name]))
        if index is not None:
            encoded.append((index, 1.0))
    scaled_price = (float(row["listPrice"]) - design.price_mean) / design.price_scale
    encoded.append((design.price_index, scaled_price))
    return tuple(encoded)


def sigmoid(value: float) -> float:
    if value >= 0:
        return 1.0 / (1.0 + math.exp(-value))
    exp_value = math.exp(value)
    return exp_value / (1.0 + exp_value)


def fit_logistic(rows: list[NormalizedRow]) -> TrainedModel:
    design = fit_design(rows)
    samples = [encode(row, design) for row in rows]
    targets = [1 if row["outcome"] == "Cerrado" else 0 for row in rows]
    positive_rate = (sum(targets) + 0.5) / (len(targets) + 1.0)
    intercept = math.log(positive_rate / (1.0 - positive_rate))
    coefficients = [0.0] * design.feature_count

    first_moment = [0.0] * (design.feature_count + 1)
    second_moment = [0.0] * (design.feature_count + 1)
    beta1 = 0.9
    beta2 = 0.999
    epsilon = 1e-8
    sample_count = len(samples)

    for epoch in range(1, TRAINING_EPOCHS + 1):
        gradient = [0.0] * design.feature_count
        intercept_gradient = 0.0
        for sample, target in zip(samples, targets):
            log_odds = intercept
            for index, value in sample:
                log_odds += coefficients[index] * value
            residual = sigmoid(log_odds) - target
            intercept_gradient += residual
            for index, value in sample:
                gradient[index] += residual * value

        intercept_gradient /= sample_count
        for index in range(design.feature_count):
            gradient[index] = (
                gradient[index] / sample_count + L2_STRENGTH * coefficients[index]
            )

        all_gradients = [intercept_gradient, *gradient]
        beta1_correction = 1.0 - beta1**epoch
        beta2_correction = 1.0 - beta2**epoch
        updates: list[float] = []
        for index, value in enumerate(all_gradients):
            first_moment[index] = beta1 * first_moment[index] + (1.0 - beta1) * value
            second_moment[index] = beta2 * second_moment[index] + (1.0 - beta2) * value**2
            corrected_first = first_moment[index] / beta1_correction
            corrected_second = second_moment[index] / beta2_correction
            updates.append(
                LEARNING_RATE * corrected_first / (math.sqrt(corrected_second) + epsilon)
            )

        intercept -= updates[0]
        for index, update in enumerate(updates[1:]):
            coefficients[index] -= update

    return TrainedModel(design, intercept, tuple(coefficients))


def predict_model(model: TrainedModel, row: NormalizedRow) -> float:
    log_odds = model.intercept
    for index, value in encode(row, model.design):
        log_odds += model.coefficients[index] * value
    return sigmoid(log_odds)


def stratified_folds(rows: list[NormalizedRow]) -> list[list[int]]:
    folds: list[list[int]] = [[] for _ in range(FOLDS)]
    randomizer = random.Random(RANDOM_SEED)
    by_target = {
        0: [index for index, row in enumerate(rows) if row["outcome"] != "Cerrado"],
        1: [index for index, row in enumerate(rows) if row["outcome"] == "Cerrado"],
    }
    for indices in by_target.values():
        randomizer.shuffle(indices)
        for position, index in enumerate(indices):
            folds[position % FOLDS].append(index)
    return folds


def cross_validated_predictions(rows: list[NormalizedRow]) -> list[float]:
    predictions = [0.0] * len(rows)
    for test_indices in stratified_folds(rows):
        test_set = set(test_indices)
        training_rows = [row for index, row in enumerate(rows) if index not in test_set]
        model = fit_logistic(training_rows)
        for index in test_indices:
            predictions[index] = predict_model(model, rows[index])
    return predictions


def roc_auc(targets: list[int], scores: list[float]) -> float:
    grouped: dict[float, list[int]] = defaultdict(list)
    for target, score in zip(targets, scores):
        grouped[score].append(target)
    positives = sum(targets)
    negatives = len(targets) - positives
    negatives_before = 0
    concordance = 0.0
    for score in sorted(grouped):
        values = grouped[score]
        group_positives = sum(values)
        group_negatives = len(values) - group_positives
        concordance += group_positives * (
            negatives_before + 0.5 * group_negatives
        )
        negatives_before += group_negatives
    return concordance / (positives * negatives)


def average_precision(targets: list[int], scores: list[float]) -> float:
    grouped: dict[float, list[int]] = defaultdict(list)
    for target, score in zip(targets, scores):
        grouped[score].append(target)
    positives = sum(targets)
    true_positives = 0
    false_positives = 0
    result = 0.0
    for score in sorted(grouped, reverse=True):
        values = grouped[score]
        group_positives = sum(values)
        true_positives += group_positives
        false_positives += len(values) - group_positives
        precision = true_positives / (true_positives + false_positives)
        result += (group_positives / positives) * precision
    return result


def ranking_metrics(rows: list[NormalizedRow], scores: list[float]) -> dict[str, float | int]:
    targets = [1 if row["outcome"] == "Cerrado" else 0 for row in rows]
    baseline = sum(targets) / len(targets)
    ranked = sorted(
        range(len(rows)),
        key=lambda index: (-scores[index], str(rows[index]["leadId"])),
    )

    def conversion_at(fraction: float) -> float:
        count = max(1, math.ceil(len(rows) * fraction))
        return sum(targets[index] for index in ranked[:count]) / count

    conversion_10 = conversion_at(0.10)
    conversion_20 = conversion_at(0.20)
    return {
        "sampleSize": len(rows),
        "positives": sum(targets),
        "baselineConversionRate": round(baseline, 6),
        "rocAuc": round(roc_auc(targets, scores), 6),
        "averagePrecision": round(average_precision(targets, scores), 6),
        "conversionAtTop10": round(conversion_10, 6),
        "conversionAtTop20": round(conversion_20, 6),
        "liftAt10": round(conversion_10 / baseline, 6),
        "liftAt20": round(conversion_20 / baseline, 6),
    }


def random_baseline(rows: list[NormalizedRow]) -> dict[str, float | int]:
    positives = sum(row["outcome"] == "Cerrado" for row in rows)
    baseline = positives / len(rows)
    return {
        "sampleSize": len(rows),
        "positives": positives,
        "baselineConversionRate": round(baseline, 6),
        "rocAuc": 0.5,
        "averagePrecision": round(baseline, 6),
        "conversionAtTop10": round(baseline, 6),
        "conversionAtTop20": round(baseline, 6),
        "liftAt10": 1.0,
        "liftAt20": 1.0,
    }


def heuristic_score(row: NormalizedRow) -> float:
    # Intake-only comparator: appointment is strongest, then stated initial
    # payment and cash. This is a ranking rule, not a claimed probability.
    score = 0.0
    if row["requestedAppointment"] == "YES":
        score += 2.0
    if row["declaredDownPayment"] == "YES":
        score += 1.0
    if row["declaredPaymentMethod"] == "CASH":
        score += 1.0
    return score


def conversion_groups(
    rows: list[Row], field: str, value_transform: Callable[[str], str] | None = None
) -> list[dict[str, float | int | str]]:
    groups: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    for row in rows:
        value = row[field]
        if value_transform is not None:
            value = value_transform(value)
        value = value or "MISSING"
        groups[value][0] += 1
        groups[value][1] += int(row["desenlace"] == "Cerrado")
    return [
        {
            "value": value,
            "records": counts[0],
            "closed": counts[1],
            "conversionRate": round(counts[1] / counts[0], 6),
        }
        for value, counts in sorted(groups.items())
    ]


def first_contact_bucket(value: str) -> str:
    if not value:
        return "missing/unmanaged"
    hours = float(value)
    if hours <= 1:
        return "<=1h"
    if hours <= 4:
        return "1-4h"
    if hours <= 8:
        return "4-8h"
    if hours <= 24:
        return "8-24h"
    if hours <= 48:
        return "24-48h"
    return ">48h"


def feature_availability() -> list[dict[str, str | bool]]:
    return [
        {
            "field": "lead_id",
            "class": "A",
            "included": False,
            "reason": "Available identifier, but has no transferable commercial meaning.",
        },
        {
            "field": "fecha_registro",
            "class": "A",
            "included": False,
            "reason": "Available, but excluded to avoid fragile date/season memorization in five months of synthetic data.",
        },
        {
            "field": "canal",
            "class": "A",
            "included": True,
            "reason": "Known at lead creation.",
        },
        {
            "field": "empresa_id",
            "class": "A",
            "included": True,
            "reason": "Known tenant context at lead creation.",
        },
        {
            "field": "punto_venta_id",
            "class": "A",
            "included": True,
            "reason": "Known routing context at lead creation.",
        },
        {
            "field": "modelo_cotizado",
            "class": "A",
            "included": True,
            "reason": "Quoted motorcycle is supplied as initial lead context.",
        },
        {
            "field": "precio_lista",
            "class": "A",
            "included": True,
            "reason": "Catalog price of the quoted model is known at prioritization.",
        },
        {
            "field": "horas_al_primer_contacto",
            "class": "B",
            "included": False,
            "reason": "Post-treatment response-time outcome; descriptive analysis only.",
        },
        {
            "field": "numero_contactos",
            "class": "B",
            "included": False,
            "reason": "Accumulated after sales management starts.",
        },
        {
            "field": "manifesto_cuota_inicial",
            "class": "C",
            "included": True,
            "reason": "Included under explicit assumption that this declaration is captured in the inbound lead before advisor contact.",
        },
        {
            "field": "forma_pago_declarada",
            "class": "C",
            "included": True,
            "reason": "Included under explicit assumption that declared payment method is captured in the inbound lead.",
        },
        {
            "field": "pidio_cita",
            "class": "C",
            "included": True,
            "reason": "Included under explicit assumption that appointment request is customer-provided before prioritization.",
        },
        {
            "field": "desenlace",
            "class": "B",
            "included": False,
            "reason": "Post-management outcome and model target.",
        },
    ]


def descriptive_analysis(rows: list[Row]) -> dict[str, object]:
    outcome_counts = {
        outcome: sum(row["desenlace"] == outcome for row in rows)
        for outcome in ("Cerrado", "Perdido", "Sin gestión")
    }
    return {
        "totalRecords": len(rows),
        "closed": outcome_counts["Cerrado"],
        "lost": outcome_counts["Perdido"],
        "unmanaged": outcome_counts["Sin gestión"],
        "overallConversionRate": round(outcome_counts["Cerrado"] / len(rows), 6),
        "conversionBy": {
            "channel": conversion_groups(rows, "canal", canonical_channel),
            "company": conversion_groups(rows, "empresa_id"),
            "salesPoint": conversion_groups(rows, "punto_venta_id"),
            "motorcycleModel": conversion_groups(rows, "modelo_cotizado"),
            "declaredPaymentMethod": conversion_groups(
                rows, "forma_pago_declarada", canonical_payment_method
            ),
            "declaredDownPayment": conversion_groups(
                rows, "manifesto_cuota_inicial", canonical_down_payment
            ),
            "appointmentRequested": conversion_groups(
                rows, "pidio_cita", canonical_appointment
            ),
            "firstContactTimeDescriptiveOnly": conversion_groups(
                rows, "horas_al_primer_contacto", first_contact_bucket
            ),
        },
    }


def data_quality_observations(rows: list[Row]) -> dict[str, object]:
    with CATALOG_PATH.open(newline="", encoding="utf-8-sig") as source:
        catalog_rows = list(csv.DictReader(source))
    catalog = {
        f"{row['marca']} {row['linea']}": {
            "price": row["precio_lista"],
            "salesPoints": set(row["puntos_venta_disponibles"].split("|")),
        }
        for row in catalog_rows
    }
    unknown_models = [
        row["lead_id"] for row in rows if row["modelo_cotizado"] not in catalog
    ]
    price_mismatches = [
        row["lead_id"]
        for row in rows
        if row["modelo_cotizado"] in catalog
        and row["precio_lista"] != catalog[row["modelo_cotizado"]]["price"]
    ]
    unavailable_model_sales_point_pairs = [
        row["lead_id"]
        for row in rows
        if row["modelo_cotizado"] in catalog
        and row["punto_venta_id"]
        not in catalog[row["modelo_cotizado"]]["salesPoints"]
    ]
    unmanaged = [row for row in rows if row["desenlace"] == "Sin gestión"]
    return {
        "unknownCatalogModels": len(unknown_models),
        "catalogPriceMismatches": len(price_mismatches),
        "modelSalesPointAvailabilityMismatches": {
            "records": len(unavailable_model_sales_point_pairs),
            "rate": round(len(unavailable_model_sales_point_pairs) / len(rows), 6),
            "interpretation": "Quoted model/store context conflicts with current catalog availability; retained as source evidence, not silently corrected.",
        },
        "unmanagedWithAppointmentRequest": {
            "records": sum(row["pidio_cita"] == "SI" for row in unmanaged),
            "unmanagedRecords": len(unmanaged),
            "interpretation": "Supports treating appointment timing as uncertain: an inbound request can exist even when no sales management occurred.",
        },
    }


def model_artifact(
    model: TrainedModel,
    model_a_metrics: dict[str, float | int],
    model_b_metrics: dict[str, float | int],
    baselines: dict[str, object],
    training_size: int,
) -> dict[str, object]:
    categorical: list[dict[str, object]] = []
    for feature in model.design.categories:
        categorical.append(
            {
                "name": feature.name,
                "sourceField": feature.source_field,
                "categories": list(feature.categories),
                "referenceCategory": feature.reference,
                "coefficients": {
                    category: model.coefficients[index]
                    for category, index in feature.indices.items()
                },
                "unknownCategoryPolicy": "zero_contribution",
            }
        )
    excluded = [
        item
        for item in feature_availability()
        if not bool(item["included"])
    ]
    return {
        "schemaVersion": 1,
        "modelVersion": MODEL_VERSION,
        "trainedAt": date.today().isoformat(),
        "algorithm": {
            "name": "l2_regularized_logistic_regression",
            "optimizer": "deterministic_batch_adam",
            "l2Strength": L2_STRENGTH,
            "epochs": TRAINING_EPOCHS,
            "randomSeed": RANDOM_SEED,
        },
        "targetDefinition": {
            "positive": "desenlace == Cerrado",
            "negative": "every other desenlace value",
            "primaryPopulation": "all historical records",
        },
        "trainingPopulation": {
            "records": training_size,
            "source": "data/raw/historico_cierres.csv",
        },
        "featureDefinitions": feature_availability(),
        "features": {
            "categorical": categorical,
            "numeric": [
                {
                    "name": "listPrice",
                    "sourceField": "precio_lista",
                    "mean": model.design.price_mean,
                    "scale": model.design.price_scale,
                    "coefficient": model.coefficients[model.design.price_index],
                }
            ],
        },
        "intercept": model.intercept,
        "evaluation": {
            "method": "deterministic stratified 5-fold out-of-fold validation",
            "modelA": model_a_metrics,
            "modelB": model_b_metrics,
            "baselineComparisonModelA": baselines,
        },
        "excludedFields": excluded,
        "limitations": [
            "Synthetic data with only 197 closures limits external validity.",
            "Historical tabular data has limited predictive signal.",
            "Uncertain intake fields require confirmation before production use.",
            "Almost half of historical model/store pairs conflict with catalog availability, so inventory must remain a separate current-state component.",
            "The heuristic was selected after descriptive inspection; it is an exploratory comparator, not an independently validated policy.",
            "This propensity is one prioritization component, not an autonomous sales decision-maker.",
        ],
    }


def artifact_input(row: NormalizedRow) -> dict[str, str | float | bool]:
    return {
        "channel": str(row["channel"]),
        "companyId": str(row["companyId"]),
        "salesPointId": str(row["salesPointId"]),
        "motorcycleModel": str(row["motorcycleModel"]),
        "listPrice": float(row["listPrice"]),
        "declaredDownPayment": str(row["declaredDownPayment"]),
        "declaredPaymentMethod": str(row["declaredPaymentMethod"]),
        "requestedAppointment": row["requestedAppointment"] == "YES",
    }


def predict_artifact(
    artifact: dict[str, object], input_row: dict[str, str | float | bool]
) -> tuple[float, float]:
    log_odds = float(artifact["intercept"])
    features = artifact["features"]
    if not isinstance(features, dict):
        raise TypeError("Artifact features must be an object")
    categorical = features["categorical"]
    numeric = features["numeric"]
    if not isinstance(categorical, list) or not isinstance(numeric, list):
        raise TypeError("Artifact feature lists are malformed")
    for feature in categorical:
        if not isinstance(feature, dict):
            raise TypeError("Categorical feature is malformed")
        name = str(feature["name"])
        value: str
        if name == "requestedAppointment":
            value = "YES" if bool(input_row[name]) else "NO"
        else:
            value = str(input_row[name])
        coefficients = feature["coefficients"]
        if not isinstance(coefficients, dict):
            raise TypeError("Categorical coefficients are malformed")
        log_odds += float(coefficients.get(value, 0.0))
    for feature in numeric:
        if not isinstance(feature, dict):
            raise TypeError("Numeric feature is malformed")
        value = float(input_row[str(feature["name"])])
        log_odds += (
            (value - float(feature["mean"]))
            / float(feature["scale"])
            * float(feature["coefficient"])
        )
    return sigmoid(log_odds), log_odds


def parity_fixtures(
    artifact: dict[str, object], rows: list[NormalizedRow]
) -> dict[str, object]:
    selected = [
        ("known-lost", rows[0]),
        (
            "known-closed",
            next(row for row in rows if row["outcome"] == "Cerrado"),
        ),
    ]
    fixtures: list[dict[str, object]] = []
    for name, row in selected:
        input_row = artifact_input(row)
        probability, log_odds = predict_artifact(artifact, input_row)
        fixtures.append(
            {
                "name": name,
                "input": input_row,
                "expectedProbability": probability,
                "expectedLogOdds": log_odds,
            }
        )
    unknown_input: dict[str, str | float | bool] = {
        "channel": "PARTNER_REFERRAL",
        "companyId": "EMP-UNKNOWN",
        "salesPointId": "PV-UNKNOWN",
        "motorcycleModel": "Unknown Future Model",
        "listPrice": 12_000_000.0,
        "declaredDownPayment": "UNKNOWN",
        "declaredPaymentMethod": "UNKNOWN",
        "requestedAppointment": False,
    }
    probability, log_odds = predict_artifact(artifact, unknown_input)
    fixtures.append(
        {
            "name": "unknown-categories",
            "input": unknown_input,
            "expectedProbability": probability,
            "expectedLogOdds": log_odds,
        }
    )
    return {
        "schemaVersion": 1,
        "modelVersion": MODEL_VERSION,
        "generatedBy": "analysis/train_propensity.py",
        "tolerance": 1e-12,
        "fixtures": fixtures,
    }


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=False) + "\n",
        encoding="utf-8",
    )


def main() -> None:
    raw_rows = read_rows()
    exact_outcomes = sorted({row["desenlace"] for row in raw_rows})
    if exact_outcomes != ["Cerrado", "Perdido", "Sin gestión"]:
        raise ValueError(f"Unexpected desenlace values: {exact_outcomes}")

    normalized = [normalize_row(row) for row in raw_rows]
    managed = [row for row in normalized if row["outcome"] != "Sin gestión"]

    model_a_predictions = cross_validated_predictions(normalized)
    model_b_predictions = cross_validated_predictions(managed)
    model_a_metrics = ranking_metrics(normalized, model_a_predictions)
    model_b_metrics = ranking_metrics(managed, model_b_predictions)

    baselines: dict[str, object] = {
        "randomExpected": random_baseline(normalized),
        "intakeHeuristic": ranking_metrics(
            normalized, [heuristic_score(row) for row in normalized]
        ),
        "logisticPropensity": model_a_metrics,
        "heuristicDefinition": {
            "requestedAppointmentYES": 2,
            "declaredDownPaymentYES": 1,
            "declaredPaymentMethodCASH": 1,
        },
    }

    final_model = fit_logistic(normalized)
    artifact = model_artifact(
        final_model,
        model_a_metrics,
        model_b_metrics,
        baselines,
        len(normalized),
    )
    analysis = {
        "schemaVersion": 1,
        "analysisVersion": ANALYSIS_VERSION,
        "generatedAt": date.today().isoformat(),
        "dataset": {
            "path": "data/raw/historico_cierres.csv",
            "synthetic": True,
            "exactOutcomeValues": exact_outcomes,
        },
        "businessQuestion": "Can available historical information separate leads that eventually closed from leads that did not?",
        "targetPopulations": {
            "modelA": {
                "definition": "Cerrado = 1; Perdido and Sin gestión = 0",
                "records": len(normalized),
                "positiveRecords": sum(
                    row["outcome"] == "Cerrado" for row in normalized
                ),
            },
            "modelB": {
                "definition": "Cerrado = 1; Perdido = 0; Sin gestión excluded",
                "records": len(managed),
                "positiveRecords": sum(
                    row["outcome"] == "Cerrado" for row in managed
                ),
                "exclusionRationale": "All 179 Sin gestión rows have missing horas_al_primer_contacto and numero_contactos = 0, so no observed sales-management opportunity exists.",
            },
        },
        "featureAvailability": feature_availability(),
        "dataQualityObservations": data_quality_observations(raw_rows),
        "descriptive": descriptive_analysis(raw_rows),
        "validation": {
            "method": {
                "folds": FOLDS,
                "stratified": True,
                "randomSeed": RANDOM_SEED,
                "predictionType": "out-of-fold",
                "rankingTieBreak": "leadId ascending",
            },
            "modelA": model_a_metrics,
            "modelB": model_b_metrics,
            "baselineComparisonModelA": baselines,
        },
        "modelDecision": {
            "chosenArtifactPopulation": "Model A: all records",
            "reason": "It follows the primary target without silently discarding operationally real leads. Model B remains sensitivity evidence.",
            "categoryRateHandling": "No raw store/model rate is used directly. L2 regularization shrinks one-hot category coefficients toward zero.",
            "persistence": "Raw historical rows remain offline inputs; no PostgreSQL table is added because runtime inference only needs the versioned artifact.",
        },
        "limitations": artifact["limitations"],
    }
    parity = parity_fixtures(artifact, normalized)

    write_json(MODEL_PATH, artifact)
    write_json(ANALYSIS_PATH, analysis)
    write_json(PARITY_PATH, parity)

    print(f"Historical rows: {len(normalized)}")
    print(
        "Outcomes: "
        f"Cerrado={analysis['descriptive']['closed']}, "
        f"Perdido={analysis['descriptive']['lost']}, "
        f"Sin gestión={analysis['descriptive']['unmanaged']}"
    )
    print(f"Model A metrics: {json.dumps(model_a_metrics, ensure_ascii=False)}")
    print(f"Model B metrics: {json.dumps(model_b_metrics, ensure_ascii=False)}")
    print(f"Artifact: {MODEL_PATH.relative_to(ROOT)}")
    print(f"Analysis: {ANALYSIS_PATH.relative_to(ROOT)}")
    print(f"Parity fixtures: {PARITY_PATH.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
