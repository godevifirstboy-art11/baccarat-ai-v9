#!/usr/bin/env python3
"""
Mesure empirique : si on prédit une enseigne S pour la prochaine main,
quelle est la probabilité que S apparaisse dans P1 (2-3 cartes) ?
Et quelle stratégie de choix de S maximise ce taux ?
"""
import json
from collections import Counter

SUITS = ['♠','♥','♦','♣']
RED = {'♥','♦'}

with open('/home/user/webapp/analysis/hands_parsed.json','r',encoding='utf-8') as f:
    hands = json.load(f)

print(f'Sample: {len(hands)} hands\n')

def test_strategy(name, predict_fn, side='p1'):
    """side: 'p1' or 'p2'. Tests 3 success criteria"""
    n_exact = n_in_set = n_color = 0
    tot = 0
    losses = []  # consecutive loss tracking on "in_set"
    cur_loss = 0
    max_loss = 0
    for i in range(20, len(hands)):
        ctx = hands[:i]   # past hands
        actual = hands[i]
        pred = predict_fn(ctx, side)
        if pred is None: continue
        suits_full = actual[f'{side}_suits']
        first = actual[f'{side}_first']
        tot += 1
        # Exact (first card)
        if pred == first:
            n_exact += 1
        # In set (any card)
        if pred in suits_full:
            n_in_set += 1
            cur_loss = 0
        else:
            cur_loss += 1
            max_loss = max(max_loss, cur_loss)
        # Color match
        if (pred in RED) == (first in RED):
            n_color += 1
    return {
        'name': name, 'side': side, 'samples': tot,
        'exact': round(n_exact/tot,4) if tot else 0,
        'in_set': round(n_in_set/tot,4) if tot else 0,
        'color': round(n_color/tot,4) if tot else 0,
        'max_consecutive_loss_inset': max_loss,
    }

# --- Strategies ---
def strat_top_window(K):
    def f(ctx, side):
        if len(ctx) < K: return None
        # Take the most common FIRST SUIT in the K-window
        seq = [h[f'{side}_first'] for h in ctx[-K:]]
        return Counter(seq).most_common(1)[0][0]
    return f

def strat_top_window_coverage(K):
    """Most common suit appearing in P1's full cards over last K hands (coverage logic)"""
    def f(ctx, side):
        if len(ctx) < K: return None
        cnt = Counter()
        for h in ctx[-K:]:
            for s in set(h[f'{side}_suits']):
                cnt[s] += 1
        return cnt.most_common(1)[0][0]
    return f

def strat_least_recent(K):
    """Pick the suit that appeared LEAST often in last K hands (rebound)"""
    def f(ctx, side):
        if len(ctx) < K: return None
        seq = [h[f'{side}_first'] for h in ctx[-K:]]
        c = Counter(seq)
        # default 0 for unseen
        for s in SUITS:
            c[s] += 0
        return min(SUITS, key=lambda s: c.get(s,0))
    return f

def strat_markov1():
    def f(ctx, side):
        if len(ctx) < 30: return None
        seq = [h[f'{side}_first'] for h in ctx]
        last = seq[-1]
        trans = Counter()
        for i in range(1, len(seq)):
            if seq[i-1] == last:
                trans[seq[i]] += 1
        if not trans: return last
        return trans.most_common(1)[0][0]
    return f

def strat_anti_last():
    def f(ctx, side):
        if not ctx: return None
        last = ctx[-1][f'{side}_first']
        # Opposite color, same "value position" → pick least recent in other color
        seq = [h[f'{side}_first'] for h in ctx[-10:]]
        c = Counter(seq)
        # pick suit NOT equal to last, minimum recency
        cands = [s for s in SUITS if s != last]
        return min(cands, key=lambda s: c.get(s,0))
    return f

def strat_fusion_simple():
    """Mix: half weight window coverage + half markov"""
    def f(ctx, side):
        if len(ctx) < 30: return None
        seq = [h[f'{side}_first'] for h in ctx]
        suits_seq = ctx
        # window coverage K=10
        cov = Counter()
        for h in ctx[-10:]:
            for s in set(h[f'{side}_suits']):
                cov[s] += 1
        # markov order 1
        last = seq[-1]
        mk = Counter()
        for i in range(1, len(seq)):
            if seq[i-1] == last:
                mk[seq[i]] += 1
        mk_tot = sum(mk.values()) or 1
        cov_tot = sum(cov.values()) or 1
        score = {}
        for s in SUITS:
            score[s] = 0.6 * (cov.get(s,0)/cov_tot) + 0.4 * (mk.get(s,0)/mk_tot)
        return max(SUITS, key=lambda s: score[s])
    return f

# Run all strategies on both sides
strategies = [
    ('top_window_K5', strat_top_window(5)),
    ('top_window_K10', strat_top_window(10)),
    ('top_window_K20', strat_top_window(20)),
    ('window_coverage_K10', strat_top_window_coverage(10)),
    ('window_coverage_K20', strat_top_window_coverage(20)),
    ('window_coverage_K40', strat_top_window_coverage(40)),
    ('least_recent_K10', strat_least_recent(10)),
    ('markov1', strat_markov1()),
    ('anti_last', strat_anti_last()),
    ('fusion_simple', strat_fusion_simple()),
]

print('=' * 92)
print(f'{"Strategy":<25} {"Side":<6} {"N":<6} {"exact":<8} {"in_set":<8} {"color":<8} {"maxLoss"}')
print('=' * 92)
results = []
for name, fn in strategies:
    for side in ['p1','p2']:
        r = test_strategy(name, fn, side)
        results.append(r)
        print(f'{name:<25} {side:<6} {r["samples"]:<6} {r["exact"]:<8} {r["in_set"]:<8} {r["color"]:<8} {r["max_consecutive_loss_inset"]}')
print('=' * 92)

# Baseline random (pick one suit, in_set should be ~ avg coverage)
print('\nRANDOM BASELINE expectation:')
print('  exact ≈ 0.25  in_set ≈ 0.50  color ≈ 0.50')
print('\nKEY INSIGHT: "in_set" is the realistic target. Exact is ~25% no matter what.\n')

# Save
with open('/home/user/webapp/analysis/strategy_results.json','w',encoding='utf-8') as f:
    json.dump(results, f, ensure_ascii=False, indent=2)
