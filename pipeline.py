#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""一键执行：采集公开代理 -> 提取 SOCKS5 -> 检测 CF 质量。"""

import argparse
import json
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent
SCRAPER_DIR = ROOT / "proxy-scraper"
ALL_PROXIES = SCRAPER_DIR / "output" / "all_proxies.json"
SOCKS5_FILE = ROOT / "generated_socks5.txt"
CHECKER = ROOT / "cf_quality_checker.py"


def run_command(command: list[str], cwd: Path) -> None:
    print(f"\n> {' '.join(command)}")
    result = subprocess.run(command, cwd=cwd)
    if result.returncode != 0:
        raise SystemExit(result.returncode)


def extract_socks5() -> int:
    if not ALL_PROXIES.exists():
        raise FileNotFoundError(f"未找到采集结果: {ALL_PROXIES}")

    data = json.loads(ALL_PROXIES.read_text(encoding="utf-8"))
    proxies = []
    seen = set()
    for item in data:
        protocol = str(item.get("protocol", "")).lower()
        ip = str(item.get("ip", "")).strip()
        port = item.get("port")
        if protocol not in ("socks5", "socks5h") or not ip or not port:
            continue
        value = f"socks5://{ip}:{int(port)}"
        if value not in seen:
            seen.add(value)
            proxies.append(value)

    SOCKS5_FILE.write_text("\n".join(proxies) + ("\n" if proxies else ""), encoding="utf-8")
    print(f"\n已提取 SOCKS5: {len(proxies)} 条")
    print(f"文件: {SOCKS5_FILE}")
    return len(proxies)


def main() -> None:
    parser = argparse.ArgumentParser(description="代理采集与 Cloudflare SOCKS5 质量检测一键流程")
    parser.add_argument("-u", "--url", required=True, help="有权测试的 Cloudflare 目标 URL")
    parser.add_argument("-n", "--attempts", type=int, default=10, help="每个代理请求次数")
    parser.add_argument("-c", "--concurrent", type=int, default=10, help="CF 检测并发数")
    parser.add_argument("-t", "--timeout", type=int, default=10, help="CF 单次请求超时秒数")
    parser.add_argument("--threshold", type=float, default=80, help="合格 CF 成功率百分比")
    parser.add_argument("--scrape-concurrency", type=int, default=100, help="采集器并发数")
    parser.add_argument("--scrape-timeout", type=int, default=1000, help="采集器验证超时毫秒数（仅保留参数兼容性）")
    parser.add_argument("--json-output", default=str(ROOT / "latest_results.json"), help="检测结果 JSON 输出路径")
    args = parser.parse_args()

    if not SCRAPER_DIR.exists():
        raise SystemExit(f"未找到 proxy-scraper 目录: {SCRAPER_DIR}")

    print("[1/3] 抓取公开代理，仅采集不做上游验证...")
    run_command(["npm", "run", "scrape"], SCRAPER_DIR)

    print("\n[2/3] 从 all_proxies.json 提取 SOCKS5...")
    count = extract_socks5()
    if count == 0:
        print("没有提取到 SOCKS5，流程结束")
        raise SystemExit(1)

    print("\n[3/3] 开始 CF 质量检测...")
    command = [
        sys.executable,
        str(CHECKER),
        "-f",
        str(SOCKS5_FILE),
        "-u",
        args.url,
        "-n",
        str(args.attempts),
        "-c",
        str(args.concurrent),
        "-t",
        str(args.timeout),
        "--threshold",
        str(args.threshold),
        "--json-output",
        args.json_output,
    ]
    run_command(command, ROOT)


if __name__ == "__main__":
    main()
