#!/usr/bin/env python3
"""
Analyse empirique sur les mains réelles.
Sortie: /home/user/webapp/analysis/empirical_report.json
+ /home/user/webapp/analysis/hands_parsed.json (mains parsées propres)
"""
import json, re, math
from collections import Counter, defaultdict

SUITS = ['♠','♥','♦','♣']
RED = {'♥','♦'}
COLOR = lambda s: 'R' if s in RED else 'B'

CARD_RE = re.compile(r'(10|[2-9]|[AKQJ])\s*([♠♥♦♣])', re.IGNORECASE)
PAREN_RE = re.compile(r'\(([^)]+)\)')

def parse_hand(raw):
    text = re.sub(r'\u00ef\u00b8\u008f|️', '', raw)
    text = re.sub(r'\s+', ' ', text).strip()
    # game number
    m_num = re.search(r'#N\s*(\d+)', text)
    if not m_num:
        return None
    gnum = int(m_num.group(1))
    # find the two parentheses groups
    groups = PAREN_RE.findall(text)
    if len(groups) < 2:
        return None
    def cards(g):
        return [{'val':m.group(1).upper(),'suit':m.group(2)} for m in CARD_RE.finditer(g)]
    p1 = cards(groups[0])
    p2 = cards(groups[1])
    if not p1 or not p2:
        return None
    # scores before parens
    scores = [int(s) for s in re.findall(r'(\d+)\s*\(', text)]
    p1_score = scores[0] if len(scores) >= 1 else None
    p2_score = scores[1] if len(scores) >= 2 else None
    if p1_score is None or p2_score is None:
        return None
    if p1_score > p2_score: outcome = 'J'
    elif p2_score > p1_score: outcome = 'B'
    else: outcome = 'E'
    t_m = re.search(r'#T(\d+)', text)
    return {
        'gameNum': gnum,
        'p1': p1, 'p2': p2,
        'p1_score': p1_score, 'p2_score': p2_score,
        'p1_first': p1[0]['suit'], 'p2_first': p2[0]['suit'],
        'p1_suits': [c['suit'] for c in p1],
        'p2_suits': [c['suit'] for c in p2],
        'outcome': outcome,
        'has_retirage': '#R' in raw,
        'tValue': int(t_m.group(1)) if t_m else None,
        'raw': text,
    }

def main():
    with open('/home/user/webapp/analysis/hands_raw.json','r',encoding='utf-8') as f:
        raw_hands = json.load(f)
    parsed = []
    for h in raw_hands:
        p = parse_hand(h['raw'])
        if p:
            p['message_id'] = h['message_id']
            parsed.append(p)
    # Sort ascending by gameNum
    parsed.sort(key=lambda x: x['gameNum'])
    print(f'Parsed {len(parsed)}/{len(raw_hands)} hands successfully')

    with open('/home/user/webapp/analysis/hands_parsed.json','w',encoding='utf-8') as f:
        json.dump(parsed, f, ensure_ascii=False, indent=1)

    N = len(parsed)
    report = {
        'sample_size': N,
        'gameNum_range': [parsed[0]['gameNum'], parsed[-1]['gameNum']],
    }

    # 2a) Frequency of each suit on P1 first card & B first card
    p1_freq = Counter([h['p1_first'] for h in parsed])
    p2_freq = Counter([h['p2_first'] for h in parsed])
    report['p1_first_suit_freq'] = {s: round(p1_freq.get(s,0)/N, 4) for s in SUITS}
    report['p2_first_suit_freq'] = {s: round(p2_freq.get(s,0)/N, 4) for s in SUITS}

    # 2b) Correlation main(n)→main(n+1) for J and B
    # transitions[prev_suit][next_suit] = count
    def transitions(seq):
        trans = {s: Counter() for s in SUITS}
        for i in range(1, len(seq)):
            trans[seq[i-1]][seq[i]] += 1
        # normalize
        out = {}
        for prev in SUITS:
            tot = sum(trans[prev].values()) or 1
            out[prev] = {nxt: round(trans[prev].get(nxt,0)/tot, 4) for nxt in SUITS}
        return out
    p1_seq = [h['p1_first'] for h in parsed]
    p2_seq = [h['p2_first'] for h in parsed]
    report['markov_order1_p1'] = transitions(p1_seq)
    report['markov_order1_p2'] = transitions(p2_seq)

    # order-2 markov
    def transitions2(seq):
        trans = defaultdict(Counter)
        for i in range(2, len(seq)):
            key = seq[i-2] + seq[i-1]
            trans[key][seq[i]] += 1
        out = {}
        for k, c in trans.items():
            tot = sum(c.values()) or 1
            out[k] = {nxt: round(c.get(nxt,0)/tot,4) for nxt in SUITS}
        return out
    report['markov_order2_p1'] = transitions2(p1_seq)
    report['markov_order2_p2'] = transitions2(p2_seq)

    # 2c) Coverage: enseigne apparait dans P1 (toutes cartes), idem P2
    cov_p1 = {s: 0 for s in SUITS}
    cov_p2 = {s: 0 for s in SUITS}
    for h in parsed:
        s1 = set(h['p1_suits']); s2 = set(h['p2_suits'])
        for s in SUITS:
            if s in s1: cov_p1[s] += 1
            if s in s2: cov_p2[s] += 1
    report['coverage_in_p1_all_cards'] = {s: round(cov_p1[s]/N,4) for s in SUITS}
    report['coverage_in_p2_all_cards'] = {s: round(cov_p2[s]/N,4) for s in SUITS}

    # 2d) Coverage by color group
    cov_red_p1 = sum(1 for h in parsed if any(s in RED for s in h['p1_suits']))
    cov_blk_p1 = sum(1 for h in parsed if any(s not in RED for s in h['p1_suits']))
    cov_red_p2 = sum(1 for h in parsed if any(s in RED for s in h['p2_suits']))
    cov_blk_p2 = sum(1 for h in parsed if any(s not in RED for s in h['p2_suits']))
    report['coverage_color_p1'] = {'rouge': round(cov_red_p1/N,4), 'noir': round(cov_blk_p1/N,4)}
    report['coverage_color_p2'] = {'rouge': round(cov_red_p2/N,4), 'noir': round(cov_blk_p2/N,4)}

    # 2e) Momentum / streak distribution
    def streak_distrib(seq):
        # max repeating same suit
        max_streak = {s:0 for s in SUITS}
        run = 1
        for i in range(1,len(seq)):
            if seq[i]==seq[i-1]:
                run+=1
                if run>max_streak[seq[i]]: max_streak[seq[i]] = run
            else:
                run = 1
        # avg streak
        runs = []
        i=0
        while i<len(seq):
            j=i
            while j+1<len(seq) and seq[j+1]==seq[i]: j+=1
            runs.append(j-i+1)
            i=j+1
        return {
            'max_streak_per_suit': max_streak,
            'avg_streak': round(sum(runs)/len(runs),3) if runs else 0,
            'runs_gte_3': sum(1 for r in runs if r>=3),
        }
    report['streaks_p1'] = streak_distrib(p1_seq)
    report['streaks_p2'] = streak_distrib(p2_seq)

    # 2f) Autocorrelation P1 with lag 1..8
    def autocorr(seq, max_lag=8):
        out = {}
        for lag in range(1, max_lag+1):
            same = sum(1 for i in range(lag, len(seq)) if seq[i]==seq[i-lag])
            total = len(seq) - lag
            out[lag] = round(same/total, 4) if total>0 else 0
        return out
    report['autocorr_p1'] = autocorr(p1_seq)
    report['autocorr_p2'] = autocorr(p2_seq)
    # Random expectation: 0.25

    # 2g) After a loss, what wins more often?
    # We simulate a simple predictor that always plays the dominant suit of the last 5 hands.
    # For each hand, given previous loss (predicted suit != actual), check various strategies for next:
    #   strategy A: repeat same suit
    #   strategy B: switch to enemy (same color)
    #   strategy C: switch to other color
    #   strategy D: pick most frequent of last 5
    ENEMY = {'♠':'♣','♣':'♠','♥':'♦','♦':'♥'}
    OTHER_COLOR = {'♠':'♥','♣':'♦','♥':'♠','♦':'♣'}  # cross-color
    # Test on P1 side
    def loss_recovery(seq):
        win = {'repeat':0,'enemy':0,'cross':0,'top5':0}
        tot = 0
        for i in range(5, len(seq)-1):
            # assume "we played seq[i-1]" (random reference) and lost (actual seq[i] != seq[i-1])
            prev = seq[i-1]
            actual = seq[i]
            if actual == prev: continue  # not a loss
            nxt = seq[i+1] if i+1<len(seq) else None
            if nxt is None: continue
            tot += 1
            # strategies
            top5 = Counter(seq[i-4:i+1]).most_common(1)[0][0]
            if nxt == prev: win['repeat'] += 1
            if nxt == ENEMY[prev]: win['enemy'] += 1
            if nxt == OTHER_COLOR[prev]: win['cross'] += 1
            if nxt == top5: win['top5'] += 1
        return {k: round(v/tot,4) if tot else 0 for k,v in win.items()}, tot
    rec1, n1 = loss_recovery(p1_seq)
    rec2, n2 = loss_recovery(p2_seq)
    report['loss_recovery_p1'] = {'strategies':rec1, 'sample':n1}
    report['loss_recovery_p2'] = {'strategies':rec2, 'sample':n2}

    # 2h) outcome distribution
    out_c = Counter([h['outcome'] for h in parsed])
    report['outcome_distribution'] = {k: round(out_c.get(k,0)/N,4) for k in ['J','B','E']}

    # 2i) Card length stats
    p1_lens = Counter([len(h['p1']) for h in parsed])
    p2_lens = Counter([len(h['p2']) for h in parsed])
    report['p1_length_dist'] = {str(k): round(v/N,4) for k,v in p1_lens.items()}
    report['p2_length_dist'] = {str(k): round(v/N,4) for k,v in p2_lens.items()}

    # 2j) Window momentum: most common suit of last K, how often does it appear in P1[0] next?
    def window_accuracy(seq, K):
        hits = 0; tot = 0
        for i in range(K, len(seq)):
            window = seq[i-K:i]
            top = Counter(window).most_common(1)[0][0]
            if seq[i] == top: hits += 1
            tot += 1
        return round(hits/tot,4) if tot else 0
    report['window_top_predicts_next_p1'] = {str(K): window_accuracy(p1_seq, K) for K in [3,5,7,10,15,20]}
    report['window_top_predicts_next_p2'] = {str(K): window_accuracy(p2_seq, K) for K in [3,5,7,10,15,20]}

    # 2k) Combined cross prediction: does the J first-suit correlate with B first-suit same hand?
    same_cnt = sum(1 for h in parsed if h['p1_first'] == h['p2_first'])
    same_color = sum(1 for h in parsed if COLOR(h['p1_first']) == COLOR(h['p2_first']))
    report['p1_p2_same_suit'] = round(same_cnt/N,4)
    report['p1_p2_same_color'] = round(same_color/N,4)

    # Save
    with open('/home/user/webapp/analysis/empirical_report.json','w',encoding='utf-8') as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print('\n=== EMPIRICAL REPORT ===')
    print(json.dumps({k:v for k,v in report.items() if not isinstance(v, dict) or len(str(v))<400}, ensure_ascii=False, indent=2))
    # print key headlines
    print('\n--- Headlines ---')
    print('P1 first-suit freq:', report['p1_first_suit_freq'])
    print('P2 first-suit freq:', report['p2_first_suit_freq'])
    print('Coverage in P1 (any card):', report['coverage_in_p1_all_cards'])
    print('Coverage in P2 (any card):', report['coverage_in_p2_all_cards'])
    print('Color coverage:', report['coverage_color_p1'], report['coverage_color_p2'])
    print('Autocorr P1:', report['autocorr_p1'])
    print('Window top predicts next P1:', report['window_top_predicts_next_p1'])
    print('Window top predicts next P2:', report['window_top_predicts_next_p2'])
    print('Loss recovery P1:', report['loss_recovery_p1'])
    print('Loss recovery P2:', report['loss_recovery_p2'])
    print('P1==P2 same suit:', report['p1_p2_same_suit'], ' same color:', report['p1_p2_same_color'])
    print('Outcome:', report['outcome_distribution'])
    print('p1 lengths:', report['p1_length_dist'])

if __name__=='__main__':
    main()
