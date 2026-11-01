#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build-pity-pool.py
==================
把「率土之滨各阵营大小保底共识」接成模拟器可用的机读配将卡池。

权威数据源（区分英雄的唯一键 = 阵营 + 英雄 + 星级）：
  1) 桌面 xlsx  《率土之滨_五星武将_重制.xlsx》
     - 每行 = 武将名 + 星级 + 阵营 + 武将ID，多阵营武将分两行存（如 吕布 汉 / 吕布 群）。
     - 这是「哪些武将是五星、属哪个阵营」的权威枚举。
  2) hero.json（引擎武将库）
     - 提供模拟器真正可用的 hero_id、属性、SP/赛季变体。
     - 注意：xlsx 的「武将ID」与 hero.json 的 hero_id 并非 100% 对齐
       （已发现 许褚 xlsx=100840 / 引擎=100473；刘秀 引擎无收录），
       因此引擎 id 一律以 hero.json 按 (name, country, quality=5) 解析为准，
       xlsx 的 id 仅作参考记录。
  3) docs/率土保底卡池.md（多源共识）
     - 提供 大保底 / 小保底 的价值分层（含置信度标签）。

输出：
  docs/配将卡池.json  —— 机读配将卡池（按 阵营+英雄+星级 解析到 hero_id）。
"""

import json
import os
import re
from collections import defaultdict, Counter

import openpyxl

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
XLSX_PATH = r"C:\Users\520\Desktop\率土之滨_五星武将_重制.xlsx"
HERO_JSON = os.path.join(ROOT, "hero.json")
CONSENSUS_MD = os.path.join(ROOT, "docs", "率土保底卡池.md")
OUT_PATH = os.path.join(ROOT, "docs", "配将卡池.json")

FACTION_TO_CODE = {"汉": 1, "魏": 2, "蜀": 3, "吴": 4, "群": 5, "晋": 6}
CODE_TO_FACTION = {v: k for k, v in FACTION_TO_CODE.items()}
FACTION_CHARS = set(FACTION_TO_CODE.keys())

# 显示名 -> xlsx 真实存储名的别名归一
NAME_ALIAS = {
    "大小乔": "小乔＆大乔",
    "关兴&张苞": "关兴＆张苞",
    "关兴张苞": "关兴＆张苞",
    "关兴＆张苞": "关兴＆张苞",
}


def norm_name(n: str) -> str:
    """去空格、全角＆/& 归一，便于匹配。"""
    n = n.strip()
    n = n.replace("＆", "&").replace(" ", "")
    return n


# ---------------------------------------------------------------------------
# 1) 读取 xlsx 权威五星注册表
# ---------------------------------------------------------------------------
def load_xlsx_registry():
    wb = openpyxl.load_workbook(XLSX_PATH, data_only=True)
    ws = wb["五星武将"]
    rows = list(ws.iter_rows(values_only=True))
    header = rows[0]
    recs = []
    for r in rows[1:]:
        if r[0] is None:
            continue
        d = dict(zip(header, r))
        name = str(d["武将名"]).strip()
        faction = str(d["阵营"]).strip()
        star = int(str(d["星级"]).replace("星", "").strip())
        xlsx_id = str(d["武将ID"]).strip()
        recs.append({
            "name": name,
            "faction": faction,
            "star": star,
            "xlsx_id": xlsx_id,
        })
    return recs


# ---------------------------------------------------------------------------
# 2) 读取 hero.json，建立 (name, country, quality) -> [hero_id]
# ---------------------------------------------------------------------------
def load_hero_json():
    with open(HERO_JSON, encoding="utf-8") as f:
        heroes = json.load(f)
    by_key = defaultdict(list)
    by_id = {}
    for h in heroes:
        key = (str(h["name"]), int(h["country"]), int(h["quality"]))
        by_key[key].append(h)
        by_id[str(h["hero_id"])] = h
    return by_key, by_id


def resolve_engine_ids(name, faction, star=5):
    """按 (name, 阵营, 星级=5) 解析 hero.json 中的可用 hero_id 列表。"""
    code = FACTION_TO_CODE.get(faction)
    if code is None:
        return []
    return by_key_global.get((name, code, star), [])


def pick_primary(matches):
    """优先选 非赛季、非SP 的基卡；否则取第一个。"""
    normal = [m for m in matches if m.get("is_season_card") == 0 and m.get("is_sp_card") == 0]
    pool = normal if normal else matches
    return pool[0]


# ---------------------------------------------------------------------------
# 3) 解析共识 markdown 的分级（大保底/小保底 + 置信度 + 阵营消歧）
# ---------------------------------------------------------------------------
def strip_faction_token(name):
    """剥离显式阵营 token，返回 (clean_name, forced_faction_or_None)。"""
    # 后缀 (X)
    m = re.search(r"\(([" + "".join(FACTION_CHARS) + r"])\)\s*$", name)
    if m:
        forced = m.group(1)
        return name[:m.start()].strip(), forced
    # 前缀 X（仅当剥离后仍是已知英雄时才生效，由调用方决定是否采用）
    if name and name[0] in FACTION_CHARS:
        return name[1:].strip(), name[0]
    return name, None


def parse_consensus_tiers():
    """返回 {faction: {'da': [(name, conf)], 'xiao': [(name, conf)]}}"""
    text = open(CONSENSUS_MD, encoding="utf-8").read()
    result = defaultdict(lambda: {"da": [], "xiao": []})
    cur_faction = None
    cur_tier = None  # 'da' or 'xiao'
    for line in text.splitlines():
        # 阵营标题 ### 魏 / 蜀 / 吴 / 汉 / 群 / 晋
        m = re.match(r"^###\s*([汉魏蜀吴群晋])\b", line)
        if m:
            cur_faction = m.group(1)
            cur_tier = None
            continue
        if cur_faction is None:
            continue
        # 大保底 / 小保底 行（可能带 共识·高 / 补充·单源 / 存疑）
        m = re.match(r"^-\s*(大保底|小保底)", line)
        if m:
            tier_label = m.group(1)
            cur_tier = "da" if tier_label == "大保底" else "xiao"
            conf = "consensus"
            if "单源" in line:
                conf = "single-source"
            if "存疑" in line:
                conf = "unverified"
            # 提取冒号后的名字
            body = line.split("：", 1)[-1] if "：" in line else ""
            body = re.sub(r"【.*?】", "", body)  # 去【共识·高】等
            names = [x.strip("、，, ") for x in re.split(r"[、，,]", body) if x.strip("、，, ")]
            for nm in names:
                nm = nm.strip()
                if not nm:
                    continue
                # 剥离 补充/存疑 行里的引导词
                nm = re.sub(r"^(补充·单源|存疑)（.*?）[:：]?", "", nm).strip()
                result[cur_faction][cur_tier].append((nm, conf))
            continue
        # 补充·单源 子项（沿用当前 tier，真实名字列表）
        m2 = re.match(r"^\s*-\s*补充·单源", line)
        if m2 and cur_tier:
            conf = "single-source"
            body = line.split("：", 1)[-1] if "：" in line else ""
            body = re.sub(r"（.*?）", "", body)  # 去括号备注
            names = [x.strip("、，, ") for x in re.split(r"[、，,]", body) if x.strip("、，, ")]
            for nm in names:
                if not nm:
                    continue
                result[cur_faction][cur_tier].append((nm, conf))
            continue
        # 存疑 子项：纯备注（引用的英雄已在主列表），不提取名字
        m3 = re.match(r"^\s*-\s*存疑", line)
        if m3:
            continue
    return result


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------
by_key_global = {}
by_id_global = {}


def main():
    global by_key_global, by_id_global
    xlsx_recs = load_xlsx_registry()
    by_key_global, by_id_global = load_hero_json()
    consensus = parse_consensus_tiers()

    # 把共识 (name, faction) 建立查找表，含消歧
    # cons_lookup[(norm_name, faction)] = (tier, conf)
    cons_lookup = {}
    cons_all_names = []  # 记录所有共识名（用于未匹配报告）
    for fac, tiers in consensus.items():
        for tier_key, items in tiers.items():
            for raw_name, conf in items:
                nm = raw_name
                forced = None
                # 处理 XP 前缀
                nm2 = re.sub(r"^XP", "", nm)
                if nm2 != nm:
                    nm = nm2
                # 处理 阵营 token
                clean, f = strip_faction_token(nm)
                if f is not None:
                    forced = f
                    nm = clean
                target_fac = forced if forced else fac
                nm = NAME_ALIAS.get(nm, nm)
                nm = norm_name(nm)
                cons_lookup[(nm, target_fac)] = (tier_key, conf)
                cons_all_names.append((raw_name, fac, target_fac, nm))

    pool = []
    matched_consensus = set()
    faction_hero_ids = defaultdict(list)
    stats = Counter()

    # ① 以 xlsx 为权威枚举，按 (name, faction, star) 去重合并（SP/赛季变体同键）
    seen_keys = set()
    # 先建 xlsx 的 (name,faction,star) -> xlsx_ids 映射
    xlsx_group = defaultdict(list)
    for rec in xlsx_recs:
        key = (rec["name"], rec["faction"], rec["star"])
        xlsx_group[key].append(rec["xlsx_id"])

    for (name, faction, star), xlsx_ids in xlsx_group.items():
        tier_conf = None
        lookup_nm = norm_name(NAME_ALIAS.get(name, name))
        if (lookup_nm, faction) in cons_lookup:
            tier_conf = cons_lookup[(lookup_nm, faction)]
            matched_consensus.add((lookup_nm, faction))
        else:
            clean, f = strip_faction_token(name)
            if f and (norm_name(clean), f) in cons_lookup:
                tier_conf = cons_lookup[(norm_name(clean), f)]
                matched_consensus.add((norm_name(clean), f))

        matches = resolve_engine_ids(name, faction, star)
        engine_ids = [str(m["hero_id"]) for m in matches]
        engine_available = len(engine_ids) > 0
        primary_id = str(pick_primary(matches)["hero_id"]) if engine_available else None

        tier = tier_conf[0] if tier_conf else "未分级"
        conf = tier_conf[1] if tier_conf else None
        tier_label = {"da": "大保底", "xiao": "小保底", "未分级": "未分级"}[tier]

        rec_out = {
            "name": name,
            "faction": faction,
            "star": star,
            "tier": tier_label,
            "engineAvailable": engine_available,
            "heroId": primary_id,
            "heroIds": engine_ids,
            "xlsxIds": xlsx_ids,
            "sp": any(m.get("is_sp_card") == 1 for m in matches) if engine_available else False,
            "season": any(m.get("is_season_card") == 1 for m in matches) if engine_available else False,
            "source": "xlsx+hero.json",
        }
        if conf:
            rec_out["confidence"] = conf
        pool.append(rec_out)
        seen_keys.add((name, faction, star))
        stats[(faction, tier_label)] += 1
        if engine_available:
            faction_hero_ids[faction].append(primary_id)

    # ② 共识列级但 xlsx 未收录 -> 从 hero.json 反查补录（5星）
    unresolved = []
    for raw_name, fac, target_fac, nm in cons_all_names:
        if (nm, target_fac) in matched_consensus:
            continue
        matches = resolve_engine_ids(nm, target_fac, 5)
        if not matches:
            unresolved.append({"raw": raw_name, "faction": target_fac, "reason": "hero.json 与 xlsx 均无此五星（共识可能误记，如步诸葛）"})
            continue
        engine_ids = [str(m["hero_id"]) for m in matches]
        primary_id = str(pick_primary(matches)["hero_id"])
        tier_conf = cons_lookup[(nm, target_fac)]
        tier_label = {"da": "大保底", "xiao": "小保底"}[tier_conf[0]]
        rec_out = {
            "name": nm,
            "faction": target_fac,
            "star": 5,
            "tier": tier_label,
            "engineAvailable": True,
            "heroId": primary_id,
            "heroIds": engine_ids,
            "xlsxIds": [],
            "sp": any(m.get("is_sp_card") == 1 for m in matches),
            "season": any(m.get("is_season_card") == 1 for m in matches),
            "source": "consensus-extra (xlsx未收录，hero.json补全)",
            "confidence": tier_conf[1],
        }
        pool.append(rec_out)
        seen_keys.add((nm, target_fac, 5))
        stats[(target_fac, tier_label)] += 1
        faction_hero_ids[target_fac].append(primary_id)
        matched_consensus.add((nm, target_fac))

    # 未匹配共识名（补录后仍无法解析）
    still_unmatched = []
    for raw_name, fac, target_fac, nm in cons_all_names:
        if (nm, target_fac) not in matched_consensus:
            still_unmatched.append({"raw": raw_name, "resolvedFaction": target_fac})

    engine_missing = [r for r in pool if not r["engineAvailable"]]

    # 写报告
    print("=== 配将卡池构建报告 ===")
    print(f"xlsx 五星注册表(去重前): {len(xlsx_recs)}  ->  去重后唯一 (name,阵营,星级): {len(xlsx_group)}")
    print(f"配将卡池总条目: {len(pool)}  |  引擎可用: {sum(1 for r in pool if r['engineAvailable'])}")
    print(f"引擎缺失（xlsx 有但 hero.json 无）: {len(engine_missing)} -> {[r['name']+'('+r['faction']+')' for r in engine_missing]}")
    print("\n-- 按 (阵营, 分级) 统计 --")
    tot_da = tot_xi = tot_un = 0
    for fac in ["汉", "魏", "蜀", "吴", "群", "晋"]:
        da = stats[(fac, "大保底")]; xi = stats[(fac, "小保底")]; un = stats[(fac, "未分级")]
        tot_da += da; tot_xi += xi; tot_un += un
        print(f"  {fac}: 大保底={da} 小保底={xi} 未分级={un}  合计={da+xi+un}")
    print(f"  合计: 大保底={tot_da} 小保底={tot_xi} 未分级={tot_un}")
    print(f"\n共识列级但 xlsx 未收录（已从 hero.json 补录）: {len(pool)-len(xlsx_group)} 条")
    print(f"仍无法解析（未解决）: {len(still_unmatched)}")
    for u in still_unmatched:
        print(f"   - {u['raw']} (解析阵营 {u['resolvedFaction']})")
    print(f"\n未分级明细（xlsx 五星但共识未列级，仍可作素材）:")
    ungraded = [r for r in pool if r["tier"] == "未分级"]
    print("   ", "、".join(f"{r['name']}({r['faction']})" for r in ungraded))

    # 输出 JSON
    out = {
        "meta": {
            "description": "率土之滨 配将卡池（阵营名将卡包口径）。唯一键 = 阵营 + 英雄 + 星级，解析到引擎 hero_id；同键多变体(基卡/SP/赛季)合并于 heroIds。",
            "sources": {
                "registry": "率土之滨_五星武将_重制.xlsx（桌面，权威五星枚举+阵营区分，多阵营分多行）",
                "engine": "hero.json（模拟器武将库，提供 hero_id/属性/变体）",
                "tier": "docs/率土保底卡池.md（多源共识的大/小保底分层）",
            },
            "tierMeaning": {
                "大保底": "半价/核心五星（价值高，优先围绕建队）",
                "小保底": "免费/素材五星（价值偏低，多拆战法/拼图）",
                "未分级": "xlsx 五星但共识名单未列级（仍可作配将素材）",
            },
            "keyNote": "英雄可跨阵营，唯一判别 = (阵营, 英雄, 星级)；如 吕布=汉/群、关羽=蜀/魏、司马懿=魏/晋，各自独立成条。",
            "starNote": "本池仅含 5 星（保底产出口径）。",
            "engineMissingNote": "hero.json 快照未收录的武将标记 engineAvailable=false（如 刘秀）。",
            "totalHeroes": len(pool),
            "engineAvailable": sum(1 for r in pool if r["engineAvailable"]),
        },
        "factions": {fac: faction_hero_ids.get(fac, []) for fac in ["汉", "魏", "蜀", "吴", "群", "晋"]},
        "unresolved": still_unmatched,
        "pool": pool,
    }
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print(f"\n已写出: {OUT_PATH}")


if __name__ == "__main__":
    main()
