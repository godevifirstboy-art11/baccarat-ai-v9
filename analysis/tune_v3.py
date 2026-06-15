#!/usr/bin/env python3
"""Tuning local autour du meilleur point trouvé"""
import json, random, sys
sys.path.insert(0, '/home/user/webapp/analysis')
from engine_v9 import backtest, HANDS, SUITS

random.seed(7)

# Best found previously
SEEDS = {
    'p1': {'freq': 0.324, 'coverage': 0.015, 'markov': 0.451, 'momentum': 0.052, 'color': 0.009, 'least_recent': 0.149},
    'p2': {'freq': 0.09, 'coverage': 0.278, 'markov': 0.402, 'momentum': 0.062, 'color': 0.065, 'least_recent': 0.103},
}

def score(r):
    # Penalize hard if in_set < 0.55
    s = 0.65 * r['in_set'] + 0.35 * r['cover2'] - 0.003 * r['max_consecutive_loss']
    if r['in_set'] < 0.55: s -= 0.03
    return s

def perturb(w, scale=0.1):
    new = {k: max(0.001, v + random.uniform(-scale, scale)) for k, v in w.items()}
    s = sum(new.values())
    return {k: v/s for k,v in new.items()}

for side in ['p1','p2']:
    best = {'weights': SEEDS[side], 'score': -999, 'result': None}
    r0 = backtest(HANDS, weights=SEEDS[side], side=side, rattrapage_after=1)
    best['score'] = score(r0); best['result'] = r0
    print(f'[{side}] seed: in_set={r0["in_set"]} cover2={r0["cover2"]} max_loss={r0["max_consecutive_loss"]} score={best["score"]:.4f}')
    for trial in range(400):
        scale = 0.20 if trial < 200 else 0.06
        w = perturb(best['weights'], scale=scale)
        r = backtest(HANDS, weights=w, side=side, rattrapage_after=1)
        sc = score(r)
        if sc > best['score']:
            best = {'weights': w, 'score': sc, 'result': r}
            print(f'[{side}] t{trial:03d}: NEW BEST in_set={r["in_set"]} cover2={r["cover2"]} max_loss={r["max_consecutive_loss"]} score={sc:.4f}')
    print(f'\n=== FINAL {side.upper()} ===')
    print('weights:', {k: round(v,3) for k,v in best['weights'].items()})
    r = best['result']
    print(f'  exact={r["exact"]} in_set={r["in_set"]} color={r["color"]} cover2={r["cover2"]} max_loss={r["max_consecutive_loss"]} rattrap_acc_cover2={r["rattrapage_accuracy_cover2"]}')
    with open(f'/home/user/webapp/analysis/best_weights_{side}.json','w') as f:
        json.dump({'weights': best['weights'], 'metrics': {k:v for k,v in r.items() if k!='history_tail'}}, f, indent=2)
