#!/usr/bin/env python3
"""Host-side scoring of lab outputs pulled from the phone (no model runs here).
usage: score.py laya|translate|ocr  <results/*.json> ...   (venv with sacrebleu: /tmp/opencode/venv)"""
import json, sys, os, re, collections, statistics as st
HERE = os.path.dirname(os.path.abspath(__file__))
SMS = {r["id"]: r for r in json.load(open(os.path.join(HERE, "data/laya-sms.json")))}
TR = {r["id"]: r for r in json.load(open(os.path.join(HERE, "data/translate.json")))}
RC = {r["id"]: r for r in json.load(open(os.path.join(HERE, "data/receipts-truth.json")))}

def lat(xs):
    xs = sorted(xs); n = len(xs)
    return dict(n=n, mean=round(sum(xs)/n, 1), p50=xs[n//2], p95=xs[min(n-1, int(.95*n))], max=xs[-1]) if n else {}

def laya(path):
    d = json.load(open(path))
    for m in d["models"]:
        print(f"\n=== {m['key']}  load {m.get('loadMs')} ms  single {m.get('latencySingle')}  1q {m.get('latencyOneQuestion')}")
        if "error" in m: print("ERROR", m["error"]); continue
        for b in m.get("batches", []): print(f"  batch {b['batchSize']}: total {b['totalMs']} ms  perItem {b['perItemMs']}")
        rows = m["items"]
        def get(r, q): return r["answers"][q]
        for q, key, truth in [("is_fin", "noul", "is_financial"), ("loan_due", "noul", "loan_due")]:
            ys = [(get(r, q)["noul"], SMS[r["id"]][truth]) for r in rows]
            acc = sum((p >= .5) == y for p, y in ys) / len(ys)
            print(f"[{q}] accuracy@0.5 {acc:.3f} n={len(ys)}")
            # precision of positive class / coverage at thresholds
            for t in (.5, .8, .9, .95, .98, .99, .995):
                pos = [(p, y) for p, y in ys if p >= t]; tp = sum(y for p, y in pos); P = sum(y for _, y in ys)
                neg = [(p, y) for p, y in ys if p <= 1 - t]; tn = sum(not y for p, y in neg)
                print(f"   t={t}: pos-precision {tp/len(pos):.3f} ({tp}/{len(pos)}) recall {tp/P:.3f} | neg-precision {tn/len(neg) if neg else float('nan'):.3f} ({tn}/{len(neg)}) | covered {(len(pos)+len(neg))/len(ys):.3f}")
        for q, truth in [("direction", "direction"), ("category", "category")]:
            ok = conf = 0; tot = len(rows); curve = []
            for r in rows:
                a = get(r, q); pr = a.get("probabilities", {}); top = max(pr.values()) if pr else a.get("answerConfidence", 0)
                hit = a["choice"] == SMS[r["id"]][truth]; ok += hit; curve.append((top, hit))
            print(f"[{q}] accuracy {ok/tot:.3f} n={tot}")
            for t in (.5, .7, .8, .9, .95, .99):
                sel = [h for c, h in curve if c >= t]
                print(f"   top-prob>={t}: precision {sum(sel)/len(sel) if sel else float('nan'):.3f} ({sum(sel)}/{len(sel)}) coverage {len(sel)/tot:.3f}")
        # per-group errors
        bad = collections.Counter()
        for r in rows:
            s = SMS[r["id"]]
            if (get(r, "is_fin")["noul"] >= .5) != s["is_financial"]: bad["is_fin:" + s["group"]] += 1
            if get(r, "direction")["choice"] != s["direction"]: bad["dir:" + s["group"]] += 1
            if get(r, "category")["choice"] != s["category"]: bad["cat:" + s["group"]] += 1
        print("  worst groups:", bad.most_common(12))
        # batch == single agreement
        for b in m.get("batches", []):
            bm = {x["id"]: x["answers"] for x in b["items"]}
            diff = sum(1 for r in rows if r["id"] in bm and abs(bm[r["id"]]["is_fin"]["noul"] - get(r, "is_fin")["noul"]) > 1e-3)
            print(f"  batch{b['batchSize']} vs single is_fin differs on {diff} items")
        # by language
        for lg in ("en", "sw", "sheng"):
            rr = [r for r in rows if SMS[r["id"]]["lang"] == lg]
            if rr: print(f"  lang {lg}: n={len(rr)} is_fin acc {sum((get(r,'is_fin')['noul']>=.5)==SMS[r['id']]['is_financial'] for r in rr)/len(rr):.3f} dir acc {sum(get(r,'direction')['choice']==SMS[r['id']]['direction'] for r in rr)/len(rr):.3f} cat acc {sum(get(r,'category')['choice']==SMS[r['id']]['category'] for r in rr)/len(rr):.3f}")

def layap(path):
    d = json.load(open(path))
    print("model", d["model"].get("key"), "load", d["model"].get("loadMs"))
    for v in d["variants"]:
        c = v["concept"]; rows = [r for r in v["rows"] if r.get("a")]
        mp = v.get("map") or {}
        n = len(rows); line = f"{v['variant']:6s} {c:9s} perItem {v['totalMs']/max(1,n):6.0f} ms  "
        if c in ("is_fin", "loan_due"):
            key = "is_financial" if c == "is_fin" else "loan_due"
            if v["variant"] == "fin6":
                sc = [(r["a"]["probabilities"].get("transaction", 0), SMS[r["id"]][key]) for r in rows]
            else:
                sc = [(r["a"]["noul"], SMS[r["id"]][key]) for r in rows]
            pos = [p for p, y in sc if y]; neg = [p for p, y in sc if not y]
            auc = sum((a > b) + .5 * (a == b) for a in pos for b in neg) / (len(pos) * len(neg))
            best = max(sum((p >= t) == y for p, y in sc) / n for t in [i / 100 for i in range(1, 100)])
            # precision@coverage: sort by score, take top-k positives while precision >= 0.99
            srt = sorted(sc, key=lambda x: -x[0]); tp = 0; cov99 = 0
            for i, (p_, y) in enumerate(srt, 1):
                tp += y
                if tp / i >= .99: cov99 = tp
            line += f"AUC {auc:.3f} acc@0.5 {sum((p>=.5)==y for p,y in sc)/n:.3f} bestAcc {best:.3f} recall@prec>=.99 {cov99/max(1,len(pos)):.2f}"
        else:
            truth = c
            ok = 0; curve = []
            for r in rows:
                pr = r["a"]["probabilities"]; lab = mp.get(r["a"]["choice"], r["a"]["choice"])
                hit = lab == SMS[r["id"]][truth]; ok += hit; curve.append((max(pr.values()), hit))
            def prec(t): sel = [h for cc, h in curve if cc >= t]; return (sum(sel) / len(sel) if sel else float("nan"), len(sel) / n)
            line += f"acc {ok/n:.3f} prec@.9 {prec(.9)[0]:.3f} (cov {prec(.9)[1]:.2f}) prec@.99 {prec(.99)[0]:.3f} (cov {prec(.99)[1]:.2f})"
        print(line)

def translate(path):
    import sacrebleu
    from sacrebleu.metrics import CHRF
    chrf = CHRF(word_order=2)  # chrF++
    d = json.load(open(path))
    for m in d["models"]:
        print(f"\n=== {m['key']} load {m.get('loadMs')} ms")
        if "error" in m: print("ERROR", m["error"]); continue
        by = collections.defaultdict(list)
        for r in m["rows"]: by[(r["variant"], r["dir"])].append(r)
        for (v, dr), rs in sorted(by.items()):
            ok = [r for r in rs if "error" not in r]
            if dr in ("en-sw", "sw-en"):
                hyp = [(r.get("released") if r.get("released") is not None else "") for r in ok] if v != "plain" else [r["out"] for r in ok]
                hyp_raw = [r["out"] for r in ok]
                refs = [TR[r["id"]]["ref"] for r in ok]
                c_raw = chrf.corpus_score(hyp_raw, [refs]).score
            else: c_raw = float("nan")
            strict = sum(r["preserve"]["strict"] for r in ok); dig = sum(r["preserve"]["digits"] for r in ok)
            rel = sum(r.get("released") is not None for r in ok)
            unsafe = sum(1 for r in ok if r.get("released") is not None and not r["preserve"]["strict"])
            gok = sum(r.get("guardOk", False) for r in ok) if v != "plain" else None
            tps = [r["tps"] for r in ok if r.get("tps")]; ms = [r["ms"] for r in ok]
            print(f"{v:6s} {dr:8s} n={len(ok):3d} chrF++ {c_raw:5.1f} | numeric strict {strict}/{len(ok)} digits {dig}/{len(ok)} | released {rel} unsafe-released {unsafe}" + (f" guardOk {gok}" if gok is not None else "") + f" | tok/s mean {st.mean(tps) if tps else 0:.1f} | ms {lat(ms)}")
        # failures listing for plain
        for r in m["rows"]:
            if r["variant"] == "plain" and "error" not in r and not r["preserve"]["strict"]:
                print("   NUM-LOSS", r["id"], r["preserve"]["missing"], "extra", r["preserve"]["extra"], "|", r["src"], "=>", r["out"])

def ocr(path):
    d = json.load(open(path)); rows = d["rows"]
    print("model", d["model"].get("loadMs"), "ms load", d["model"].get("error"))
    n = tot = mer = dat = 0; ms = []
    for r in rows:
        if "error" in r: print("ERR", r); continue
        t = RC[r["id"]]; p = r["parsed"]; n += 1; ms.append(r["ms"])
        a = p.get("total") == t["total"]; b = (p.get("merchant") or "").strip() == t["merchant"]; c = p.get("date") == t["date"]
        tot += a; mer += b; dat += c
        print(f"{r['id']} {r['ms']}ms total {'OK' if a else 'X'} {p.get('total')} vs {t['total']} | merchant {'OK' if b else 'X'} {p.get('merchant')!r} | date {'OK' if c else 'X'} {p.get('date')} vs {t['date']}")
    print(f"exact: total {tot}/{n} merchant {mer}/{n} date {dat}/{n}  latency {lat(ms)}")

if __name__ == "__main__":
    fn = {"laya": laya, "translate": translate, "ocr": ocr, "layap": layap}[sys.argv[1]]
    for p in sys.argv[2:]: print("#", p); fn(p)
