"""Train CNN + MLP from offline game samples and export browser weights."""
import argparse
import json
from pathlib import Path

import numpy as np
import torch
from sklearn.model_selection import GroupShuffleSplit
from sklearn.preprocessing import StandardScaler
from torch import nn

HERE = Path(__file__).resolve().parent
ROWS, COLS, CHANNELS = 9, 16, 6
POOL = (2, 2)


class DeploymentNet(nn.Module):
    def __init__(self, feature_count, use_map):
        super().__init__()
        self.conv = nn.Sequential(
            nn.Conv2d(CHANNELS, 12, 3, stride=2, padding=1),
            nn.ReLU(),
            nn.Conv2d(12, 16, 3, stride=2, padding=1),
            nn.ReLU(),
            nn.AdaptiveAvgPool2d(POOL),
            nn.Flatten(),
        ) if use_map else None
        self.head = nn.Sequential(
            nn.Linear(feature_count + (16 * POOL[0] * POOL[1] if use_map else 0), 96),
            nn.ReLU(),
            nn.Linear(96, 48),
            nn.ReLU(),
            nn.Linear(48, 1),
        )

    def forward(self, features, grid):
        if self.conv is not None:
            features = torch.cat((features, self.conv(grid)), dim=1)
        return self.head(features).squeeze(-1)


def load_data(paths):
    records = []
    for path in paths:
        with path.open(encoding="utf-8") as source:
            records.extend(json.loads(line) for line in source)
    features = np.asarray([row["features"] for row in records], dtype=np.float32)
    grid = np.zeros((len(records), CHANNELS, ROWS * COLS), dtype=np.float32)
    for i, row in enumerate(records):
        for channel, cells in enumerate(row["map"]):
            grid[i, channel, cells] = (
                np.linspace(1, 2, len(cells), dtype=np.float32) if channel == CHANNELS - 1 else 1
            )
    keys = np.asarray([row["group"] for row in records])
    baseline = np.asarray([row["baseline"] for row in records], dtype=bool)
    # Match identical starting layouts at the same wave even when seed or balance differs.
    group_by_key = {
        keys[i]: (int(features[i, 0]), tuple(tuple(sorted(p)) for p in records[i]["map"][:-1]))
        for i in np.flatnonzero(baseline)
    }
    group_ids = {}
    groups = np.array([group_ids.setdefault(group_by_key[k], len(group_ids)) for k in keys])
    target = np.asarray([row["leaked"] for row in records], dtype=np.float32)
    totals = np.asarray([row["total"] for row in records], dtype=np.float32)
    return (features, grid.reshape(-1, CHANNELS, ROWS, COLS), target, totals, keys, groups, baseline)


@torch.no_grad()
def estimate(net, x, map_data, total, ids):
    output = []
    for batch in ids.split(1024):
        output.append(net(x[batch], map_data[batch]).clamp(0, 1) * total[batch])
    return torch.cat(output)


def train(x, grid, leaked, total, train_ids, valid_ids, epochs, use_map):
    torch.manual_seed(42)
    net = DeploymentNet(x.shape[1], use_map)
    optimizer = torch.optim.AdamW(net.parameters(), lr=0.0015, weight_decay=0.0005)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=epochs, eta_min=0.00015)
    best_error = float("inf")
    best_weights = None
    best_epoch = 0
    for epoch in range(1, epochs + 1):
        net.train()
        for ids in train_ids[torch.randperm(train_ids.numel())].split(384):
            optimizer.zero_grad(set_to_none=True)
            output = net(x[ids], grid[ids])
            error = (output * total[ids] - leaked[ids]) / total[ids].sqrt()
            loss = torch.nn.functional.smooth_l1_loss(error, torch.zeros_like(error), beta=0.45)
            loss.backward()
            optimizer.step()
        scheduler.step()
        net.eval()
        prediction = estimate(net, x, grid, total, valid_ids)
        error = (prediction - leaked[valid_ids]).abs().mean().item()
        if error < best_error:
            best_error, best_epoch = error, epoch
            best_weights = {name: value.clone() for name, value in net.state_dict().items()}
        if epoch == 1 or epoch % 10 == 0:
            print(f"{'CNN+MLP' if use_map else 'MLP'} epoch {epoch:2d} | validation MAE {error:.3f}", flush=True)
    net.load_state_dict(best_weights)
    net.eval()
    print(f"Selected epoch {best_epoch}, validation MAE {best_error:.3f}", flush=True)
    return net


def report(prediction, actual, test_ids, keys, baseline, features):
    groups = {}
    for local, row in enumerate(test_ids):
        groups.setdefault(keys[row], []).append(local)
    selected = []
    random_result = []
    for indices in groups.values():
        start = next(i for i in indices if baseline[test_ids[i]])
        choices = [i for i in indices if i != start]
        if choices:
            best = min(choices, key=lambda i: prediction[i])
            selected.append(actual[best] if prediction[best] + 0.25 < prediction[start] else actual[start])
            random_result.append(np.mean(actual[choices]))
    errors = np.abs(prediction - actual)
    boss = np.isin(features[test_ids, 0], [7, 15, 23])
    return {
        "testMAE": float(errors.mean()),
        "fastBossMAE": float(errors[boss].mean()) if boss.any() else None,
        "sampledAdviceLeaks": float(np.mean(selected)),
        "sampledRandomLeaks": float(np.mean(random_result)),
    }


def array(tensor):
    return tensor.detach().numpy().astype(np.float64).round(8).tolist()


def export(net, scaler, max_wave, output):
    model = {
        "maxWave": max_wave,
        "mean": scaler.mean_.tolist(),
        "scale": scaler.scale_.tolist(),
        "layers": [
            {"weights": array(layer.weight), "bias": array(layer.bias)}
            for layer in net.head if isinstance(layer, nn.Linear)
        ],
    }
    if net.conv is not None:
        model.update({
            "channels": CHANNELS, "pool": list(POOL),
            "conv": [
                {"weights": array(layer.weight.flatten(1)), "bias": array(layer.bias), "stride": layer.stride[0]}
                for layer in net.conv if isinstance(layer, nn.Conv2d)
            ],
        })
    output.write_text(
        "// Generated by ml/train-deployment.py.\nwindow.TDDeploymentModel = "
        + json.dumps(model, separators=(",", ":"), allow_nan=False) + ";\n",
        encoding="utf-8",
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("data", nargs="*", type=Path, help="Defaults to ml/cnn-*.jsonl")
    parser.add_argument("--epochs", type=int, default=60)
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--mlp-only", action="store_true")
    parser.add_argument("--output", type=Path, default=HERE.parent / "deployment-model.js")
    args = parser.parse_args()
    torch.set_num_threads(args.threads)
    paths = args.data or sorted(HERE.glob("cnn-*.jsonl"))
    if not paths or args.epochs < 1:
        parser.error("Provide simulation data and a positive number of epochs")
    features, map_data, target, totals, keys, groups, baseline = load_data(paths)
    learn, test = next(GroupShuffleSplit(n_splits=1, test_size=0.20, random_state=42).split(features, groups=groups))
    train_index, valid_index = next(GroupShuffleSplit(n_splits=1, test_size=0.15, random_state=43).split(learn, groups=groups[learn]))
    train_ids, valid_ids = learn[train_index], learn[valid_index]
    print(f"Samples {len(target)} | train {len(train_ids)} | validation {len(valid_ids)} | test {len(test)}", flush=True)
    scaler = StandardScaler().fit(features[train_ids])
    x = torch.from_numpy(scaler.transform(features))
    maps, leaked, total = map(torch.from_numpy, (map_data, target, totals))
    net = train(
        x, maps, leaked, total, torch.from_numpy(train_ids), torch.from_numpy(valid_ids), args.epochs, not args.mlp_only,
    )
    prediction = estimate(net, x, maps, total, torch.from_numpy(test)).numpy()
    print(json.dumps(report(prediction, target[test], test, keys, baseline, features)), flush=True)
    export(net, scaler, int(features[train_ids, 0].max()), args.output)
    # Pair exported browser inference with Python predictions on the same untouched rows.
    for local in np.linspace(0, len(test) - 1, 4, dtype=int):
        i = test[local]
        print("parity", json.dumps({
            "features": features[i].tolist(),
            "map": [np.flatnonzero(plane).tolist() for plane in map_data[i, :-1]] + [
                np.flatnonzero(map_data[i, -1])[np.argsort(map_data[i, -1].flat[np.flatnonzero(map_data[i, -1])])].tolist()
            ],
            "total": float(totals[i]), "prediction": float(prediction[local]),
        }), flush=True)


if __name__ == "__main__":
    main()
