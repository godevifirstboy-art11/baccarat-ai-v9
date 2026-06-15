#!/usr/bin/env python3
"""
Moteur V9 Ultra C — Fusion de sous-moteurs avec poids appris.
Test rigoureux sur 915 mains réelles + métriques mode rattrapage.
"""
import json, math, random
from collections import Counter, defaultdict
from copy import deepcopy

SUITS = ['♠','♥','♦','♣']
RED = {'♥','♦'}
ENEMY = {'♠':'♣','♣':'♠','♥':'♦','♦':'♥'}
CROSS  = {'♠':'♥','♣':'♦','♥':'♠','♦':'♣'}

with open('/home/user/webapp/analysis/hands_parsed.json','r',encoding='utf-8') as f:
    HANDS = json.load(f)

# ════════════════════════════════════════════
# Sous-moteurs : chaque produit une distribution {♠:p,♥:p,♦:p,♣:p}
# ════════════════════════════════════════════

def normalize(d):
    s = sum(d.values()) or 1
    return {k: v/s for k,v in d.items()}

def engine_freq(ctx, side, K=20, decay=0.95):
    """Fréquence pondérée par récence (decay exponentielle)"""
    cnt = {s:0.0 for s in SUITS}
    for i, h in enumerate(ctx[-K:]):
        w = decay ** (K - i - 1)
        cnt[h[f'{side}_first']] += w
    return normalize(cnt)

def engine_coverage(ctx, side, K=20, decay=0.95):
    """Probabilité que chaque enseigne apparaisse dans P (toutes cartes), pondérée"""
    cnt = {s:0.0 for s in SUITS}
    for i, h in enumerate(ctx[-K:]):
        w = decay ** (K - i - 1)
        for s in set(h[f'{side}_suits']):
            cnt[s] += w
    return normalize(cnt)

def engine_markov(ctx, side, last_n=200):
    """Markov ordre 1+2 mélangés"""
    seq = [h[f'{side}_first'] for h in ctx[-last_n:]]
    if len(seq) < 5:
        return {s:0.25 for s in SUITS}
    last = seq[-1]; last2 = seq[-2] if len(seq)>1 else last
    m1 = {s:0 for s in SUITS}
    m2 = {s:0 for s in SUITS}
    for i in range(1, len(seq)):
        if seq[i-1] == last: m1[seq[i]] += 1
    for i in range(2, len(seq)):
        if seq[i-2] == last2 and seq[i-1] == last: m2[seq[i]] += 1
    n1 = sum(m1.values()) or 1
    n2 = sum(m2.values()) or 1
    out = {s: 0.5*(m1[s]/n1) + 0.5*(m2[s]/n2) if n2>3 else m1[s]/n1 for s in SUITS}
    # Laplace smooth
    out = {s: out[s]+0.05 for s in SUITS}
    return normalize(out)

def engine_momentum(ctx, side):
    """Streak / momentum : si une enseigne sort 3× en 5 mains → boost"""
    if len(ctx) < 5:
        return {s:0.25 for s in SUITS}
    seq = [h[f'{side}_first'] for h in ctx[-7:]]
    c = Counter(seq)
    base = {s: 0.20 for s in SUITS}
    for s, n in c.items():
        if n >= 3: base[s] += 0.30
        elif n >= 2: base[s] += 0.10
    # Penalize the very-last suit a tiny bit (anti-streak rebound)
    last = seq[-1]
    base[last] *= 0.85
    return normalize(base)

def engine_color_guard(ctx, side, K=15):
    """Color momentum: pousse vers la couleur dominante"""
    if len(ctx) < K:
        return {s:0.25 for s in SUITS}
    seq = [h[f'{side}_first'] for h in ctx[-K:]]
    n_red = sum(1 for s in seq if s in RED)
    n_blk = K - n_red
    red_pref = n_red / K
    out = {}
    for s in SUITS:
        if s in RED:
            out[s] = 0.5 * red_pref
        else:
            out[s] = 0.5 * (1 - red_pref)
    return normalize(out)

def engine_least_recent(ctx, side, K=10):
    """Anti-streak: la moins fréquente récemment"""
    if len(ctx) < K:
        return {s:0.25 for s in SUITS}
    seq = [h[f'{side}_first'] for h in ctx[-K:]]
    c = {s:0 for s in SUITS}
    for x in seq: c[x] += 1
    # inverse weight
    inv = {s: 1.0/(1 + c[s]) for s in SUITS}
    return normalize(inv)

# ════════════════════════════════════════════
# FUSION
# ════════════════════════════════════════════

DEFAULT_WEIGHTS = {
    'freq': 0.20,
    'coverage': 0.30,
    'markov': 0.15,
    'momentum': 0.10,
    'color': 0.15,
    'least_recent': 0.10,
}

def predict_fusion(ctx, side, weights=None, mode='normal'):
    """
    Returns (best_suit, second_best_suit, confidence, distribution)
    confidence is the max prob in fused distribution (0..1)
    """
    if weights is None:
        weights = DEFAULT_WEIGHTS
    engines = {
        'freq':         engine_freq(ctx, side, K=20),
        'coverage':     engine_coverage(ctx, side, K=25),
        'markov':       engine_markov(ctx, side),
        'momentum':     engine_momentum(ctx, side),
        'color':        engine_color_guard(ctx, side, K=15),
        'least_recent': engine_least_recent(ctx, side, K=10),
    }
    fused = {s: 0.0 for s in SUITS}
    for ename, dist in engines.items():
        w = weights.get(ename, 0)
        for s in SUITS:
            fused[s] += w * dist[s]
    fused = normalize(fused)

    if mode == 'rattrapage':
        # rattrapage : pousse vers coverage (couverture max) et exclut potentiellement la perdante
        cov = engine_coverage(ctx, side, K=30)
        for s in SUITS:
            fused[s] = 0.4*fused[s] + 0.6*cov[s]
        fused = normalize(fused)

    sorted_suits = sorted(SUITS, key=lambda s: -fused[s])
    best = sorted_suits[0]; second = sorted_suits[1]
    confidence = fused[best]
    return best, second, confidence, fused

# ════════════════════════════════════════════
# BACKTEST
# ════════════════════════════════════════════

def backtest(hands, weights=None, side='p1', rattrapage_after=1):
    """
    Full backtest with rattrapage logic.
    - rattrapage_after = N : after N consecutive losses (on in_set), switch to 'rattrapage' mode
      which predicts TWO suits to cover.
    """
    n_exact = n_inset = n_color = 0
    n_2suits_cover = 0   # rattrapage : if first OR second covers
    tot = 0
    cur_loss = 0
    max_loss = 0
    loss_distrib = Counter()
    history = []
    in_rattrapage_results = []

    for i in range(30, len(hands)):
        ctx = hands[:i]
        actual = hands[i]
        first = actual[f'{side}_first']
        suits_full = set(actual[f'{side}_suits'])

        in_rattrapage = cur_loss >= rattrapage_after
        mode = 'rattrapage' if in_rattrapage else 'normal'
        best, second, conf, dist = predict_fusion(ctx, side, weights, mode=mode)

        tot += 1
        exact = (best == first)
        inset = (best in suits_full)
        col_match = ((best in RED) == (first in RED))

        # Rattrapage: cover 2 suits
        cover2 = (best in suits_full) or (second in suits_full)

        if exact: n_exact += 1
        if inset: n_inset += 1
        if col_match: n_color += 1
        if cover2: n_2suits_cover += 1

        # Loss tracking based on chosen success criterion (in_set for single, cover2 for rattrapage)
        success = cover2 if in_rattrapage else inset

        if in_rattrapage:
            in_rattrapage_results.append({'inset': inset, 'cover2': cover2, 'exact': exact})

        if success:
            if cur_loss > 0:
                loss_distrib[cur_loss] += 1
            cur_loss = 0
        else:
            cur_loss += 1
            max_loss = max(max_loss, cur_loss)

        history.append({
            'gameNum': actual['gameNum'],
            'pred': best, 'second': second, 'actual_first': first,
            'in_set': inset, 'exact': exact, 'rattrapage': in_rattrapage,
            'confidence': round(conf, 3),
        })

    # final loss
    if cur_loss > 0: loss_distrib[cur_loss] += 1

    n_rattrap = len(in_rattrapage_results)
    rattrap_acc_inset = sum(1 for r in in_rattrapage_results if r['inset']) / n_rattrap if n_rattrap else 0
    rattrap_acc_cover2 = sum(1 for r in in_rattrapage_results if r['cover2']) / n_rattrap if n_rattrap else 0

    return {
        'side': side,
        'n': tot,
        'exact': round(n_exact/tot,4),
        'in_set': round(n_inset/tot,4),
        'color': round(n_color/tot,4),
        'cover2': round(n_2suits_cover/tot,4),
        'max_consecutive_loss': max_loss,
        'loss_distribution': dict(loss_distrib),
        'rattrapage_count': n_rattrap,
        'rattrapage_accuracy_inset': round(rattrap_acc_inset, 4),
        'rattrapage_accuracy_cover2': round(rattrap_acc_cover2, 4),
        'history_tail': history[-10:],
    }

# Default weights run
print('=== BACKTEST avec poids par défaut ===\n')
for side in ['p1','p2']:
    r = backtest(HANDS, weights=DEFAULT_WEIGHTS, side=side, rattrapage_after=1)
    print(f'--- {side.upper()} ---')
    print(f'  N={r["n"]} exact={r["exact"]} in_set={r["in_set"]} color={r["color"]} cover2={r["cover2"]}')
    print(f'  max_loss_streak={r["max_consecutive_loss"]} loss_dist={r["loss_distribution"]}')
    print(f'  rattrapage_count={r["rattrapage_count"]} rattrap_acc_inset={r["rattrapage_accuracy_inset"]} cover2={r["rattrapage_accuracy_cover2"]}')

# ════════════════════════════════════════════
# Tune weights with grid + random search
# ════════════════════════════════════════════
print('\n=== Tuning des poids (random search 800 essais par side) ===')
random.seed(42)

def random_weights():
    parts = [random.random() for _ in range(6)]
    s = sum(parts) or 1
    keys = ['freq','coverage','markov','momentum','color','least_recent']
    return {k: parts[i]/s for i,k in enumerate(keys)}

def score(r):
    # We want to maximize cover2 (rattrapage success) AND in_set (normal success)
    # weighted: 0.6 in_set + 0.4 cover2, minus loss penalty
    return 0.55 * r['in_set'] + 0.45 * r['cover2'] - 0.005 * r['max_consecutive_loss']

best_side = {}
for side in ['p1','p2']:
    best = None
    for trial in range(800):
        w = random_weights()
        r = backtest(HANDS, weights=w, side=side, rattrapage_after=1)
        sc = score(r)
        if best is None or sc > best['score']:
            best = {'weights': w, 'result': r, 'score': sc}
    best_side[side] = best
    print(f'\n--- BEST {side.upper()} (score={best["score"]:.4f}) ---')
    print('  weights:', {k: round(v,3) for k,v in best['weights'].items()})
    r = best['result']
    print(f'  exact={r["exact"]} in_set={r["in_set"]} color={r["color"]} cover2={r["cover2"]}')
    print(f'  max_loss={r["max_consecutive_loss"]} rattrap_n={r["rattrapage_count"]} acc_inset={r["rattrapage_accuracy_inset"]} acc_cover2={r["rattrapage_accuracy_cover2"]}')

# Save best weights for production
with open('/home/user/webapp/analysis/best_weights.json','w',encoding='utf-8') as f:
    json.dump({side: {'weights': best_side[side]['weights'],
                      'result_summary': {k:v for k,v in best_side[side]['result'].items() if k!='history_tail'}}
               for side in best_side}, f, ensure_ascii=False, indent=2)
print('\nBest weights saved to analysis/best_weights.json')
