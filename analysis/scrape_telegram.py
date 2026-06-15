#!/usr/bin/env python3
"""
Récupère un grand échantillon de mains depuis les canaux Telegram publics.
Sortie: /home/user/webapp/analysis/hands_raw.json
"""
import re, json, time, sys
import urllib.request

CHANNELS = ['statistika_baccara', 'baccaratstat']
UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36'

def fetch(url):
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=15) as r:
        return r.read().decode('utf-8', errors='ignore')

MSG_RE = re.compile(
    r'data-post="([^"/]+)/(\d+)"[^>]*>.*?'
    r'<div class="tgme_widget_message_text js-message_text"[^>]*>(.*?)</div>',
    re.DOTALL
)
TAG_RE = re.compile(r'<[^>]+>')

def parse_page(html, channel):
    hands = {}
    # Iterate through wrappers individually for accuracy
    # Each message block starts with class="tgme_widget_message_wrap" etc.
    blocks = re.split(r'(?=class="tgme_widget_message[ "])', html)
    for b in blocks:
        m_post = re.search(r'data-post="([^"/]+)/(\d+)"', b)
        m_text = re.search(r'<div class="tgme_widget_message_text[^"]*"[^>]*>(.*?)</div>', b, re.DOTALL)
        if not (m_post and m_text):
            continue
        mid = int(m_post.group(2))
        raw = TAG_RE.sub('', m_text.group(1))
        raw = re.sub(r'\s+', ' ', raw).strip()
        # only keep hand-format messages
        if '#N' not in raw or '(' not in raw:
            continue
        gm = re.search(r'#N\s*(\d+)', raw)
        if not gm:
            continue
        hands[mid] = {'channel': channel, 'message_id': mid, 'raw': raw, 'gameNum': int(gm.group(1))}
    return hands

def scrape_channel(channel, target=1200):
    print(f'[{channel}] Starting scrape, target={target}')
    all_hands = {}
    before = None
    consecutive_empty = 0
    iterations = 0
    while len(all_hands) < target and iterations < 200:
        iterations += 1
        url = f'https://t.me/s/{channel}'
        if before:
            url += f'?before={before}'
        try:
            html = fetch(url)
        except Exception as e:
            print(f'[{channel}] err {e}, retry...')
            time.sleep(2)
            continue
        page = parse_page(html, channel)
        if not page:
            consecutive_empty += 1
            if consecutive_empty >= 3:
                print(f'[{channel}] stop (3 empty pages)')
                break
            time.sleep(1)
            continue
        consecutive_empty = 0
        new_count = 0
        min_mid = None
        for mid, h in page.items():
            if mid not in all_hands:
                all_hands[mid] = h
                new_count += 1
            if min_mid is None or mid < min_mid:
                min_mid = mid
        print(f'[{channel}] iter={iterations} got_new={new_count} total={len(all_hands)} before_next={min_mid}')
        if min_mid is None or (before is not None and min_mid >= before):
            print(f'[{channel}] no progress, stop')
            break
        before = min_mid
        time.sleep(0.4)
    return list(all_hands.values())

def main():
    all_results = []
    for ch in CHANNELS:
        try:
            hands = scrape_channel(ch, target=900 if ch == 'statistika_baccara' else 400)
            all_results.extend(hands)
            print(f'[{ch}] collected {len(hands)} hands')
        except Exception as e:
            print(f'[{ch}] FAIL: {e}')
    # Dedup by gameNum keeping the most recent message_id
    by_game = {}
    for h in all_results:
        g = h['gameNum']
        if g not in by_game or h['message_id'] > by_game[g]['message_id']:
            by_game[g] = h
    # Sort by gameNum ascending
    sorted_hands = sorted(by_game.values(), key=lambda x: x['gameNum'])
    out = '/home/user/webapp/analysis/hands_raw.json'
    with open(out, 'w', encoding='utf-8') as f:
        json.dump(sorted_hands, f, ensure_ascii=False, indent=1)
    print(f'\n=== DONE === wrote {len(sorted_hands)} unique hands to {out}')
    if sorted_hands:
        print(f'gameNum range: {sorted_hands[0]["gameNum"]} -> {sorted_hands[-1]["gameNum"]}')
        print('Sample first:', sorted_hands[0]['raw'][:120])
        print('Sample last :', sorted_hands[-1]['raw'][:120])

if __name__ == '__main__':
    main()
