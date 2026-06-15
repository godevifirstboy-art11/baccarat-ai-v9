#!/usr/bin/env python3
"""Tuning plus poussé : objectif clair = in_set ≥ 55% pour P1 et P2"""
import json, random, math, sys
sys.path.insert(0, '/home/user/webapp/analysis')
from engine_v9 import backtest, HANDS, SUITS

random.seed(123)

def random_weights():
    parts = [random.random() for _ in range(6)]
    s = sum(parts) or 1
    keys = ['freq','coverage','markov','momentum','color','least_recent']
    return {k: parts[i]/s for i,k in enumerate(keys)}

# Score prioritize in_set + cover2 minus loss
def score(r):
    return 0.65 * r['in_set'] + 0.35 * r['cover2'] - 0.003 * r['max_consecutive_loss']

for side in ['p1','p2']:
    best = None
    for trial in range(2000):
        w = random_weights()
        r = backtest(HANDS, weights=w, side=side, rattrapage_after=1)
        sc = score(r)
        if best is None or sc > best['score']:
            best = {'weights': w, 'result': r, 'score': sc}
    print(f'\n=== BEST {side.upper()} score={best["score"]:.4f} ===')
    print('weights:', {k: round(v,3) for k,v in best['weights'].items()})
    r = best['result']
    print(f'  exact={r["exact"]:.4f} in_set={r["in_set"]:.4f} color={r["color"]:.4f} cover2={r["cover2"]:.4f}')
    print(f'  max_loss={r["max_consecutive_loss"]} rattrap_acc_inset={r["rattrapage_accuracy_inset"]:.4f} acc_cover2={r["rattrapage_accuracy_cover2"]:.4f}')
    # save
    out_file = f'/home/user/webapp/analysis/best_weights_{side}.json'
    with open(out_file, 'w') as f:
        json.dump({'weights': best['weights'], 'metrics': {k:v for k,v in r.items() if k!='history_tail'}}, f, indent=2)
